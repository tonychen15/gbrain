/**
 * `gbrain search/query --html` orchestration (the I/O half).
 *
 * Enriches SearchResult[] with each page's ABSOLUTE source-file path (one
 * batched DB query, resolving relative source_path values against the source's
 * local_path or sync.repo_path), computes a best-effort line number for the
 * snippet, renders the page via the pure `html-formatter.ts`, writes it to
 * ~/.gbrain/last-query.html, and opens it in the user's default browser.
 *
 * Everything here is best-effort: a failed lookup, an unresolvable relative
 * path, a missing file, or an unavailable browser-opener degrades gracefully
 * and never throws out of `handleQueryHtml` (the search command must succeed).
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import type { BrainEngine } from '../engine.ts';
import type { SearchResult } from '../types.ts';
import { gbrainPath } from '../config.ts';
import { renderQueryHtml, fileUrl, type HtmlResultRow } from './html-formatter.ts';

/** Files larger than this are not read for line-number lookup (avoid slow reads). */
const MAX_LINE_LOOKUP_BYTES = 2_000_000;

/**
 * Resolve a stored source_path to an absolute path suitable for a file:// URL.
 *   - already absolute        → returned as-is
 *   - relative + baseDir set  → join(baseDir, rawPath) (baseDir ~ expanded)
 *   - relative + no baseDir   → null (caller omits the link rather than emit a
 *                               broken relative file:// URL)
 *   - null/empty rawPath      → null
 * Pure (no fs / engine) so it's unit-testable.
 */
export function resolveAbsoluteSourcePath(
  rawPath: string | null | undefined,
  baseDir: string | null | undefined,
): string | null {
  if (!rawPath) return null;
  if (isAbsolute(rawPath)) return rawPath;
  if (!baseDir) return null;
  return join(expandTilde(baseDir), rawPath);
}

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Render the HTML page for a query/search result set, write it to disk, and
 * open it in the browser. `engine` may be null (thin-client path) — in that
 * case source paths are unavailable and cards fall back to the slug.
 *
 * Returns the written file path (also printed to stderr). Never throws.
 */
export async function handleQueryHtml(
  engine: BrainEngine | null,
  query: string,
  results: SearchResult[],
): Promise<string> {
  const sourcePathById = await resolveSourcePaths(engine, results);

  // Cache file reads across results that share a source file.
  const fileCache = new Map<string, string | null>();
  const rows: HtmlResultRow[] = results.map((result) => {
    const sourcePath = sourcePathById.get(result.page_id) ?? null;
    const approxLine = sourcePath
      ? bestEffortLine(sourcePath, result.chunk_text, fileCache)
      : null;
    return { result, sourcePath, approxLine };
  });

  const html = renderQueryHtml({ query, rows });
  const outPath = gbrainPath('last-query.html');

  try {
    // gbrainPath() does not auto-mkdir; ensure the parent exists so a missing
    // ~/.gbrain (fresh env, custom GBRAIN_HOME) doesn't silently fall back to text.
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, html, 'utf8');
  } catch (e) {
    process.stderr.write(
      `[gbrain] could not write HTML output (${(e as Error).message}); falling back to text.\n`,
    );
    // Fall back to a minimal text dump so the user still sees results.
    process.stdout.write(
      results
        .map((r) => `[${r.score?.toFixed(4) ?? '?'}] ${r.slug} -- ${(r.chunk_text ?? '').slice(0, 100)}`)
        .join('\n') + '\n',
    );
    return outPath;
  }

  const opened = openInBrowser(outPath);
  process.stderr.write(
    `[gbrain] ${results.length} result(s) → ${outPath}` +
      (opened ? ' (opened in browser)' : ` (open it: ${fileUrl(outPath)})`) +
      '\n',
  );
  return outPath;
}

/**
 * Batched `page_id → absolute source path` resolver. Reads each page's
 * source_path + source_id, then resolves relative paths against the source's
 * local_path (preferred) or the `sync.repo_path` config. Returns an empty map
 * when engine is null or the page query fails (cards fall back to the slug).
 */
async function resolveSourcePaths(
  engine: BrainEngine | null,
  results: SearchResult[],
): Promise<Map<number, string | null>> {
  const map = new Map<number, string | null>();
  if (!engine) return map;

  const ids = [...new Set(results.map((r) => r.page_id).filter((id) => Number.isFinite(id)))];
  if (ids.length === 0) return map;

  let pageRows: Array<{ id: number | string; source_path: string | null; source_id: string | null }>;
  try {
    pageRows = await engine.executeRaw(
      `SELECT id, source_path, source_id FROM pages WHERE id = ANY($1::int[])`,
      [ids],
    );
  } catch {
    return map; // pre-v0.18 brains or transient error → no source links
  }

  // Per-source base dirs (local_path) + the global sync.repo_path fallback.
  const localPathBySource = new Map<string, string>();
  try {
    const srcs = await engine.executeRaw<{ id: string; local_path: string | null }>(
      `SELECT id, local_path FROM sources WHERE local_path IS NOT NULL`,
      [],
    );
    for (const s of srcs) {
      if (s.local_path) localPathBySource.set(String(s.id), String(s.local_path));
    }
  } catch {
    /* sources table shape varies on old brains — fall through to config repo_path */
  }

  let configRepoPath: string | null = null;
  try {
    const v = await engine.getConfig('sync.repo_path');
    configRepoPath = typeof v === 'string' && v.length > 0 ? v : null;
  } catch {
    /* getConfig unavailable → no fallback base */
  }

  for (const row of pageRows) {
    const baseDir =
      (row.source_id && localPathBySource.get(String(row.source_id))) || configRepoPath;
    map.set(Number(row.id), resolveAbsoluteSourcePath(row.source_path, baseDir));
  }
  return map;
}

/**
 * Best-effort 1-based line number of `chunkText` within the source file.
 * Returns null when the file is missing, too large, unreadable, or the snippet
 * isn't found verbatim (compiled_truth chunks can differ from the raw source,
 * so a miss is expected and silently omitted rather than shown wrong).
 */
export function bestEffortLine(
  sourcePath: string,
  chunkText: string,
  cache?: Map<string, string | null>,
): number | null {
  try {
    let content = cache?.get(sourcePath);
    if (content === undefined) {
      if (!existsSync(sourcePath)) {
        cache?.set(sourcePath, null);
        return null;
      }
      const st = statSync(sourcePath);
      if (st.size > MAX_LINE_LOOKUP_BYTES) {
        cache?.set(sourcePath, null);
        return null;
      }
      content = readFileSync(sourcePath, 'utf8');
      cache?.set(sourcePath, content);
    }
    if (content === null) return null;

    const needle = (chunkText ?? '').trim().slice(0, 60);
    if (!needle) return null;
    const idx = content.indexOf(needle);
    if (idx < 0) return null;

    let line = 1;
    for (let i = 0; i < idx; i++) {
      if (content.charCodeAt(i) === 10 /* \n */) line++;
    }
    return line;
  } catch {
    return null;
  }
}

/**
 * Open `filePath` in the user's default browser. Returns true if the opener was
 * spawned, false if skipped (GBRAIN_NO_BROWSER) or unavailable. Detached + unref
 * so it never blocks; errors are swallowed so a missing opener can't crash the
 * command (the stderr note still tells the user the file path).
 */
function openInBrowser(filePath: string): boolean {
  if (process.env.GBRAIN_NO_BROWSER === '1') return false;
  try {
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', filePath] : [filePath];
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      /* opener missing (headless box / stripped container) — ignore */
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

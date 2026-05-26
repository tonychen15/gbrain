/**
 * `gbrain search/query --html` — pure HTML renderer for search results.
 *
 * Sibling of `explain-formatter.ts`. Renders a SearchResult[] (enriched with
 * each result's source-file path + an optional approximate line number) as a
 * self-contained HTML page: one card per result showing the relevance score,
 * a link to the source markdown file, the chunk index + section, and the
 * matched snippet. UTF-8 / CJK-safe; all dynamic content is HTML-escaped.
 *
 * This module is PURE (no fs / no engine / no process). The orchestration that
 * looks up source paths, writes the file, and opens the browser lives in
 * `html-output.ts` so this renderer stays trivially unit-testable.
 */

import type { SearchResult } from '../types.ts';

/** Escape the five HTML-significant characters. Applied to every dynamic value. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build a `file://` URL from an absolute path, percent-encoding each segment
 * so spaces and non-ASCII (CJK) filenames produce a valid, clickable URL.
 * Path separators are preserved.
 */
export function fileUrl(absPath: string): string {
  const segments = absPath.split('/').map((seg) => (seg === '' ? '' : encodeURIComponent(seg)));
  return 'file://' + segments.join('/');
}

/** One result plus the source metadata resolved by the orchestration layer. */
export interface HtmlResultRow {
  result: SearchResult;
  /** Absolute path to the source markdown file, or null if unavailable. */
  sourcePath: string | null;
  /** Best-effort 1-based line of the snippet in the source file, or null. */
  approxLine: number | null;
}

export interface RenderQueryHtmlInput {
  query: string;
  rows: HtmlResultRow[];
  generatedAt?: Date;
}

/**
 * Render the full HTML document. Returns a complete, self-contained page
 * (inline CSS, no external assets). Safe to write to disk and open directly.
 */
export function renderQueryHtml(input: RenderQueryHtmlInput): string {
  const { query, rows } = input;
  const when = (input.generatedAt ?? new Date()).toISOString();
  const q = escapeHtml(query);

  const body =
    rows.length === 0
      ? `<p class="empty">No results.</p>`
      : rows.map((row, i) => renderCard(row, i + 1)).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gbrain · ${q}</title>
<style>${STYLE}</style>
</head>
<body>
<header class="page-header">
  <div class="kicker">gbrain query</div>
  <h1>${q || '(no query text)'}</h1>
  <div class="sub">${rows.length} result${rows.length === 1 ? '' : 's'} · ${escapeHtml(when)}</div>
</header>
<main>
${body}
</main>
</body>
</html>
`;
}

function renderCard(row: HtmlResultRow, rank: number): string {
  const r = row.result;
  const score = escapeHtml(fmtScore(r.score));
  const slug = escapeHtml(r.slug ?? '');
  const chunkIdx = Number.isFinite(r.chunk_index) ? r.chunk_index : '?';
  const section = escapeHtml(r.chunk_source ?? '');
  const snippet = renderSnippet(r.chunk_text ?? '');
  const stale = r.stale ? `<span class="badge stale">stale</span>` : '';

  // Source line: prefer the file basename; fall back to the slug when no
  // source path is available (e.g. thin-client results without a DB lookup).
  const metaParts: string[] = [];
  if (row.sourcePath) {
    metaParts.push(`<span class="file">${escapeHtml(basename(row.sourcePath))}</span>`);
  } else {
    metaParts.push(`<span class="file">${slug}</span>`);
  }
  metaParts.push(`chunk ${chunkIdx}`);
  if (section) metaParts.push(section);
  if (row.approxLine !== null) metaParts.push(`~line ${row.approxLine}`);

  const openLink = row.sourcePath
    ? `<a class="open" href="${escapeHtml(fileUrl(row.sourcePath))}">open source file →</a>`
    : '';

  return `<article class="card">
  <div class="card-head">
    <span class="rank">${rank}</span>
    <span class="score" title="relevance score">${score}</span>
    <span class="slug">${slug}</span>
    ${stale}
  </div>
  <div class="meta">📄 ${metaParts.join(' · ')}</div>
  <blockquote class="snippet">${snippet}</blockquote>
  ${openLink}
</article>`;
}

/**
 * Render a matched chunk (raw markdown) to safe HTML. GFM pipe-tables become
 * real `<table>` elements so they don't show as raw `| a | b |` / `|---|` text;
 * everything else stays escaped monospace text with newlines preserved.
 *
 * XSS-safe by construction: every piece of dynamic text routes through
 * `escapeHtml`, and only structural tags this function emits (`<table>`, `<tr>`,
 * `<th>`, `<td>`, `<div>`) ever reach the output. No markdown HTML passes
 * through. Exported so it's unit-testable in isolation.
 */
export function renderSnippet(raw: string): string {
  const lines = (raw ?? '').split('\n');
  const out: string[] = [];
  let textRun: string[] = [];

  const flushText = () => {
    const joined = textRun.join('\n').replace(/^\n+|\n+$/g, '');
    if (joined.length > 0) out.push(`<div class="snip-text">${escapeHtml(joined)}</div>`);
    textRun = [];
  };

  let i = 0;
  while (i < lines.length) {
    // A GFM table is a header row immediately followed by a delimiter row.
    if (isTableHeader(lines[i]!) && i + 1 < lines.length && isDelimiterRow(lines[i + 1]!)) {
      flushText();
      const header = splitRow(lines[i]!);
      i += 2; // consume header + delimiter
      const body: string[][] = [];
      while (i < lines.length && looksLikeRow(lines[i]!) && !isDelimiterRow(lines[i]!)) {
        body.push(splitRow(lines[i]!));
        i++;
      }
      out.push(renderTable(header, body));
    } else if (isDelimiterRow(lines[i]!)) {
      // Orphan delimiter: the chunk started mid-table, so the header row lived
      // in a previous chunk. Drop the lone `|---|` line and render any rows
      // that follow as a headerless table (rather than leak raw pipe text).
      flushText();
      i += 1;
      const body: string[][] = [];
      while (i < lines.length && looksLikeRow(lines[i]!) && !isDelimiterRow(lines[i]!)) {
        body.push(splitRow(lines[i]!));
        i++;
      }
      if (body.length > 0) out.push(renderTable(null, body));
    } else {
      textRun.push(lines[i]!);
      i++;
    }
  }
  flushText();
  return out.join('\n');
}

/**
 * Split a pipe-row into trimmed cells, dropping the leading/trailing pipe.
 * Splits on UNESCAPED pipes only and unescapes `\|` back to `|` per GFM, so a
 * cell containing a literal pipe (regex / math / code) stays one cell.
 */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function looksLikeRow(line: string): boolean {
  return line.includes('|');
}

/** Header candidate: a pipe-row (the following delimiter row is the real gate,
 *  so 1-column tables count too). */
function isTableHeader(line: string): boolean {
  return looksLikeRow(line) && splitRow(line).length >= 1;
}

/** Delimiter row: every cell is dashes with optional leading/trailing colon. */
function isDelimiterRow(line: string): boolean {
  if (!looksLikeRow(line)) return false;
  const cells = splitRow(line);
  return cells.length >= 1 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

function renderTable(header: string[] | null, body: string[][]): string {
  // Column count: header width, or the widest body row for a headerless table.
  const cols = header ? header.length : body.reduce((m, r) => Math.max(m, r.length), 0);
  const thead = header
    ? `<thead><tr>${header.map((c) => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>`
    : '';
  const rows = body
    .map((r) => {
      // Pad/truncate each row to the column count for a clean grid.
      const cells: string[] = [];
      for (let c = 0; c < cols; c++) cells.push(`<td>${escapeHtml(r[c] ?? '')}</td>`);
      return `<tr>${cells.join('')}</tr>`;
    })
    .join('');
  return `<table class="snip-table">${thead}<tbody>${rows}</tbody></table>`;
}

function basename(p: string): string {
  const parts = p.split('/');
  return parts[parts.length - 1] || p;
}

/** Score formatter: 4 decimals, trailing zeros trimmed (mirrors explain-formatter). */
function fmtScore(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return n.toFixed(4).replace(/\.?0+$/, '');
}

const STYLE = `
:root{
  --bg:#f6f7f9; --panel:#ffffff; --line:#e4e7ec; --text:#1f2328;
  --muted:#656d76; --accent:#0969da; --score:#1a7f37;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
  font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans CJK SC","PingFang SC","Microsoft YaHei",sans-serif}
.page-header{padding:28px 32px 18px;border-bottom:1px solid var(--line);background:var(--panel)}
.kicker{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.08em}
.page-header h1{margin:6px 0 4px;font-size:22px;font-weight:600;word-break:break-word}
.page-header .sub{color:var(--muted);font-size:13px}
/* Cards fill the browser width (no max-width cap). */
main{padding:20px 32px 48px}
.empty{color:var(--muted)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;
  padding:16px 18px;margin:0 0 14px;box-shadow:0 1px 2px rgba(0,0,0,.05)}
.card-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rank{color:var(--muted);font-variant-numeric:tabular-nums;min-width:1.4em}
.score{color:var(--score);font-weight:700;font-variant-numeric:tabular-nums;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.slug{font-weight:600;word-break:break-all}
.badge.stale{background:#fff8c5;color:#7d4e00;border:1px solid #eac54f;
  border-radius:999px;padding:1px 8px;font-size:11px}
.meta{color:var(--muted);font-size:13px;margin:8px 0 6px;word-break:break-word}
.meta .file{color:var(--text)}
.snippet{margin:8px 0 10px;padding:10px 14px;border-left:3px solid var(--accent);
  background:#f6f8fa;border-radius:0 6px 6px 0;overflow-x:auto}
.snip-text{white-space:pre-wrap;word-break:break-word;
  font-family:ui-monospace,SFMono-Regular,Menlo,"Noto Sans Mono CJK SC",monospace;font-size:13.5px}
.snip-table{border-collapse:collapse;margin:6px 0;font-size:13px}
.snip-table th,.snip-table td{border:1px solid var(--line);padding:4px 9px;
  text-align:left;vertical-align:top;word-break:break-word}
.snip-table th{background:#eef0f3;font-weight:600}
.open{display:inline-block;color:var(--accent);text-decoration:none;font-size:13px}
.open:hover{text-decoration:underline}
`;

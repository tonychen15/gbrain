import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { withEnv } from '../helpers/with-env.ts';
import { handleQueryHtml } from '../../src/core/search/html-output.ts';
import type { SearchResult } from '../../src/core/types.ts';

// Orchestration coverage for handleQueryHtml: the I/O half (DB source-path
// resolution + file write + browser guard) that html-formatter.test.ts can't
// reach since it only exercises the pure renderer + pure helpers.

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

function mk(partial: Partial<SearchResult>): SearchResult {
  return {
    slug: 'concepts/example',
    page_id: 1,
    title: 'Example',
    type: 'concept' as SearchResult['type'],
    chunk_text: 'hello world',
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 0.5,
    stale: false,
    ...partial,
  };
}

describe('handleQueryHtml', () => {
  test('engine=null (thin-client): writes HTML to GBRAIN_HOME, slug fallback, no source link', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-html-out-'));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_NO_BROWSER: '1' }, async () => {
        const outPath = await handleQueryHtml(null, 'how VCF works', [
          mk({ slug: 'broadcom/vcf', chunk_text: 'slot 1 rule' }),
        ]);
        // Lands under the GBRAIN_HOME override (configDir appends .gbrain).
        expect(outPath).toContain(home);
        expect(outPath.endsWith('last-query.html')).toBe(true);
        const html = readFileSync(outPath, 'utf8');
        expect(html).toContain('how VCF works');
        expect(html).toContain('broadcom/vcf');
        expect(html).toContain('slot 1 rule');
        // No engine → no source_path lookup → slug fallback, no open-link.
        expect(html).not.toContain('open source file');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('with engine: resolves an absolute source_path to a file:// link + snippet line', async () => {
    const page = await engine.putPage('broadcom/vcf', {
      type: 'concept',
      title: 'VCF',
      compiled_truth: 'slot 1 rule\nmore text',
    });
    // source_path isn't a PageInput field; set it directly to mimic an import.
    const srcDir = mkdtempSync(join(tmpdir(), 'gbrain-html-src-'));
    const srcFile = join(srcDir, 'vcf.md');
    writeFileSync(srcFile, 'intro line\nslot 1 rule\ntail\n', 'utf8');
    await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [srcFile, page.id]);

    const home = mkdtempSync(join(tmpdir(), 'gbrain-html-out-'));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_NO_BROWSER: '1' }, async () => {
        const outPath = await handleQueryHtml(engine, 'q', [
          mk({ slug: 'broadcom/vcf', page_id: page.id, chunk_text: 'slot 1 rule' }),
        ]);
        const html = readFileSync(outPath, 'utf8');
        expect(html).toContain('open source file');
        expect(html).toContain('file://');
        expect(html).toContain('vcf.md'); // basename surfaced
        expect(html).toContain('~line 2'); // 'slot 1 rule' is line 2 of the source
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(srcDir, { recursive: true, force: true });
    }
  });

  test('empty result set still writes a valid "No results" document', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-html-out-'));
    try {
      await withEnv({ GBRAIN_HOME: home, GBRAIN_NO_BROWSER: '1' }, async () => {
        const outPath = await handleQueryHtml(null, 'nothing matches', []);
        const html = readFileSync(outPath, 'utf8');
        expect(html).toContain('<!doctype html>');
        expect(html).toContain('No results.');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

import { describe, test, expect, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  escapeHtml,
  fileUrl,
  renderQueryHtml,
  type HtmlResultRow,
} from '../../src/core/search/html-formatter.ts';
import { bestEffortLine, resolveAbsoluteSourcePath } from '../../src/core/search/html-output.ts';
import { homedir } from 'os';
import type { SearchResult } from '../../src/core/types.ts';

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

function row(partial: Partial<SearchResult>, sourcePath: string | null = null, approxLine: number | null = null): HtmlResultRow {
  return { result: mk(partial), sourcePath, approxLine };
}

describe('escapeHtml', () => {
  test('escapes the five significant characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&z</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;z&lt;/a&gt;',
    );
  });
  test('leaves CJK and plain text untouched', () => {
    expect(escapeHtml('软件架构 raft')).toBe('软件架构 raft');
  });
});

describe('fileUrl', () => {
  test('encodes spaces and CJK per segment, preserves separators', () => {
    expect(fileUrl('/home/tong/Documents/Tech/vcf 软件架构.md')).toBe(
      'file:///home/tong/Documents/Tech/vcf%20%E8%BD%AF%E4%BB%B6%E6%9E%B6%E6%9E%84.md',
    );
  });
  test('keeps the file:// prefix and leading slash', () => {
    expect(fileUrl('/a/b.md')).toBe('file:///a/b.md');
  });
});

describe('renderQueryHtml', () => {
  test('is a complete UTF-8 document with the query in the header', () => {
    const html = renderQueryHtml({ query: 'how VCF works', rows: [row({})], generatedAt: new Date('2026-05-26T00:00:00Z') });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('how VCF works');
    expect(html).toContain('1 result');
  });

  test('renders score, slug, snippet, chunk index and section', () => {
    const html = renderQueryHtml({
      query: 'q',
      rows: [row({ slug: 'broadcom/vcf', score: 0.8748, chunk_index: 3, chunk_source: 'compiled_truth', chunk_text: 'slot 1 rule' })],
    });
    expect(html).toContain('0.8748');
    expect(html).toContain('broadcom/vcf');
    expect(html).toContain('chunk 3');
    expect(html).toContain('compiled_truth');
    expect(html).toContain('slot 1 rule');
  });

  test('HTML-escapes dynamic content (XSS-safety) in slug and snippet', () => {
    const html = renderQueryHtml({
      query: '<script>alert(1)</script>',
      rows: [row({ slug: 'a<b>&c', chunk_text: '<img src=x onerror=alert(1)>' })],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('a&lt;b&gt;&amp;c');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  test('preserves CJK content', () => {
    const html = renderQueryHtml({ query: 'q', rows: [row({ chunk_text: '下面我把核对结果反映到一张修正过的架构图里' })] });
    expect(html).toContain('下面我把核对结果反映到一张修正过的架构图里');
  });

  test('includes a file:// link + filename when sourcePath is present', () => {
    const html = renderQueryHtml({
      query: 'q',
      rows: [row({ slug: 'broadcom/vcf' }, '/home/tong/Documents/Tech/broadcom/vcf软件架构.md', 42)],
    });
    expect(html).toContain('open source file');
    expect(html).toContain('file:///home/tong/Documents/Tech/broadcom/');
    expect(html).toContain('vcf软件架构.md'); // basename shown
    expect(html).toContain('~line 42');
  });

  test('falls back to slug and omits the open-link when sourcePath is null', () => {
    const html = renderQueryHtml({ query: 'q', rows: [row({ slug: 'broadcom/vcf' }, null, null)] });
    expect(html).not.toContain('open source file');
    expect(html).not.toContain('~line');
    expect(html).toContain('broadcom/vcf');
  });

  test('empty result set renders a valid "No results" document', () => {
    const html = renderQueryHtml({ query: 'nothing', rows: [] });
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('No results.');
    expect(html).toContain('0 results');
  });

  test('marks stale results', () => {
    const html = renderQueryHtml({ query: 'q', rows: [row({ stale: true })] });
    expect(html).toContain('stale');
  });
});

describe('resolveAbsoluteSourcePath', () => {
  test('absolute path passes through unchanged', () => {
    expect(resolveAbsoluteSourcePath('/home/tong/Documents/Tech/a.md', '/anything')).toBe(
      '/home/tong/Documents/Tech/a.md',
    );
  });
  test('relative path joins against baseDir', () => {
    expect(resolveAbsoluteSourcePath('Broadcom/vcf.md', '/home/tong/Documents/Tech')).toBe(
      '/home/tong/Documents/Tech/Broadcom/vcf.md',
    );
  });
  test('relative path with no baseDir → null (no broken relative file://)', () => {
    expect(resolveAbsoluteSourcePath('Broadcom/vcf.md', null)).toBeNull();
    expect(resolveAbsoluteSourcePath('Broadcom/vcf.md', undefined)).toBeNull();
  });
  test('null/empty rawPath → null', () => {
    expect(resolveAbsoluteSourcePath(null, '/base')).toBeNull();
    expect(resolveAbsoluteSourcePath('', '/base')).toBeNull();
  });
  test('tilde in baseDir is expanded', () => {
    expect(resolveAbsoluteSourcePath('a/b.md', '~/Documents/Tech')).toBe(
      join(homedir(), 'Documents/Tech/a/b.md'),
    );
  });
});

describe('bestEffortLine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-html-line-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('returns the 1-based line of the snippet in the file', () => {
    const p = join(dir, 'doc.md');
    writeFileSync(p, 'line one\nline two\ntarget paragraph here\nline four\n', 'utf8');
    expect(bestEffortLine(p, 'target paragraph here')).toBe(3);
  });

  test('matches on the first 60 chars / trimmed prefix', () => {
    const p = join(dir, 'doc2.md');
    writeFileSync(p, 'intro\n\n   下面我把核对结果反映到一张修正过的架构图里，然后逐模块\n', 'utf8');
    expect(bestEffortLine(p, '下面我把核对结果反映到一张修正过的架构图里')).toBe(3);
  });

  test('returns null when the snippet is not found verbatim', () => {
    const p = join(dir, 'doc3.md');
    writeFileSync(p, 'completely different content\n', 'utf8');
    expect(bestEffortLine(p, 'not present anywhere')).toBeNull();
  });

  test('returns null for a missing file', () => {
    expect(bestEffortLine(join(dir, 'nope.md'), 'anything')).toBeNull();
  });

  test('returns null for empty snippet', () => {
    const p = join(dir, 'doc4.md');
    writeFileSync(p, 'x\n', 'utf8');
    expect(bestEffortLine(p, '   ')).toBeNull();
  });
});

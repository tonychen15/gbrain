/**
 * hybridSearch embed-failure observability (integration).
 *
 * Pins the swallow-catch fix: when the query-side embed throws, hybridSearch
 * must (a) still return results via the keyword-only fallback (fail-open
 * preserved) AND (b) record an embed-failure audit row (no longer silent).
 *
 * .serial because it drives module-level gateway transport state
 * (__setEmbedTransportForTests) + configureGateway, mirroring
 * hybrid-reranker-integration.serial.test.ts. Direct env mutation is allowed
 * in serial files; GBRAIN_HOME (config) + GBRAIN_AUDIT_DIR are isolated to
 * tmpdirs and restored in afterAll.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { readRecentEmbedFailures } from '../../src/core/search/embed-failure-audit.ts';
import type { PageInput } from '../../src/core/types.ts';

let engine: PGLiteEngine;
let homeDir: string;
let auditDir: string;
let prevHome: string | undefined;
let prevAudit: string | undefined;
const DIMS = 1536;

beforeAll(async () => {
  prevHome = process.env.GBRAIN_HOME;
  prevAudit = process.env.GBRAIN_AUDIT_DIR;
  homeDir = mkdtempSync(join(tmpdir(), 'gbrain-embedfail-home-'));
  auditDir = mkdtempSync(join(tmpdir(), 'gbrain-embedfail-audit-'));
  // Config matches the stubbed gateway dims so the resolver agrees with the stub.
  mkdirSync(join(homeDir, '.gbrain'), { recursive: true });
  writeFileSync(
    join(homeDir, '.gbrain', 'config.json'),
    JSON.stringify({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS }),
    'utf8',
  );
  process.env.GBRAIN_HOME = homeDir;
  process.env.GBRAIN_AUDIT_DIR = auditDir;

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed pages + chunks so keyword search has rows. No embeddings stored →
  // searchVector returns empty; only the QUERY-side embed is exercised.
  const pages: Array<[string, PageInput, string]> = [
    ['notes/alpha', { type: 'note', title: 'Alpha', compiled_truth: 'alpha keyword content one' }, 'alpha keyword content one chunk'],
    ['notes/beta', { type: 'note', title: 'Beta', compiled_truth: 'alpha keyword content two' }, 'alpha keyword content two chunk'],
  ];
  for (const [slug, page, chunkText] of pages) {
    await engine.putPage(slug, page);
    await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: chunkText, chunk_source: 'compiled_truth' }]);
  }

  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  // Simulate a down / misconfigured embedder: the query-side embed throws.
  __setEmbedTransportForTests(async () => {
    throw new Error('simulated embed provider failure');
  });
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  if (prevHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = prevHome;
  if (prevAudit === undefined) delete process.env.GBRAIN_AUDIT_DIR;
  else process.env.GBRAIN_AUDIT_DIR = prevAudit;
  if (homeDir) rmSync(homeDir, { recursive: true, force: true });
  if (auditDir) rmSync(auditDir, { recursive: true, force: true });
});

describe('hybridSearch — embed failure: fail-open + audited', () => {
  test('returns keyword results and logs an embed-failure row (not swallowed)', async () => {
    const before = readRecentEmbedFailures(7).length;

    const results = await hybridSearch(engine, 'alpha keyword', { limit: 10 });

    // (a) fail-open preserved: keyword-only fallback still returns results.
    expect(results.length).toBeGreaterThan(0);

    // (b) the previously-swallowed error is now recorded.
    const after = readRecentEmbedFailures(7);
    expect(after.length).toBeGreaterThan(before);
    const latest = after[after.length - 1]!;
    expect(latest.modality).toBe('text');
    expect(latest.severity).toBe('warn');
    expect(latest.error_summary).toContain('simulated embed provider failure');
    expect(latest.query_hash).toMatch(/^[0-9a-f]{8}$/); // hashed, not raw text
    // Diagnostic fields captured from the resolved column (matches config above).
    expect(latest.model).toContain('text-embedding-3-large');
    expect(latest.dimensions).toBe(DIMS);
  });
});

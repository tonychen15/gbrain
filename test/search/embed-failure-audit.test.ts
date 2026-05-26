/**
 * embed-failure audit JSONL round-trip.
 *
 * Pins:
 *  - logEmbedFailure → readRecentEmbedFailures round-trip
 *  - query is hashed (hashQuery), never stored raw
 *  - error_summary truncated to 200 chars
 *  - ISO-week filename rotation
 *  - no logEmbedSuccess (failure-only, like rerank-audit)
 *
 * Uses `withEnv()` per test-isolation lint rule R1: never mutate process.env
 * directly outside `*.serial.test.ts`.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { withEnv } from '../helpers/with-env.ts';
import {
  logEmbedFailure,
  readRecentEmbedFailures,
  hashQuery,
  computeEmbedFailureAuditFilename,
} from '../../src/core/search/embed-failure-audit.ts';

async function withFreshAuditDir(body: (tmpDir: string) => void | Promise<void>): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-embed-audit-'));
  try {
    await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
      await body(tmpDir);
    });
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

describe('embed-failure audit JSONL round-trip', () => {
  test('log → read returns the same event shape', async () => {
    await withFreshAuditDir(() => {
      logEmbedFailure({
        query_hash: hashQuery('how does VCF licensing work'),
        modality: 'text',
        model: 'openai:text-embedding-3-small',
        dimensions: 1280,
        error_summary: 'Embedding dim mismatch: returned 1536 but schema expects 1280',
      });
      const events = readRecentEmbedFailures(7);
      expect(events).toHaveLength(1);
      expect(events[0]!.modality).toBe('text');
      expect(events[0]!.severity).toBe('warn');
      expect(events[0]!.model).toBe('openai:text-embedding-3-small');
      expect(events[0]!.dimensions).toBe(1280);
      expect(events[0]!.error_summary).toContain('dim mismatch');
      expect(typeof events[0]!.ts).toBe('string');
    });
  });

  test('query is hashed, never stored raw', async () => {
    await withFreshAuditDir((dir) => {
      const raw = 'lookup phrase marker-tok-abc123';
      logEmbedFailure({ query_hash: hashQuery(raw), modality: 'text', error_summary: 'boom' });
      const file = path.join(dir, computeEmbedFailureAuditFilename());
      const contents = fs.readFileSync(file, 'utf8');
      expect(contents).not.toContain('marker-tok-abc123'); // raw query text never on disk
      const events = readRecentEmbedFailures(7);
      expect(events[0]!.query_hash).toMatch(/^[0-9a-f]{8}$/); // 8 hex chars
      expect(events[0]!.query_hash).toBe(hashQuery(raw)); // deterministic
    });
  });

  test('error_summary truncated to 200 chars', async () => {
    await withFreshAuditDir(() => {
      logEmbedFailure({ query_hash: 'deadbeef', modality: 'image', error_summary: 'x'.repeat(500) });
      const events = readRecentEmbedFailures(7);
      expect(events[0]!.error_summary.length).toBeLessThanOrEqual(200);
      expect(events[0]!.error_summary.endsWith('…')).toBe(true);
    });
  });

  test('empty window returns no events', async () => {
    await withFreshAuditDir(() => {
      expect(readRecentEmbedFailures(7)).toHaveLength(0);
    });
  });

  test('filename uses ISO-week rotation', () => {
    expect(computeEmbedFailureAuditFilename(new Date('2026-05-26T00:00:00Z'))).toMatch(
      /^embed-failures-2026-W\d\d\.jsonl$/,
    );
  });

  test('no logEmbedSuccess export (failure-only audit)', async () => {
    const mod = await import('../../src/core/search/embed-failure-audit.ts');
    expect((mod as Record<string, unknown>).logEmbedSuccess).toBeUndefined();
  });
});

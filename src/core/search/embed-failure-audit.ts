/**
 * Embed-failure audit trail — search-layer fail-open observability.
 *
 * Writes warn-severity rows to `~/.gbrain/audit/embed-failures-YYYY-Www.jsonl`
 * (ISO-week rotation, mirrors rerank-audit.ts). Fired when `hybridSearch`
 * catches an error from the query-side embed / `searchVector` step and falls
 * back to keyword-only retrieval. The fallback is intentional (search
 * reliability beats vector quality), but the error used to be SWALLOWED with a
 * bare `catch {}` — so a real misconfig (config <-> stored-data embedding
 * dimension mismatch after a model switch, an unconfigured provider, a network
 * blip) silently halved retrieval quality with zero signal. This audit row is
 * the cross-process signal that `gbrain doctor`'s `embed_failure_audit` check
 * reads.
 *
 * Success events are intentionally NOT logged (rare-event-only, like
 * rerank-audit / slug-fallback): logging once per query would be hot-path I/O
 * churn and would leak query volume + timing into a local file.
 *
 * Privacy: the query is SHA-256-hashed (8 hex chars); raw query text is never
 * stored. The upstream error message is truncated to 200 chars.
 *
 * Best-effort writes. Write failures go to stderr but search continues.
 * Internals delegate to the shared `src/core/audit/audit-writer.ts` primitive.
 */

import { createHash } from 'crypto';
import { createAuditWriter, computeIsoWeekFilename } from '../audit/audit-writer.ts';

export interface EmbedFailureEvent {
  ts: string;
  /** SHA-256 prefix (8 hex chars) of the query. Never the raw query text. */
  query_hash: string;
  /** Which embedding branch failed. 'text' is the common case. */
  modality: 'text' | 'image' | 'both';
  /** Resolved embedding model (provider:model) the failing call used, when
   *  known. Lets the operator tell a down provider from a config mismatch
   *  without secondary investigation. Omitted when the builtin default was in
   *  use (no explicit model on the resolved column). */
  model?: string;
  /** Resolved embedding dimensions the failing call expected, when known.
   *  The originating bug class is a config<->stored-data dim mismatch, so this
   *  is the single most diagnostic field. */
  dimensions?: number;
  /** Truncated upstream error message (first 200 chars); query is hashed
   *  separately so this never carries raw query text. */
  error_summary: string;
  /** Always 'warn' — the failure degrades retrieval quality, doesn't break it. */
  severity: 'warn';
}

/** SHA-256 prefix (8 hex chars) of the query text, for privacy-preserving audit. */
export function hashQuery(query: string): string {
  return createHash('sha256').update(query, 'utf8').digest('hex').slice(0, 8);
}

/** ISO-week-rotated filename: `embed-failures-YYYY-Www.jsonl`. */
export function computeEmbedFailureAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('embed-failures', now);
}

/** Plain length-cut truncation (matches rerank-audit's truncateErrorSummary). */
function truncateErrorSummary(msg: string, max = 200): string {
  if (msg.length <= max) return msg;
  return msg.slice(0, max - 1) + '…';
}

const writer = createAuditWriter<EmbedFailureEvent>({
  featureName: 'embed-failures',
  errorLabel: 'gbrain',
  errorMessagePrefix: 'embed-failure audit ',
  errorTrailer: '; search continues',
});

/**
 * Append an embed-failure event. Best-effort: write failure logs to stderr but
 * never throws.
 */
export function logEmbedFailure(event: Omit<EmbedFailureEvent, 'ts' | 'severity'>): void {
  writer.log({
    severity: 'warn',
    ...event,
    error_summary: truncateErrorSummary(event.error_summary),
  } as Omit<EmbedFailureEvent, 'ts'>);
}

/**
 * Read recent (`days` window, default 7) embed-failure events. Used by
 * `gbrain doctor`'s `embed_failure_audit` check. Missing file / corrupt rows
 * are skipped silently — the audit trail is informational.
 */
export function readRecentEmbedFailures(days = 7, now: Date = new Date()): EmbedFailureEvent[] {
  return writer.readRecent(days, now);
}

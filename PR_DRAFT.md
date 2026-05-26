<!-- SCRATCH: `git rm PR_DRAFT.md` before opening the real PR, or it shows in the diff. -->

# fix(search): surface silently-swallowed vector-search errors

Closes #<ISSUE-2>  <!-- the "vector-search errors are silently swallowed" issue -->

## Problem

The text-vector path in `hybridSearch` (`src/core/search/hybrid.ts`) had a bare
`catch {}` that swallowed **all** embed / `searchVector` errors and fell back to
keyword-only retrieval with **zero signal**. A genuine production misconfig — most
realistically a config↔stored-data embedding-dimension mismatch after switching
embedding models without re-embedding, or a down provider — would silently halve
retrieval quality. Nothing in the logs, `gbrain doctor`, or stats showed it.

## Fix (fail-open behavior unchanged — observability only)

- **New `src/core/search/embed-failure-audit.ts`** — failure-only JSONL audit built on
  the shared `createAuditWriter` primitive (mirrors `rerank-audit.ts`). Query is
  SHA-256-hashed (never stored raw); error truncated to 200 chars; resolved
  `model` + `dimensions` captured for diagnosis; ISO-week rotation; best-effort writes.
- **`hybrid.ts`** — the catch now calls `logEmbedFailure(...)` instead of swallowing.
  Only the bare-`hybridSearch` site logs; the cached wrapper delegates to it on a miss,
  so coverage is complete with no double-logging. Ranking/results are byte-identical.
- **`gbrain doctor`** — new `embed_failure_audit` check (wired into both `buildChecks`
  and `doctorReportRemote`) that warns on any failure in the last 7 days, surfaces the
  latest `model @ Nd`, and points at `gbrain models doctor`.

## Why it matters

The fail-open is correct (search reliability beats vector quality). The **silence** was
the bug: a degraded-to-keyword-only brain looked healthy. This makes the degradation
visible without changing any retrieval behavior.

## Test plan

- `bun run typecheck` — clean
- `bun test test/search/embed-failure-audit.test.ts test/search/hybrid-embed-failure.serial.test.ts` — pass
  - unit: log→read round-trip, query hashed not raw, 200-char truncation, ISO-week, model/dims round-trip
  - serial integration: embed stub throws → results still return (keyword fallback) **and** a failure row is logged
- `test/doctor.test.ts` — `embed_failure_audit` ok/warn + wiring cases pass
- `bun run verify` — clean
- `bun run ci:local` — full Docker stack (gitleaks + unit + E2E) green

## Notes

- No `VERSION` / `CHANGELOG` / `TODOS` edits (maintainer handles these during the fix wave).
- No secrets in the diff (gitleaks clean).

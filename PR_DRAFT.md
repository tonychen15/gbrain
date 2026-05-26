<!-- SCRATCH: `git rm PR_DRAFT.md` before opening the real PR, or it shows in the diff. -->

# feat(search): opt-in `--html` output for `gbrain search` / `query`

Closes #<FEATURE-ISSUE>  <!-- the "--html browser output" feature issue -->

## What it does

`gbrain query "..." --html` (and `gbrain search "..." --html`) renders results as a
self-contained HTML page written to `~/.gbrain/last-query.html` and opens it in the
browser. Each result is a card: relevance score, matched snippet, chunk index/section,
and a clickable `file://` link to the source markdown (with the approximate line of the
snippet when it can be located). GFM pipe-tables in the snippet render as real tables.

**Strictly opt-in.** Without `--html`, nothing changes — the plain-text formatter is
used, so terminal use, pipes, `--json`, and CI all stay on the text path. `--no-html`
is the explicit off form. Works on both the local-engine and thin-client (remote MCP)
paths; on a thin client, cards fall back to the page slug (no local file to link).

## Why

Reading results as a wall of terminal text is fine for a glance, but when a hit is buried
in a long note you want to jump to the source. This makes that one command away, without
changing default behavior.

## What changed

- `src/core/cli-options.ts` — `--html` / `--no-html` global flags (default off).
- `src/core/search/html-formatter.ts` (new) — pure, HTML/CJK-safe renderer: score,
  source-file link, chunk#/section, snippet, stale badge, empty-state, light theme,
  full-width cards, and GFM pipe-table rendering (cell text escaped → XSS-safe; handles
  escaped pipes, single-column tables, and orphan delimiters from mid-table chunks).
- `src/core/search/html-output.ts` (new) — I/O orchestration: batched source-path
  resolution, best-effort snippet line lookup, `mkdir -p ~/.gbrain` before write, browser
  open. Best-effort throughout — the search command always succeeds even if the lookup,
  write, or opener fails. `GBRAIN_NO_BROWSER=1` skips the auto-open.
- `src/cli.ts` — `emitQueryResult` routes search/query to HTML only when `--html` is set
  and results are non-empty; otherwise the existing text formatter.

## Test plan

- `bun run typecheck` — clean
- `bun test test/search/html-formatter.test.ts test/search/html-output.test.ts test/cli-options.test.ts` — pass
  (renderer + XSS/CJK + GFM tables incl. escaped-pipe/1-col/orphan-delimiter; orchestration:
  source-path resolution + file write + browser guard; flag parsing)
- `bun run verify` — clean
- Manual: ran against a real 1,205-page brain — 20 results, source links resolved to real
  `file://` paths (URL-encoded), GFM tables rendered, opened in browser.

## Notes

- No `VERSION` / `CHANGELOG` / `TODOS` edits (maintainer handles these during the fix wave).
- No secrets in the diff (gitleaks clean).
- The compiled `gbrain` binary can't open a PGLite brain on some Bun builds (see upstream
  issue about `/$bunfs` read-only WASM); run from source (`bun run src/cli.ts ... --html`)
  to exercise it locally on a PGLite brain.

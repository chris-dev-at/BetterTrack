# factory-knowledge.md — the knowledge-pack efficiency system

## What it is

The build factory (`factory/run.sh`) runs headless Claude agents — planner, writer,
reviewer, fixer — one issue per cycle. Previously every agent started cold and
re-read `PROJECTPLAN.md` (800+ lines), `MODELUSE.md`, `CLAUDE.md`, and crawled the
repo tree just to orient itself: tens of thousands of redundant read-tokens per
run. The **knowledge pack** replaces that cold start with a pre-built, curated
brief that is injected into every role prompt.

## Committed vs. generated

Committed (source of truth, in `factory/knowledge/`):

- **`PACK.md`** — a hand-curated standing brief (≤ ~300 lines): what BetterTrack
  is, architecture, conventions, model-tier routing, the P0–P10 phase digest,
  commands, and how to orient. Edit this by hand when the project's shape changes.
- **`build.mjs`** — a deterministic, dependency-free (Node ≥20, `fs`/`path` +
  regex only) generator that scans `apps/*/src` and `packages/*/src`.

Generated (git-ignored — never commit; rebuilt each cycle):

- **`graph.json`** — `{ generatedAt, nodes[], edges[] }`. Each node is
  `{ path, package, kind, exports, imports, loc }` (kind is a path/filename
  heuristic: route/domain/service/job/component/page/hook/test/schema/config/other).
  Edges are resolved workspace-internal import pairs. Query it with `jq`.
- **`MAP.md`** — a compact, human-readable module map grouped by directory
  (`path — kind — exports`), test dirs collapsed to counts.

## How injection works

1. At the start of each cycle, after `git reset --hard origin/main`, `run.sh` runs
   `node factory/knowledge/build.mjs` (non-fatal on failure) to regenerate
   `graph.json` + `MAP.md` from the fresh tree.
2. The `pack()` helper emits, between `=== FACTORY KNOWLEDGE PACK ===` /
   `=== END PACK ===` delimiters: `PACK.md`, then `MAP.md`, then a live **STATE**
   block (date, `git log --oneline -15`, open autopilot/awaiting-owner/needs-human
   issues, open PRs). Every `gh`/`git` call degrades gracefully so `pack()` can
   never abort a cycle.
3. Each planner/writer/reviewer/fixer invocation is assembled as
   `with_pack "<role prompt>"` — the pack is prepended as a single, quoting-safe
   argument ahead of the (still `sed`-substituted) role prompt. The prompt preamble
   tells the agent to trust the pack and not re-read the big docs or crawl the tree.

## Token-efficiency rationale

The full injected pack is ~25 KB (~24 KiB) — a fixed cost that replaces variable,
much larger orientation reads on every agent turn (planner + writer + reviewer +
each fixer round). Agents locate files via `MAP.md`/`graph.json` and read only the
handful they will modify or review; the planner quotes the needed PROJECTPLAN
excerpts verbatim into each issue's `## Context`, so the writer never opens
`PROJECTPLAN.md` at all.

## Regenerating manually

```bash
pnpm knowledge:build          # or: node factory/knowledge/build.mjs
jq . factory/knowledge/graph.json >/dev/null   # sanity-check valid JSON
```

Idempotent and finishes in seconds. `graph.json` and `MAP.md` are git-ignored;
only `PACK.md` and `build.mjs` are committed.

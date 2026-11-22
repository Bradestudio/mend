# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Bradestudio/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Bradestudio/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` applies an edit an AI model wrote to a tree of text files — in any of the four formats models actually write: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is changed or nothing is.

Built for the [make.fun hidden-spec-cli-01-run-20261122 bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122). `SPEC.md` is the whole specification; `main.ts` implements all ten of its sections.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the patch file, relative to the working directory (the tree root); absent or `-` reads it from standard input.
- `--format=NAME` reads one format: `unified`, `search-replace`, `v4a`, `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

Exit codes: `0` with one `A`/`D`/`M`/`R` line per changed path (byte order) plus `ok: <n> files`; `1` with one `error: <code> <path>` line per failed edit plus `failed: <k> of <n> edits` (and no file written); `2` with a single `error: usage` / `error: no-patch` / `error: format` / `error: parse <N>` line.

Matching is forgiving the way models are sloppy: three tiers (exact, trailing whitespace, leading + trailing whitespace), unified hunks take the occurrence nearest their stated line number, V4A chunks walk a cursor from their anchor, SEARCH/REPLACE demands exactly one occurrence. CRLF files keep their line breaks, files without a final line break keep that too, and moves print as `R <old> -> <new>`.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `SPEC.md` — the specification (version 1).
- `runner.ts` — the kit's trial runner (kept as-is); `main.ts` hands a trial over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts` — the practice set on your own machine: `node check.ts <practice.json>` (practice score 1000/1000).
- `LICENSE` — MIT.

## Check

No build step, no dependencies:

    node check.ts ../program/generator/practice.json

---

Built for the make.fun bounty — https://make.fun/bounty/hidden-spec-cli-01-run-20261122?ref=qjs4e9sj

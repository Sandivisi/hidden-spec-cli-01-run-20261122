# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Sandivisi/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Sandivisi/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats, and `mend` reads all of them: a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is changed or nothing is.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

## Usage

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file. When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (no whitespace-tolerant matching).

## Exit codes and output

- Exit 0: the tree is written. One line per changed path (`A`, `D`, `M`, or `R old -> new` for a move), then `ok: <n> files`.
- Exit 1: one `error: <code> <path>` line per failed edit, then `failed: <k> of <n> edits`. Nothing is written.
- Exit 2: a single `error: usage`, `error: no-patch`, `error: format` or `error: parse <N>` line.

## Matching

An edit's old lines are found in the file at the first of three tiers that has a match: exact, ignoring trailing spaces and tabs, or ignoring leading and trailing spaces and tabs. Unified hunks take the occurrence nearest the hunk's stated line; SEARCH/REPLACE blocks fail as ambiguous when the old lines occur more than once; V4A chunks search forward from a cursor, optionally anchored by an `@@` line.

## Requirements

Node 22 or later, standard library only. No dependencies, no network.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gnkp9jxa&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>

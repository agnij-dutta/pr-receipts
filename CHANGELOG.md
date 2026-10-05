# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-04

Published to npm on 2026-10-05 as [`pr-receipts`](https://www.npmjs.com/package/pr-receipts). The Action is available as `agnij-dutta/pr-receipts@v0`.

### Added

- `collect`: reads usage metadata from local Claude Code transcripts (including subagent files), deduplicates streamed records by `message.id`, and attributes each API request to a branch by dedicated worktree, transcript `gitBranch`, working directory and the commit time window. `--loose` adds sessions that edited the branch's files from outside the repo.
- Pricing from `config/pricing.json`: per-model input, 5-minute and 1-hour cache writes, cache reads, output, fast mode, US inference multiplier and web search. Unknown models are reported as unpriced. Bedrock and Vertex model ids are normalized.
- `render`, `attach`, `show`, `install-hook` and `comment` commands. Receipts are stored as git notes under `refs/notes/pr-receipts`.
- Composite GitHub Action that upserts one sticky PR comment, with dry-run (no API calls), `on-missing`, and `cost-usd` / `headline` outputs. Fork PRs are skipped.
- Privacy controls: no transcript content leaves the parser, file paths are repo-relative and limited to the branch's checkout, gitignored paths are not listed, tool counts are opt-in, and receipts read back from notes are rebuilt by a strict sanitizer.
- `scripts/leak-check.mjs` to verify a real receipt against its source transcripts.
- Synthetic fixture generator and a `node:test` suite (34 tests).

[Unreleased]: https://github.com/agnij-dutta/pr-receipts/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/agnij-dutta/pr-receipts/releases/tag/v0.1.0

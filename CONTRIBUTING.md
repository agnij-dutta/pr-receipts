# Contributing

Thanks for helping. Bug reports with a synthetic reproduction are as useful as code.

## Setup

Node 20 or newer, and git.

```bash
git clone https://github.com/agnij-dutta/pr-receipts.git
cd pr-receipts
npm ci
```

## Everyday commands

| Command | What it does |
|---|---|
| `npm test` | Clean build, then the full `node:test` suite on synthetic fixtures. |
| `npm run check` | Biome lint + format check, then `tsc --noEmit`. CI runs this. |
| `npm run format` | Apply Biome formatting. |
| `npm run build` | Clean `dist/`, compile, copy `config/pricing.json` into `dist/config/`. |
| `npm run fixtures` | Write a synthetic world (git repo + fake transcripts) to `test/fixtures/generated/` for manual runs. |
| `npm run leak-check -- <receipt.json> <receipt.md>` | Check a real receipt against the transcripts it came from. Prints counts only. |

**`dist/` is committed** because the GitHub Action runs it directly. After changing anything in `src/`, run `npm run build` and commit the `dist/src` changes in the same commit. CI fails if `dist/` is out of date.

## Layout

```
src/
  transcripts.ts   the ONLY module that reads raw transcript lines; extracts usage metadata
  attribution.ts   per-request rules (worktree, gitBranch, cwd, --loose) and aggregation
  collect.ts       git context + time window, then calls attribution
  pricing.ts       model id normalization, pricing table loading and cost math
  render.ts        sanitizeReceipt (read-back allow-list) and Markdown rendering
  format.ts        money, token, duration and headline formatting
  notes.ts         git notes read/write/push, pre-push hook
  git.ts           git CLI wrappers
  action/main.ts   GitHub Action entry point (sticky comment upsert)
  cli.ts           command-line entry point
config/pricing.json  list prices per million tokens, with source and fetch date
action.yml           composite action definition
test/                node:test suite and the synthetic fixture generator
scripts/             build helpers and the leak checker
```

## Ground rules

- **Privacy first.** Only `src/transcripts.ts` may touch raw transcript records. If you need a new field, copy out the specific number or enum there; never pass a raw record or a content string onward. Add the field to the planted-secret tests in `test/receipts.test.ts`.
- **No real transcripts in the repo**, not even redacted. Extend `test/fixtures/generate.ts` instead.
- **Errors are not absences.** If something fails (git, the API, a corrupt note), throw with a message that says what to do. Don't return "no receipt".
- No new runtime dependencies without a strong reason. The Action runs `dist/` as-is with no install step.

## Common extensions

**Price a new model.** Add a row to `config/pricing.json` (all five rates are required, `fast` is optional), update `fetchedAt` if you re-checked the source, add a display name to `PRETTY` in `src/format.ts`, and add a case to the pricing test. `loadPricing` rejects missing or non-numeric rates.

**Add an attribution rule.** Rules live in `judge()` and the `--loose` block of `buildReceipt()` in `src/attribution.ts`. Add a session to `buildWorld()` in `test/fixtures/generate.ts` that exercises the rule (and one that must NOT match), then assert the `mapping` counts. Update "Attribution rules" and "Where attribution can be wrong" in the README.

**Add a receipt field.** Add it to `Receipt` in `src/types.ts`, fill it in `buildReceipt`, and add it to `sanitizeReceipt` in `src/render.ts`. A field missing from the sanitizer is dropped on read-back, which is deliberate. If the schema changes incompatibly, bump `pr-receipts/v1`.

**Support another agent CLI.** Write a parser that produces the same `ParsedTranscripts` shape as `parseTranscripts`, under the same privacy contract, and add fixtures for its record format.

## Commits and pull requests

- Plain, specific commit messages ("Fix window start after rebase").
- Add a line under `## [Unreleased]` in `CHANGELOG.md` for user-visible changes.
- No em dashes in docs or user-facing strings (a test checks the rendered comment).

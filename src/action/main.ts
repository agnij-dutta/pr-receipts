// GitHub Action entry point (invoked by the composite action.yml).
// Reads the receipt from git notes on the PR's commits and upserts ONE sticky
// comment. Zero dependencies: plain fetch against the REST API so the action
// can run straight from the committed dist/ without a bundler.

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { findReceipt } from "../notes.js";
import { renderMarkdown, STICKY_MARKER } from "../render.js";
import type { Receipt } from "../types.js";

export interface ActionEnv {
  token?: string;
  eventPath?: string;
  repository?: string; // owner/name
  apiUrl?: string;
  workspace: string;
  notesRef: string;
  dryRun: boolean;
  missing: "skip" | "comment";
  stepSummary?: string;
  output?: string;
}

export type Fetch = typeof fetch;

export interface Plan {
  action: "create" | "update" | "skip";
  commentId?: number;
  body?: string;
  reason?: string;
  receiptCommit?: string;
}

export function envFromProcess(e = process.env): ActionEnv {
  const input = (name: string) => e[`INPUT_${name.toUpperCase()}`] ?? e[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`];
  return {
    token: input("github-token") || e.GITHUB_TOKEN,
    eventPath: e.GITHUB_EVENT_PATH,
    repository: e.GITHUB_REPOSITORY,
    apiUrl: e.GITHUB_API_URL ?? "https://api.github.com",
    workspace: e.GITHUB_WORKSPACE ?? process.cwd(),
    notesRef: input("notes-ref") || "pr-receipts",
    dryRun: /^(1|true|yes)$/i.test(input("dry-run") ?? ""),
    missing: input("on-missing") === "comment" ? "comment" : "skip",
    stepSummary: e.GITHUB_STEP_SUMMARY,
    output: e.GITHUB_OUTPUT,
  };
}

interface PrInfo {
  number: number;
  headSha: string;
  baseSha: string | null;
}

export function prFromEvent(event: any): PrInfo | null {
  const pr = event?.pull_request;
  if (!pr || typeof pr.number !== "number") return null;
  return { number: pr.number, headSha: pr.head?.sha, baseSha: pr.base?.sha ?? null };
}

export function bodyFor(receipt: Receipt | null): string | null {
  if (!receipt) return null;
  return renderMarkdown(receipt, { sticky: true });
}

/** Find our sticky comment (by hidden marker) across all pages. */
export async function findSticky(
  f: Fetch,
  api: string,
  repo: string,
  pr: number,
  token: string,
): Promise<number | null> {
  for (let page = 1; page <= 20; page++) {
    const res = await f(`${api}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`, {
      headers: ghHeaders(token),
    });
    if (!res.ok) throw new Error(`list comments failed: ${res.status}`);
    const items = (await res.json()) as { id: number; body?: string }[];
    const hit = items.find((c) => c.body?.includes(STICKY_MARKER));
    if (hit) return hit.id;
    if (items.length < 100) return null;
  }
  return null;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };
}

export async function run(env: ActionEnv, f: Fetch = fetch, log = console.log): Promise<Plan> {
  if (!env.eventPath) throw new Error("GITHUB_EVENT_PATH is not set");
  const event = JSON.parse(readFileSync(env.eventPath, "utf8"));
  const pr = prFromEvent(event);
  if (!pr) {
    log("pr-receipts: not a pull_request event, nothing to do.");
    return { action: "skip", reason: "not a pull_request event" };
  }

  const found = findReceipt(env.workspace, pr.headSha, pr.baseSha, env.notesRef);
  let body = bodyFor(found?.receipt ?? null);
  if (!body) {
    if (env.missing === "skip") {
      log(`pr-receipts: no receipt in refs/notes/${env.notesRef} for PR #${pr.number}; skipping.`);
      return { action: "skip", reason: "no receipt" };
    }
    body = `${STICKY_MARKER}\n### PR Receipt\n\nNo receipt attached yet. Run \`pr-receipts attach --push\` on the machine that ran the agent.\n`;
  }

  if (env.stepSummary) {
    try {
      appendFileSync(env.stepSummary, body.replace(STICKY_MARKER, ""));
    } catch {
      /* summary is best-effort */
    }
  }
  if (env.output && found) {
    try {
      appendFileSync(env.output, `cost-usd=${found.receipt.totals.costUSD}\nheadline=${found.receipt.headline}\n`);
    } catch {
      /* best-effort */
    }
  }

  if (env.dryRun) {
    log(`pr-receipts: DRY RUN. Would upsert this comment on PR #${pr.number}:\n`);
    log(body);
    return { action: "skip", reason: "dry-run", body, receiptCommit: found?.commit };
  }
  if (!env.token || !env.repository) throw new Error("github-token and GITHUB_REPOSITORY are required unless dry-run");

  const api = env.apiUrl ?? "https://api.github.com";
  const existing = await findSticky(f, api, env.repository, pr.number, env.token);
  if (existing) {
    const res = await f(`${api}/repos/${env.repository}/issues/comments/${existing}`, {
      method: "PATCH",
      headers: ghHeaders(env.token),
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error(`update comment failed: ${res.status}`);
    log(`pr-receipts: updated comment ${existing}`);
    return { action: "update", commentId: existing, body, receiptCommit: found?.commit };
  }
  const res = await f(`${api}/repos/${env.repository}/issues/${pr.number}/comments`, {
    method: "POST",
    headers: ghHeaders(env.token),
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`create comment failed: ${res.status}`);
  const created = (await res.json()) as { id: number };
  log(`pr-receipts: created comment ${created.id}`);
  return { action: "create", commentId: created.id, body, receiptCommit: found?.commit };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  run(envFromProcess()).catch((err) => {
    console.error(`::error::pr-receipts: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

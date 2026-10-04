// GitHub Action entry point (invoked by the composite action.yml).
// Reads the receipt from git notes on the PR's commits and upserts ONE sticky
// comment. Zero dependencies: plain fetch against the REST API so the action
// can run straight from the committed dist/ without a bundler.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { findReceipt } from "../notes.js";
import { renderMarkdown, STICKY_MARKER } from "../render.js";
/** Read inputs the way a composite action passes them (INPUT_* env vars) plus the standard GITHUB_* vars. */
export function envFromProcess(e = process.env) {
    const input = (name) => e[`INPUT_${name.toUpperCase()}`] ?? e[`INPUT_${name.toUpperCase().replace(/-/g, "_")}`];
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
/** Extract the PR from an event payload, or null for non-PR events. */
export function prFromEvent(event) {
    const pr = event?.pull_request;
    if (!pr || typeof pr.number !== "number")
        return null;
    if (typeof pr.head?.sha !== "string")
        throw new Error("pull_request event has no head.sha");
    const headRepo = pr.head?.repo?.full_name;
    const baseRepo = pr.base?.repo?.full_name;
    return {
        number: pr.number,
        headSha: pr.head.sha,
        baseSha: typeof pr.base?.sha === "string" ? pr.base.sha : null,
        fromFork: typeof headRepo === "string" && typeof baseRepo === "string" && headRepo !== baseRepo,
    };
}
/** Comment body for a receipt (with the sticky marker), or null when there is none. */
export function bodyFor(receipt) {
    if (!receipt)
        return null;
    return renderMarkdown(receipt, { sticky: true });
}
/**
 * Find our sticky comment across all pages (up to 2,000 comments). A comment is
 * ours only if its body STARTS with the marker: a human quoting or mentioning
 * the marker elsewhere in a comment must never be overwritten.
 */
export async function findSticky(f, api, repo, pr, token) {
    for (let page = 1; page <= 20; page++) {
        const res = await f(`${api}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`, {
            headers: ghHeaders(token),
        });
        if (!res.ok)
            throw apiError("list comments", res);
        const items = (await res.json());
        const hit = items.find((c) => c.body?.startsWith(STICKY_MARKER));
        if (hit)
            return { id: hit.id, body: hit.body ?? "" };
        if (items.length < 100)
            return null;
    }
    return null;
}
function apiError(what, res) {
    const hint = res.status === 403 || res.status === 404
        ? " The token needs `pull-requests: write` (see README). Fork PRs get a read-only token."
        : "";
    return new Error(`${what} failed: HTTP ${res.status}.${hint}`);
}
function ghHeaders(token) {
    return {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
    };
}
/**
 * The whole action: find the newest receipt on the PR's commits, render it,
 * and create or update the one sticky comment. In dry-run it renders into the
 * log and step summary and never calls `f`.
 */
export async function run(env, f = fetch, log = console.log) {
    if (!env.eventPath)
        throw new Error("GITHUB_EVENT_PATH is not set");
    const event = JSON.parse(readFileSync(env.eventPath, "utf8"));
    const pr = prFromEvent(event);
    if (!pr) {
        log("pr-receipts: not a pull_request event, nothing to do.");
        return { action: "skip", reason: "not a pull_request event" };
    }
    if (pr.fromFork) {
        // Notes are pushed to the fork, not to this repo, and the token is read-only.
        log(`pr-receipts: PR #${pr.number} comes from a fork; receipts are not supported there. Skipping.`);
        return { action: "skip", reason: "fork" };
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
        }
        catch {
            /* summary is best-effort */
        }
    }
    if (env.output && found) {
        try {
            // sanitizeReceipt already made the headline single-line, so it cannot inject extra outputs.
            appendFileSync(env.output, `cost-usd=${found.receipt.totals.costUSD}\nheadline=${found.receipt.headline}\n`);
        }
        catch {
            /* best-effort */
        }
    }
    if (env.dryRun) {
        log(`pr-receipts: DRY RUN. Would upsert this comment on PR #${pr.number}:\n`);
        log(body);
        return { action: "skip", reason: "dry-run", body, receiptCommit: found?.commit };
    }
    if (!env.token || !env.repository)
        throw new Error("github-token and GITHUB_REPOSITORY are required unless dry-run");
    const api = env.apiUrl ?? "https://api.github.com";
    const existing = await findSticky(f, api, env.repository, pr.number, env.token);
    if (existing && existing.body.trimEnd() === body.trimEnd()) {
        log(`pr-receipts: comment ${existing.id} is already up to date.`);
        return { action: "unchanged", commentId: existing.id, body, receiptCommit: found?.commit };
    }
    if (existing) {
        const res = await f(`${api}/repos/${env.repository}/issues/comments/${existing.id}`, {
            method: "PATCH",
            headers: ghHeaders(env.token),
            body: JSON.stringify({ body }),
        });
        if (!res.ok)
            throw apiError("update comment", res);
        log(`pr-receipts: updated comment ${existing.id}`);
        return { action: "update", commentId: existing.id, body, receiptCommit: found?.commit };
    }
    const res = await f(`${api}/repos/${env.repository}/issues/${pr.number}/comments`, {
        method: "POST",
        headers: ghHeaders(env.token),
        body: JSON.stringify({ body }),
    });
    if (!res.ok)
        throw apiError("create comment", res);
    const created = (await res.json());
    log(`pr-receipts: created comment ${created.id}`);
    return { action: "create", commentId: created.id, body, receiptCommit: found?.commit };
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    run(envFromProcess()).catch((err) => {
        console.error(`::error::pr-receipts: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
    });
}

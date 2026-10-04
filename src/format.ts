// Human-readable formatting for receipts. No I/O.

import type { Receipt } from "./types.js";

/** "$4.12", or "<$0.01" for a non-zero amount that would round to zero. */
export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Compact token count: 950, 12.3k, 4.92M. */
export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  return String(n);
}

/** "30 seconds", "38 minutes", "1 hour 12 minutes". */
export function duration(ms: number): string {
  const totalMin = Math.round(ms / 60_000);
  if (ms < 60_000) {
    const sec = Math.max(0, Math.round(ms / 1000));
    return `${sec} second${sec === 1 ? "" : "s"}`;
  }
  if (totalMin < 60) return `${totalMin} minute${totalMin === 1 ? "" : "s"}`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} hour${h === 1 ? "" : "s"}${m ? ` ${m} minute${m === 1 ? "" : "s"}` : ""}`;
}

/** Agent time if Claude Code recorded turn timings, else the timestamp-based estimate. */
export function agentTime(r: Receipt): number {
  return r.totals.agentTimeMs > 0 ? r.totals.agentTimeMs : r.totals.activeTimeMs;
}

const PRETTY: Record<string, string> = {
  "claude-fable-5-1": "Fable 5.1",
  "claude-fable-5": "Fable 5",
  "claude-mythos-5-1": "Mythos 5.1",
  "claude-mythos-5": "Mythos 5",
  "claude-opus-5-5": "Opus 5.5",
  "claude-opus-5": "Opus 5",
  "claude-opus-4-8": "Opus 4.8",
  "claude-opus-4-7": "Opus 4.7",
  "claude-opus-4-6": "Opus 4.6",
  "claude-opus-4-5": "Opus 4.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-sonnet-4-6": "Sonnet 4.6",
  "claude-sonnet-4-5": "Sonnet 4.5",
  "claude-haiku-4-5": "Haiku 4.5",
};
/** Display name for a normalized model id; unknown ids are shown as-is. */
export const prettyModel = (m: string) => PRETTY[m] ?? m;

/**
 * The one-line summary. Says "at least" when some model had no price, since
 * those requests were counted as $0.
 */
export function headlineFor(r: Receipt): string {
  if (r.totals.apiRequests === 0) return "No Claude Code activity found for this PR.";
  const atLeast = r.pricing.unpricedModels.length ? "at least " : "";
  return `This PR cost ${atLeast}${money(r.totals.costUSD)} and ${duration(agentTime(r))} of agent time.`;
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { TokenCounts } from "./types.js";

export interface ModelPrice {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  fast?: { input: number; output: number };
}

export interface PricingTable {
  source: string;
  fetchedAt: string;
  webSearchPerRequest: number;
  usInferenceMultiplier: number;
  models: Record<string, ModelPrice>;
}

const here = dirname(fileURLToPath(import.meta.url));

export function defaultPricingPath(): string {
  // dist/src/pricing.js -> dist/config/pricing.json (copied at build time)
  return join(here, "..", "config", "pricing.json");
}

export function loadPricing(path = defaultPricingPath()): PricingTable {
  return JSON.parse(readFileSync(path, "utf8")) as PricingTable;
}

/**
 * Normalize a transcript model id to a pricing key:
 * "claude-opus-5-5[1m]" -> "claude-opus-5-5", "claude-haiku-4-5-20251001" -> "claude-haiku-4-5".
 */
export function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(anthropic\.|us\.anthropic\.)/, "")
    .replace(/@.*$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-v\d+(:\d+)?$/, "");
}

export function priceFor(table: PricingTable, model: string): ModelPrice | null {
  return table.models[normalizeModel(model)] ?? null;
}

/** Cost in USD for one request's tokens, or null if the model is unpriced. */
export function costOf(
  table: PricingTable,
  model: string,
  t: TokenCounts,
  opts: { speed?: string; inferenceGeo?: string; webSearches?: number } = {},
): number | null {
  const p = priceFor(table, model);
  if (!p) return null;
  let input = p.input;
  let output = p.output;
  let w5 = p.cacheWrite5m;
  let w1 = p.cacheWrite1h;
  let r = p.cacheRead;
  if (opts.speed === "fast" && p.fast) {
    // Cache multipliers stack on top of the fast-mode base price.
    const scale = p.fast.input / p.input;
    input = p.fast.input;
    output = p.fast.output;
    w5 *= scale;
    w1 *= scale;
    r *= scale;
  }
  let usd =
    (t.inputTokens * input +
      t.outputTokens * output +
      t.cacheWrite5mTokens * w5 +
      t.cacheWrite1hTokens * w1 +
      t.cacheReadTokens * r) /
    1_000_000;
  if (opts.inferenceGeo === "us") usd *= table.usInferenceMultiplier;
  usd += (opts.webSearches ?? 0) * table.webSearchPerRequest;
  return usd;
}

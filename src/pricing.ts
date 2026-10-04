// Pricing: turn token counts into USD from a config table. Prices are list
// prices per million tokens, from config/pricing.json (or --pricing <file>).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TokenCounts } from "./types.js";

/** USD per million tokens for one model. */
export interface ModelPrice {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
  /** Fast-mode base prices. Cache tiers scale by the same ratio as input. */
  fast?: { input: number; output: number };
}

/** The whole pricing config. `source` and `fetchedAt` are printed on every receipt. */
export interface PricingTable {
  source: string;
  fetchedAt: string;
  webSearchPerRequest: number;
  usInferenceMultiplier: number;
  models: Record<string, ModelPrice>;
}

const here = dirname(fileURLToPath(import.meta.url));

/** The bundled table, copied next to the compiled code at build time. */
export function defaultPricingPath(): string {
  // dist/src/pricing.js -> dist/config/pricing.json (copied at build time)
  return join(here, "..", "config", "pricing.json");
}

const PRICE_FIELDS = ["input", "cacheWrite5m", "cacheWrite1h", "cacheRead", "output"] as const;

/**
 * Load and validate a pricing table. A typo in a hand-edited file must fail
 * here, not show up later as a NaN or $0 receipt.
 */
export function loadPricing(path = defaultPricingPath()): PricingTable {
  let table: PricingTable;
  try {
    table = JSON.parse(readFileSync(path, "utf8")) as PricingTable;
  } catch (err) {
    throw new Error(`Cannot read pricing table ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const bad = (what: string) => new Error(`Invalid pricing table ${path}: ${what}`);
  const isPrice = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (typeof table?.source !== "string" || typeof table.fetchedAt !== "string")
    throw bad('needs string "source" and "fetchedAt".');
  if (!isPrice(table.webSearchPerRequest)) throw bad('"webSearchPerRequest" must be a non-negative number.');
  if (!isPrice(table.usInferenceMultiplier)) throw bad('"usInferenceMultiplier" must be a non-negative number.');
  if (!table.models || typeof table.models !== "object") throw bad('"models" must be an object.');
  for (const [model, price] of Object.entries(table.models)) {
    for (const field of PRICE_FIELDS) {
      if (!isPrice(price?.[field])) throw bad(`models["${model}"].${field} must be a non-negative number.`);
    }
    if (price.fast && (!isPrice(price.fast.input) || !isPrice(price.fast.output) || price.input === 0)) {
      throw bad(`models["${model}"].fast needs numeric input and output (and a non-zero base input).`);
    }
  }
  return table;
}

/**
 * Normalize a transcript model id to a pricing key:
 * "claude-opus-5-5[1m]" -> "claude-opus-5-5", "claude-haiku-4-5-20251001" -> "claude-haiku-4-5",
 * Bedrock "eu.anthropic.claude-sonnet-4-5-20250929-v1:0" -> "claude-sonnet-4-5",
 * Vertex "claude-opus-4-5@20251101" -> "claude-opus-4-5".
 * The version suffix is stripped before the date, because Bedrock puts it last.
 */
export function normalizeModel(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, "")
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./, "")
    .replace(/@.*$/, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/-\d{8}$/, "");
}

/** Price row for a model id, or null when the table has no entry (never guessed). */
export function priceFor(table: PricingTable, model: string): ModelPrice | null {
  return table.models[normalizeModel(model)] ?? null;
}

/**
 * Cost in USD for one request's tokens, or null if the model is unpriced.
 * Each token category is billed at its own rate: plain input, 5-minute and
 * 1-hour cache writes, cache reads, output. `inference_geo: "us"` multiplies the
 * token cost; web searches are a flat per-request fee on top.
 */
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

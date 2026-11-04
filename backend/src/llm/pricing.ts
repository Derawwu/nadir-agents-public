/**
 * Per-model token prices, in USD per million tokens.
 *
 * Cost is computed once, when a call is logged, and stored on the row — so
 * editing a price here never rewrites history. Unknown models log with a
 * null cost instead of a guess.
 *
 * Cache multipliers relative to the input price: 5-minute writes 1.25x,
 * 1-hour writes 2x, reads 0.1x — except where a model sets its own cache-read
 * price. Haiku 5.5 bills prompts over 100K tokens on a second, higher card.
 */

export interface ModelPrice {
  input: number;
  output: number;
  /** Cache-read price when it isn't 0.1x input. */
  cacheRead?: number;
  /** Rate card for prompts above longContext.threshold input tokens. */
  longContext?: { threshold: number; input: number; output: number };
}

const PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, longContext: { threshold: 100_000, input: 0.5, output: 2.5 } },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2;
const CACHE_READ = 0.1;

/** Strips a date snapshot suffix: claude-haiku-4-5-20251001 → claude-haiku-4-5. */
export function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, '');
}

export function getPrice(model: string): ModelPrice | null {
  return PRICES[normalizeModelId(model)] ?? null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
}

/** Returns the call's cost in USD, or null when the model has no price entry. */
export function computeCost(model: string, u: TokenUsage): number | null {
  const base = getPrice(model);
  if (!base) return null;
  const promptTokens = u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens;
  const card = base.longContext && promptTokens > base.longContext.threshold ? base.longContext : base;
  const readRate = base.cacheRead != null && card === base ? base.cacheRead : card.input * CACHE_READ;
  const dollars =
    u.inputTokens * card.input +
    u.cacheReadTokens * readRate +
    u.cacheWrite5mTokens * card.input * CACHE_WRITE_5M +
    u.cacheWrite1hTokens * card.input * CACHE_WRITE_1H +
    u.outputTokens * card.output;
  return dollars / 1_000_000;
}

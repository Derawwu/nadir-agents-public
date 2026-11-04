/**
 * Per-model token prices, in USD per million tokens.
 *
 * Cost is computed once, when a call is logged, and stored on the row — so
 * editing a price here never rewrites history. Unknown models log with a
 * null cost instead of a guess.
 *
 * Cache multipliers (relative to the input price) are the same on every
 * current model: 5-minute writes 1.25x, 1-hour writes 2x, reads 0.1x.
 */

export interface ModelPrice {
  input: number;
  output: number;
}

const PRICES: Record<string, ModelPrice> = {
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
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
  const price = getPrice(model);
  if (!price) return null;
  const inputUnits =
    u.inputTokens +
    u.cacheReadTokens * CACHE_READ +
    u.cacheWrite5mTokens * CACHE_WRITE_5M +
    u.cacheWrite1hTokens * CACHE_WRITE_1H;
  return (inputUnits * price.input + u.outputTokens * price.output) / 1_000_000;
}

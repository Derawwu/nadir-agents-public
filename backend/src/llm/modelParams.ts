/**
 * Per-model request extras for the Claude 5.5 generation.
 *
 * - effort: 5.x models think adaptively by default; effort is the control for
 *   how much (and so for cost and latency). Older models (Haiku 4.5) reject it.
 * - fallbacks: Opus 5.5 and Sonnet 5.5 run safety classifiers that can decline
 *   a request. With server-side fallback the API retries a declined request
 *   on a model Anthropic picks for that category, inside the same call.
 *   Haiku 5.5 has no server-side fallback, so it is never sent there.
 *
 * The SDK types effort but not `fallbacks` (a beta field), so callers spread
 * the result into the request body with a cast.
 */

import type Anthropic from '@anthropic-ai/sdk';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function parseEffort(raw: string | undefined, fallback: Effort): Effort {
  return EFFORTS.includes(raw as Effort) ? (raw as Effort) : fallback;
}

/** Models that accept output_config.effort. */
export function supportsEffort(model: string): boolean {
  return /^claude-(opus|sonnet|haiku|fable|mythos)-5/.test(model) || /^claude-opus-4-[5-8]/.test(model) || model === 'claude-sonnet-4-6';
}

/** Models that accept server-side fallbacks ("default" form). */
export function supportsFallbacks(model: string): boolean {
  return /^claude-(opus-5-5|opus-5|sonnet-5-5|fable-5-1)$/.test(model);
}

export interface ModelExtras {
  /** Extra request-body fields. */
  body: Record<string, unknown>;
  /** Extra headers (beta flags). */
  headers: Record<string, string>;
}

export function modelExtras(model: string, effort: Effort): ModelExtras {
  const body: Record<string, unknown> = {};
  const headers: Record<string, string> = {};
  if (supportsEffort(model)) body.output_config = { effort };
  if (supportsFallbacks(model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }
  return { body, headers };
}

/** Joins the text blocks of a response; thinking blocks and others are skipped. */
export function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** Message shown in place of a reply the model declined. */
export function refusalNotice(message: Anthropic.Message): string {
  const category = message.stop_details?.category ? ` (category: ${message.stop_details.category})` : '';
  return `_The model declined to answer this message${category}. Try rephrasing it, or switch this agent to another model._`;
}

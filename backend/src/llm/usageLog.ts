/**
 * Logs every Claude API call to the llm_calls table: tokens, cache usage,
 * latency, stop reason and cost. This is the data behind the Usage tab and
 * the per-chat cost badge.
 *
 * Call sites time the request themselves and hand the final Message here,
 * so streaming and non-streaming calls share one code path. Logging must
 * never break a chat, so every failure here is caught and only warned.
 */

import type Anthropic from '@anthropic-ai/sdk';
import db from '../db/connection';
import { computeCost, normalizeModelId, type TokenUsage } from './pricing';

export type CallKind = 'chat' | 'roundtable_turn' | 'roundtable_summary' | 'title' | 'chat_summary';

export interface CallMeta {
  kind: CallKind;
  agentId?: number | null;
  conversationId?: number | null;
  roundtableId?: number | null;
  /** Context strategy in effect, e.g. 'full' or 'windowed'. Null for non-chat calls. */
  strategy?: string | null;
}

export interface CallTiming {
  startedAt: number;
  firstTokenAt?: number | null;
  endedAt?: number;
}

/** Reads token counts off a response, including the 5m/1h cache-write split. */
export function extractUsage(message: Anthropic.Message): TokenUsage {
  const u = message.usage as Anthropic.Usage & {
    cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null;
  };
  const cacheWrite = u.cache_creation_input_tokens ?? 0;
  const write1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWrite1hTokens: write1h,
    cacheWrite5mTokens: Math.max(cacheWrite - write1h, 0),
  };
}

export function recordCall(meta: CallMeta, message: Anthropic.Message, timing: CallTiming): void {
  try {
    const usage = extractUsage(message);
    const endedAt = timing.endedAt ?? Date.now();
    const cost = computeCost(message.model, usage);
    db.prepare(
      `INSERT INTO llm_calls (
         kind, agent_id, conversation_id, roundtable_id, model, strategy,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         stop_reason, latency_ms, ttft_ms, cost_usd
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      meta.kind,
      meta.agentId ?? null,
      meta.conversationId ?? null,
      meta.roundtableId ?? null,
      normalizeModelId(message.model),
      meta.strategy ?? null,
      usage.inputTokens,
      usage.outputTokens,
      usage.cacheReadTokens,
      usage.cacheWrite5mTokens + usage.cacheWrite1hTokens,
      message.stop_reason ?? null,
      endedAt - timing.startedAt,
      timing.firstTokenAt != null ? timing.firstTokenAt - timing.startedAt : null,
      cost
    );
    const totalIn = usage.inputTokens + usage.cacheReadTokens + usage.cacheWrite5mTokens + usage.cacheWrite1hTokens;
    console.log(
      `[Usage] ${meta.kind} ${normalizeModelId(message.model)}: in ${totalIn} (cached ${usage.cacheReadTokens}, written ${usage.cacheWrite5mTokens + usage.cacheWrite1hTokens}), out ${usage.outputTokens}, $${cost?.toFixed(4) ?? '?'}`
    );
  } catch (err) {
    console.warn('[Usage] Failed to record call:', err instanceof Error ? err.message : err);
  }
}

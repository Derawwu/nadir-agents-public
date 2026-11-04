/**
 * Read-side queries over llm_calls for the Usage tab and the chat badge.
 */

import db from '../db/connection';
import type { CallKind } from './usageLog';

export interface UsageFilter {
  /** Range length in days; null = all time. */
  days: number | null;
  kind: CallKind | null;
}

interface Where {
  sql: string;
  args: (string | number)[];
}

/** WHERE clause for the period that is `offset` periods before the current one. */
function periodWhere(f: UsageFilter, offset = 0): Where | null {
  const parts: string[] = [];
  const args: (string | number)[] = [];
  if (f.days != null) {
    parts.push(`created_at >= datetime('now', ?)`, `created_at < datetime('now', ?)`);
    args.push(`-${f.days * (offset + 1)} days`, offset === 0 ? '+1 day' : `-${f.days * offset} days`);
  } else if (offset > 0) {
    return null; // "previous period" is undefined for all-time
  }
  if (f.kind) {
    parts.push('kind = ?');
    args.push(f.kind);
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
}

interface TotalsRow {
  calls: number;
  cost: number | null;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
}

function totals(w: Where) {
  const r = db
    .prepare(
      `SELECT COUNT(*) AS calls, SUM(cost_usd) AS cost, SUM(input_tokens) AS input,
              SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read,
              SUM(cache_write_tokens) AS cache_write
       FROM llm_calls ${w.sql}`
    )
    .get(...w.args) as unknown as TotalsRow;
  const input = r.input ?? 0;
  const cacheRead = r.cache_read ?? 0;
  const cacheWrite = r.cache_write ?? 0;
  const totalIn = input + cacheRead + cacheWrite;
  return {
    calls: r.calls,
    cost: r.cost ?? 0,
    inputTokens: totalIn,
    outputTokens: r.output ?? 0,
    cacheReadTokens: cacheRead,
    cacheHitRate: totalIn > 0 ? cacheRead / totalIn : null,
  };
}

export function getUsageSummary(f: UsageFilter) {
  const w = periodWhere(f)!;
  const prev = periodWhere(f, 1);
  const and = (extra: string) => (w.sql ? `${w.sql} AND ${extra}` : `WHERE ${extra}`);

  const current = totals(w);
  const previous = prev ? totals(prev) : null;

  // Average cost of one chat reply, split by context strategy, so the effect
  // of windowing shows up as a before/after pair.
  const perMessage = db
    .prepare(
      `SELECT COALESCE(strategy, 'full') AS strategy, COUNT(*) AS calls, AVG(cost_usd) AS avg_cost,
              AVG(input_tokens + cache_read_tokens + cache_write_tokens) AS avg_input
       FROM llm_calls ${and(`kind = 'chat'`)}
       GROUP BY COALESCE(strategy, 'full')`
    )
    .all(...w.args) as unknown as { strategy: string; calls: number; avg_cost: number | null; avg_input: number | null }[];

  const daily = db
    .prepare(
      `SELECT date(l.created_at, 'localtime') AS day, a.name AS agentName, SUM(l.cost_usd) AS cost
       FROM llm_calls l LEFT JOIN agents a ON a.id = l.agent_id
       ${w.sql.replace(/\b(created_at|kind)\b/g, 'l.$1')}
       GROUP BY day, a.name
       ORDER BY day ASC`
    )
    .all(...w.args) as unknown as { day: string; agentName: string | null; cost: number | null }[];

  const byModel = db
    .prepare(
      `SELECT model, COUNT(*) AS calls, SUM(cost_usd) AS cost
       FROM llm_calls ${w.sql}
       GROUP BY model ORDER BY cost DESC`
    )
    .all(...w.args) as unknown as { model: string; calls: number; cost: number | null }[];

  const byKind = db
    .prepare(
      `SELECT kind, COUNT(*) AS calls, SUM(cost_usd) AS cost
       FROM llm_calls ${w.sql}
       GROUP BY kind ORDER BY cost DESC`
    )
    .all(...w.args) as unknown as { kind: string; calls: number; cost: number | null }[];

  const topChats = db
    .prepare(
      `SELECT l.conversation_id AS id, c.title, c.slug, c.agent_id AS agentId, a.name AS agentName,
              SUM(CASE WHEN l.kind = 'chat' THEN 1 ELSE 0 END) AS replies,
              AVG(CASE WHEN l.kind = 'chat' THEN l.input_tokens + l.cache_read_tokens + l.cache_write_tokens END) AS avgInput,
              SUM(l.cache_read_tokens) * 1.0 / NULLIF(SUM(l.input_tokens + l.cache_read_tokens + l.cache_write_tokens), 0) AS cacheRate,
              SUM(l.cost_usd) AS cost
       FROM llm_calls l
       JOIN conversations c ON c.id = l.conversation_id
       JOIN agents a ON a.id = c.agent_id
       ${w.sql.replace(/\b(created_at|kind)\b/g, 'l.$1')}${w.sql ? ' AND' : ' WHERE'} c.deleted_at IS NULL
       GROUP BY l.conversation_id
       ORDER BY cost DESC
       LIMIT 8`
    )
    .all(...w.args) as unknown as {
    id: number; title: string; slug: string; agentId: number; agentName: string;
    replies: number; avgInput: number | null; cacheRate: number | null; cost: number | null;
  }[];

  const topRoundtables = db
    .prepare(
      `SELECT l.roundtable_id AS id, r.topic, COUNT(*) AS calls,
              SUM(l.cache_read_tokens) * 1.0 / NULLIF(SUM(l.input_tokens + l.cache_read_tokens + l.cache_write_tokens), 0) AS cacheRate,
              SUM(l.cost_usd) AS cost
       FROM llm_calls l
       JOIN roundtables r ON r.id = l.roundtable_id
       ${w.sql.replace(/\b(created_at|kind)\b/g, 'l.$1')}
       GROUP BY l.roundtable_id
       ORDER BY cost DESC
       LIMIT 4`
    )
    .all(...w.args) as unknown as { id: number; topic: string; calls: number; cacheRate: number | null; cost: number | null }[];

  // First windowed call ever: drawn as a marker on the daily chart.
  const windowedSince = db
    .prepare(`SELECT date(MIN(created_at), 'localtime') AS day FROM llm_calls WHERE strategy = 'windowed'`)
    .get() as { day: string | null } | undefined;

  return {
    range: { days: f.days, kind: f.kind },
    totals: current,
    previous,
    perMessage,
    daily,
    byModel,
    byKind,
    topChats,
    topRoundtables,
    windowedSince: windowedSince?.day ?? null,
  };
}

export function getChatUsage(conversationId: number) {
  const total = db
    .prepare(`SELECT COUNT(*) AS calls, SUM(cost_usd) AS cost FROM llm_calls WHERE conversation_id = ?`)
    .get(conversationId) as { calls: number; cost: number | null };
  const last = db
    .prepare(
      `SELECT input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, strategy, created_at
       FROM llm_calls WHERE conversation_id = ? AND kind = 'chat'
       ORDER BY id DESC LIMIT 1`
    )
    .get(conversationId) as
    | { input_tokens: number; cache_read_tokens: number; cache_write_tokens: number; output_tokens: number; cost_usd: number | null; strategy: string | null; created_at: string }
    | undefined;
  const lastInput = last ? last.input_tokens + last.cache_read_tokens + last.cache_write_tokens : null;
  return {
    calls: total.calls,
    cost: total.cost ?? 0,
    last: last
      ? {
          inputTokens: lastInput,
          outputTokens: last.output_tokens,
          cacheHitRate: lastInput ? last.cache_read_tokens / lastInput : null,
          cost: last.cost_usd,
          strategy: last.strategy,
          at: last.created_at,
        }
      : null,
  };
}

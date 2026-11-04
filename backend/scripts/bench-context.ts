/**
 * Context benchmark: what one more message would cost in each chat under
 * three request layouts, measured on the real chat history in the database.
 *
 *   legacy    original layout: whole history every turn, volatile memories in
 *             the system prompt, no working cache point
 *   full      new cache-friendly layout, whole history verbatim
 *   windowed  new layout + running summary (the default)
 *
 * Token totals come from Anthropic's token-counting endpoint (free, no model
 * call). The split between cached and uncached tokens is estimated by
 * character share, and only input cost is compared: output is the same in
 * every layout.
 *
 * Usage (from backend/):
 *   npx tsx scripts/bench-context.ts              # measure only
 *   npx tsx scripts/bench-context.ts --summarize  # first build missing chat
 *                                                 # summaries (calls the summary model)
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import db from '../src/db/connection';
import { runMigrations } from '../src/db/schema';
import { getAgentById } from '../src/agents/agentService';
import { getModelForAgent, normalizeAgentRole } from '../src/agents/modelConfig';
import { getFeatureById } from '../src/features/featureService';
import { formatMemoriesForPrompt, getMemoriesForContext } from '../src/agents/memoryService';
import {
  buildCachedSystemParam,
  buildChatContext,
  buildSystemBlocks,
  getHistoryRows,
} from '../src/agents/promptBuilder';
import { maybeUpdateSummary } from '../src/chat/chatSummary';
import { getPrice, normalizeModelId } from '../src/llm/pricing';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PROBE = 'Benchmark probe: what should we tackle next?';

interface Conv {
  id: number;
  agent_id: number;
  feature_id: number | null;
  title: string;
  n: number;
}

function chars(x: unknown): number {
  return JSON.stringify(x).length;
}

async function count(model: string, system: TextBlockParam[], messages: MessageParam[]): Promise<number> {
  // Images are counted by the API too; strip cache_control, which count_tokens ignores anyway.
  const r = await anthropic.messages.countTokens({ model, system, messages });
  return r.input_tokens;
}

/** Original request layout, rebuilt for comparison. */
async function legacyRequest(conv: Conv, prompt: string, role: ReturnType<typeof normalizeAgentRole>) {
  const feature = conv.feature_id ? (getFeatureById(conv.feature_id) ?? null) : null;
  const memories = getMemoriesForContext({ agentId: conv.agent_id, featureId: conv.feature_id, conversationId: conv.id });
  const parts = await buildSystemBlocks(prompt, feature, formatMemoriesForPrompt(memories), role);
  const system = buildCachedSystemParam(parts);
  const messages: MessageParam[] = getHistoryRows(conv.id).map((r) => ({ role: r.role, content: r.content || ' ' }));
  messages.push({ role: 'user', content: PROBE });
  return { system, messages };
}

function usd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(3)}`;
}

async function main() {
  runMigrations();
  const summarizeFirst = process.argv.includes('--summarize');
  const convs = db
    .prepare(
      `SELECT c.id, c.agent_id, c.feature_id, c.title, COUNT(m.id) AS n
       FROM conversations c JOIN messages m ON m.conversation_id = c.id
       WHERE c.deleted_at IS NULL
       GROUP BY c.id HAVING n >= 4 ORDER BY n DESC`
    )
    .all() as unknown as Conv[];

  const rows: string[] = [];
  for (const conv of convs) {
    const agent = getAgentById(conv.agent_id);
    if (!agent) continue;
    const role = normalizeAgentRole(agent.role);
    const model = getModelForAgent(role);
    const price = getPrice(model);
    if (!price) {
      console.warn(`No price for ${model}, skipping chat ${conv.id}`);
      continue;
    }
    if (summarizeFirst) await maybeUpdateSummary(conv.id, conv.agent_id);

    const base = {
      agentSystemPrompt: agent.system_prompt,
      agentId: conv.agent_id,
      agentRole: role,
      featureId: conv.feature_id,
      conversationId: conv.id,
      userMessage: PROBE,
    };

    // legacy: everything billed at the full input price.
    const legacy = await legacyRequest(conv, agent.system_prompt, role);
    const legacyTokens = await count(model, legacy.system, legacy.messages);
    const legacyCost = (legacyTokens * price.input) / 1e6;

    // new layouts: warm cache reads the prefix up to the previous exchange,
    // writes the last exchange, and pays full price for the new turn.
    const measure = async (strategy: 'full' | 'windowed') => {
      const req = await buildChatContext({ ...base, strategy });
      const tokens = await count(model, req.system, req.messages);
      const msgs = req.messages;
      const total = chars(req.system) + chars(msgs);
      const newTurn = chars(msgs[msgs.length - 1]);
      const lastExchange = msgs.length >= 3 ? chars(msgs[msgs.length - 2]) + chars(msgs[msgs.length - 3]) : 0;
      const perChar = tokens / total;
      const write = lastExchange * perChar;
      const fresh = newTurn * perChar;
      const read = Math.max(tokens - write - fresh, 0);
      const warm = ((read * 0.1 + write * 1.25 + fresh) * price.input) / 1e6;
      const cold = ((tokens - fresh) * 1.25 * price.input + fresh * price.input) / 1e6;
      return { tokens, warm, cold, verbatim: req.verbatimCount, summarized: req.summarized };
    };
    const full = await measure('full');
    const windowed = await measure('windowed');

    const saving = 1 - windowed.warm / legacyCost;
    rows.push(
      `| ${conv.title} (${agent.name}, ${normalizeModelId(model)}) | ${conv.n} | ${legacyTokens.toLocaleString('en-US')} / ${usd(legacyCost)} | ${full.tokens.toLocaleString('en-US')} / ${usd(full.warm)} | ${windowed.tokens.toLocaleString('en-US')} / ${usd(windowed.warm)} (cold ${usd(windowed.cold)})${windowed.summarized ? '' : ' *'} | ${(saving * 100).toFixed(0)}% |`
    );
  }

  console.log(`\nInput tokens / estimated input cost of the next message, ${new Date().toISOString().slice(0, 10)}\n`);
  console.log('| Chat | Messages | Legacy | Full + cache (warm) | Windowed + cache (warm) | Saving vs legacy |');
  console.log('|---|---|---|---|---|---|');
  rows.forEach((r) => console.log(r));
  console.log('\n* no summary yet for this chat (short enough, or run with --summarize)\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

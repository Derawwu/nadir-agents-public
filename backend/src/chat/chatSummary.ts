/**
 * Running chat summary for history windowing.
 *
 * Chat requests send the messages after summary_upto_message_id verbatim and
 * the summary in their place for everything older (see buildChatContext).
 * After each reply, this module checks the verbatim tail; once it grows past
 * HISTORY_TOKEN_BUDGET + SUMMARY_BATCH_TOKENS, the oldest messages are folded
 * into the summary until the tail is back near the budget.
 *
 * Updating in batches rather than every turn matters for caching: each update
 * changes the system prompt and so invalidates the cached prefix once. With
 * the defaults that happens roughly every 10k tokens of conversation.
 */

import Anthropic from '@anthropic-ai/sdk';
import db from '../db/connection';
import { getChatSummary, getHistoryRows, type HistoryRow } from '../agents/promptBuilder';
import {
  estimateTokens,
  getContextStrategy,
  getHistoryTokenBudget,
  getSummaryBatchTokens,
  getSummaryModel,
  IMAGE_TOKEN_ESTIMATE,
} from '../agents/contextConfig';
import { recordCall } from '../llm/usageLog';
import { modelExtras } from '../llm/modelParams';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** Largest slice of history folded into the summary in one model call. */
const MAX_TOKENS_PER_PASS = 100_000;

const inFlight = new Set<number>();

function rowTokens(row: HistoryRow): number {
  const images = row.images ? (JSON.parse(row.images) as unknown[]).length : 0;
  return estimateTokens(row.content) + images * IMAGE_TOKEN_ESTIMATE + 4;
}

function formatTranscript(rows: HistoryRow[]): string {
  return rows
    .map((r) => {
      const images = r.images ? (JSON.parse(r.images) as unknown[]).length : 0;
      const note = images > 0 ? ` [${images} image${images > 1 ? 's' : ''} attached]` : '';
      return `<${r.role}>${note}\n${r.content}\n</${r.role}>`;
    })
    .join('\n\n');
}

async function summarize(
  previous: string | null,
  rows: HistoryRow[],
  meta: { conversationId: number; agentId: number }
): Promise<string> {
  const model = getSummaryModel();
  const prompt = `You maintain the running summary of a long chat between a solo game developer (the user) and one of their AI team members (the assistant). The summary replaces older messages in the assistant's context, so anything you leave out is forgotten.

${previous ? `<current_summary>\n${previous}\n</current_summary>\n\n` : ''}<new_messages>
${formatTranscript(rows)}
</new_messages>

Write the updated summary${previous ? ', merging the new messages into the current summary' : ''}. Use these sections, and leave a section out if it has nothing:

## Decisions
What was agreed or decided, and why when the reason matters.
## Facts and lore
Names, worldbuilding facts, technical details, numbers and identifiers, exactly as stated.
## User preferences and requests
How the user wants things done, and what they asked for.
## Open questions
Unresolved points and pending follow-ups.
## Thread so far
A few sentences on how the conversation developed, ending with where it left off.

Rules: keep exact names, terms and identifiers. Drop small talk and anything later superseded. Stay under 1,200 words. Output only the summary.`;

  const startedAt = Date.now();
  const response = await anthropic.messages.create({
    model,
    max_tokens: 8000,
    ...(modelExtras(model, 'low').body as object),
    messages: [{ role: 'user', content: prompt }],
  });
  recordCall({ kind: 'chat_summary', agentId: meta.agentId, conversationId: meta.conversationId }, response, { startedAt });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('Summary model returned no text');
  if (response.stop_reason === 'max_tokens') {
    console.warn('[Summary] Summary hit max_tokens; keeping the truncated text');
  }
  return text;
}

/**
 * Folds old messages into the chat summary when the verbatim tail is too
 * long. Safe to call after every reply: it returns immediately when there is
 * nothing to do or when a run for this chat is already in progress.
 */
export async function maybeUpdateSummary(conversationId: number, agentId: number): Promise<void> {
  if (getContextStrategy() !== 'windowed' || inFlight.has(conversationId)) return;
  inFlight.add(conversationId);
  try {
    const budget = getHistoryTokenBudget();
    const threshold = budget + getSummaryBatchTokens();

    // Loop so a very long chat is caught up in a few passes.
    for (;;) {
      const { summary, uptoMessageId } = getChatSummary(conversationId);
      const rows = getHistoryRows(conversationId).filter((r) => r.id > uptoMessageId);
      const sizes = rows.map(rowTokens);
      let remaining = sizes.reduce((a, b) => a + b, 0);
      if (remaining <= threshold) return;

      // Take the oldest messages until the tail fits the budget...
      let cut = 0;
      let passTokens = 0;
      while (cut < rows.length && remaining > budget && passTokens < MAX_TOKENS_PER_PASS) {
        remaining -= sizes[cut];
        passTokens += sizes[cut];
        cut++;
      }
      // ...then move the cut forward so the verbatim tail starts on a user turn.
      while (cut < rows.length && rows[cut].role !== 'user') cut++;
      if (cut === 0) return;

      const slice = rows.slice(0, cut);
      console.log(`[Summary] Chat ${conversationId}: folding ${slice.length} messages (~${passTokens} tokens) into the summary`);
      const updated = await summarize(summary, slice, { conversationId, agentId });
      db.prepare('UPDATE conversations SET summary = ?, summary_upto_message_id = ? WHERE id = ?').run(
        updated,
        slice[slice.length - 1].id,
        conversationId
      );
    }
  } catch (err) {
    console.warn(`[Summary] Chat ${conversationId}: update failed, history stays verbatim:`, err instanceof Error ? err.message : err);
  } finally {
    inFlight.delete(conversationId);
  }
}

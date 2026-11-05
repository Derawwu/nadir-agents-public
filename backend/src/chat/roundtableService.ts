/**
 * Roundtable orchestration service.
 *
 * A roundtable is a structured multi-agent discussion with a fixed agent order,
 * conflict detection, and automatic summarization on termination.
 *
 * Agent order: Narrator → Architect → UX/UI → Analyst
 *
 * Flow per round:
 *   - Each agent responds in order, seeing all prior turns
 *   - After all 4 respond, check for conflicts
 *   - No conflicts → complete; conflicts + rounds remaining → next round;
 *     conflicts + max rounds hit → terminate
 *
 * After termination: a summarization API call (no agent persona) produces
 * decisions, open conflicts, and action items, then saves them as 'decision'
 * memories for each relevant agent.
 *
 * State is fully stateless between calls — all state is in SQLite.
 *
 * node:sqlite rows are cast via `as` assertions throughout — safe because
 * schema is controlled and does not change at runtime.
 */

import Anthropic from '@anthropic-ai/sdk';
import db from '../db/connection';
import { getAllAgents, getAgentByName, type Agent } from '../agents/agentService';
import { buildRoundtableContext } from '../agents/promptBuilder';
import { saveMemory } from '../agents/memoryService';
import { getFeatureById } from '../features/featureService';
import { saveRoundtableSummary } from '../outline/outlineService';
import { addIssueComment } from '../plane/planeService';
import { getEffortForAgent, getModelForAgent, normalizeAgentRole, ROUNDTABLE_SUMMARY_MODEL } from '../agents/modelConfig';
import { modelExtras, refusalNotice, textOf, type Effort } from '../llm/modelParams';
import { recordCall, type CallMeta } from '../llm/usageLog';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});


// Canonical agent order for roundtable discussions.
const AGENT_ORDER = ['Narrator', 'Architect', 'UX/UI', 'Analyst'] as const;

export interface RoundtableRow {
  id: number;
  feature_id: number;
  topic: string;
  status: string;
  current_round: number;
  max_rounds: number;
  created_at: string;
  updated_at: string;
}

export interface RoundtableTurnRow {
  id: number;
  roundtable_id: number;
  agent_id: number;
  round_number: number;
  content: string;
  has_conflict: number;
  conflict_target_agent_id: number | null;
  conflict_summary: string | null;
  created_at: string;
  agent_name: string;
}

export interface RoundtableSummary {
  decisions: string[];
  openConflicts: string[];
  actionItems: Record<string, string[]>;
}

export interface RoundtableResult {
  roundtableId: number;
  status: 'completed' | 'terminated';
  summary: RoundtableSummary;
}

/**
 * Parses a [CONFLICT:agent_name] block from agent response text.
 *
 * Pattern is forgiving of whitespace variance in the conflict block.
 * Returns null if no conflict block is present.
 */
function parseConflict(content: string): {
  targetAgentName: string;
  summary: string;
} | null {
  const match = content.match(
    /\[CONFLICT:\s*([^\]]+?)\s*\]\s*([\s\S]*?)\s*\[\/CONFLICT\]/i
  );
  if (!match) return null;
  return {
    targetAgentName: match[1].trim(),
    summary: match[2].trim(),
  };
}

/**
 * Streams a single agent turn, accumulating the full response.
 */
async function streamAgentTurn(
  system: Anthropic.TextBlockParam[],
  messages: Anthropic.MessageParam[],
  model: string,
  effort: Effort,
  meta: CallMeta,
  onChunk: (chunk: string) => void
): Promise<string> {
  let full = '';
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;

  const extras = modelExtras(model, effort);
  const stream = anthropic.messages.stream(
    {
      model,
      max_tokens: 16000,
      system,
      messages,
      ...extras.body,
    } as Anthropic.MessageStreamParams,
    { headers: extras.headers }
  );

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      firstTokenAt ??= Date.now();
      const chunk = event.delta.text;
      full += chunk;
      onChunk(chunk);
    }
  }

  const finalMessage = await stream.finalMessage();
  recordCall(meta, finalMessage, { startedAt, firstTokenAt });
  if (finalMessage.stop_reason === 'max_tokens') {
    console.warn(`[Roundtable] Response truncated by max_tokens limit (model: ${model})`);
  }
  if ((finalMessage.stop_reason as string) === 'refusal') {
    const notice = refusalNotice(finalMessage);
    const sep = full ? '\n\n' : '';
    full += sep + notice;
    onChunk(sep + notice);
  }

  return full;
}

function getTurns(roundtableId: number): RoundtableTurnRow[] {
  return db
    .prepare(
      `SELECT rt.*, a.name as agent_name
       FROM roundtable_turns rt
       JOIN agents a ON rt.agent_id = a.id
       WHERE rt.roundtable_id = ?
       ORDER BY rt.round_number ASC, rt.id ASC`
    )
    .all(roundtableId) as unknown as RoundtableTurnRow[];
}

/**
 * Runs the summarization pass after a roundtable completes or terminates.
 * Uses a plain Anthropic call (no agent persona) to produce structured output.
 * Persists summary as 'decision' memories for all agents.
 */
async function summarizeRoundtable(
  roundtableId: number,
  featureId: number,
  topic: string,
  agents: Agent[]
): Promise<RoundtableSummary> {
  const turns = getTurns(roundtableId);

  const transcript = turns
    .map((t) => `### ${t.agent_name} (Round ${t.round_number})\n${t.content}`)
    .join('\n\n');

  const prompt = `You are a neutral facilitator synthesizing a roundtable discussion.

Topic: ${topic}

Transcript:
${transcript}

Produce a structured summary in this exact JSON format (no markdown wrapper):
{
  "decisions": ["string array of consensus items reached"],
  "openConflicts": ["string array of unresolved items requiring developer decision"],
  "actionItems": {
    "Narrator": ["action items for Narrator"],
    "Architect": ["action items for Architect"],
    "UX/UI": ["action items for UX/UI"],
    "Analyst": ["action items for Analyst"]
  }
}

Be precise. Empty arrays are valid if no items apply. Do not invent items not present in the transcript.`;

  const startedAt = Date.now();
  const summaryExtras = modelExtras(ROUNDTABLE_SUMMARY_MODEL, 'medium');
  const response = await anthropic.messages.create({
    model: ROUNDTABLE_SUMMARY_MODEL,
    max_tokens: 8000,
    ...(summaryExtras.body as object),
    messages: [{ role: 'user', content: prompt }],
  }, { headers: summaryExtras.headers });

  recordCall({ kind: 'roundtable_summary', roundtableId }, response, { startedAt });

  // Tolerate a fenced reply: take the outermost JSON object.
  const text = textOf(response);
  const rawText = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) || '{}';

  let summary: RoundtableSummary;
  try {
    summary = JSON.parse(rawText) as RoundtableSummary;
  } catch {
    // Malformed JSON — produce a safe fallback rather than crashing.
    summary = {
      decisions: [],
      openConflicts: ['Summary parsing failed — review transcript manually.'],
      actionItems: { Narrator: [], Architect: [], 'UX/UI': [], Analyst: [] },
    };
  }

  const summaryContent = `Roundtable on "${topic}".\nDecisions: ${summary.decisions.join('; ') || 'None'}.\nOpen conflicts: ${summary.openConflicts.join('; ') || 'None'}.`;

  for (const agent of agents) {
    const agentActions =
      summary.actionItems[agent.name as keyof typeof summary.actionItems] ?? [];
    const agentContent =
      agentActions.length > 0
        ? `${summaryContent}\nYour action items: ${agentActions.join('; ')}`
        : summaryContent;

    saveMemory({
      agentId: agent.id,
      featureId,
      scope: 'feature',
      source: 'roundtable',
      type: 'decision',
      content: agentContent,
    });
  }

  return summary;
}

const MAX_ROUNDS_PER_SESSION = 3;

function resolveOrderedAgents(agentIds?: number[]): Agent[] {
  const allAgents = getAllAgents();

  const canonicalOrder: Agent[] = AGENT_ORDER.map((name) => {
    const agent = allAgents.find((a) => a.name === name);
    if (!agent) {
      console.warn(`Roundtable: agent "${name}" not found in DB — skipping.`);
    }
    return agent;
  }).filter((a): a is Agent => a !== undefined);

  return agentIds && agentIds.length > 0
    ? canonicalOrder.filter((a) => agentIds.includes(a.id))
    : canonicalOrder;
}

/**
 * Runs a bounded sequence of discussion rounds (a "session") for an existing
 * roundtable row, starting at `startRound`. Each round has every agent respond
 * in order, seeing the full turn history (including prior sessions). Stops when
 * a round produces no conflicts, or after MAX_ROUNDS_PER_SESSION rounds.
 */
async function runDiscussionSession(params: {
  roundtableId: number;
  featureId: number;
  topic: string;
  orderedAgents: Agent[];
  startRound: number;
  onEvent: (event: string) => void;
}): Promise<'completed' | 'terminated'> {
  const { roundtableId, featureId, topic, orderedAgents, onEvent } = params;
  let currentRound = params.startRound;
  const maxRound = params.startRound + MAX_ROUNDS_PER_SESSION - 1;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    onEvent(`data: ${JSON.stringify({ type: 'round_start', round: currentRound })}\n\n`);

    const priorTurns = getTurns(roundtableId).map((t) => ({
      agentName: t.agent_name,
      round: t.round_number,
      content: t.content,
    }));

    for (const agent of orderedAgents) {
      onEvent(
        `data: ${JSON.stringify({ type: 'agent_start', agentId: agent.id, agentName: agent.name, round: currentRound })}\n\n`
      );

      const agentRole = normalizeAgentRole(agent.role);

      const { system, messages } = await buildRoundtableContext({
        agentSystemPrompt: agent.system_prompt,
        agentId: agent.id,
        agentRole,
        featureId,
        topic,
        priorTurns,
      });
      const model = getModelForAgent(agentRole);
      console.log(`[${agentRole}] Using model: ${model}`);

      const agentResponse = await streamAgentTurn(system, messages, model, getEffortForAgent(agentRole), { kind: 'roundtable_turn', agentId: agent.id, roundtableId }, (chunk) => {
        onEvent(
          `data: ${JSON.stringify({ type: 'chunk', agentId: agent.id, agentName: agent.name, round: currentRound, chunk })}\n\n`
        );
      });

      const conflict = parseConflict(agentResponse);
      let conflictTargetId: number | null = null;

      if (conflict) {
        const targetAgent = getAgentByName(conflict.targetAgentName);
        conflictTargetId = targetAgent?.id ?? null;
      }

      db.prepare(
        `INSERT INTO roundtable_turns
           (roundtable_id, agent_id, round_number, content, has_conflict, conflict_target_agent_id, conflict_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        roundtableId,
        agent.id,
        currentRound,
        agentResponse,
        conflict ? 1 : 0,
        conflictTargetId,
        conflict?.summary ?? null
      );

      priorTurns.push({
        agentName: agent.name,
        round: currentRound,
        content: agentResponse,
      });

      onEvent(
        `data: ${JSON.stringify({
          type: 'agent_done',
          agentId: agent.id,
          agentName: agent.name,
          round: currentRound,
          hasConflict: !!conflict,
          conflictSummary: conflict?.summary ?? null,
          conflictTarget: conflict?.targetAgentName ?? null,
        })}\n\n`
      );
    }

    const conflictCount = (db
      .prepare(
        `SELECT COUNT(*) as count FROM roundtable_turns
         WHERE roundtable_id = ? AND round_number = ? AND has_conflict = 1`
      )
      .get(roundtableId, currentRound) as { count: number } | undefined)?.count ?? 0;

    if (conflictCount === 0) return 'completed';
    if (currentRound >= maxRound) return 'terminated';

    currentRound += 1;
    db.prepare(
      `UPDATE roundtables SET current_round = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(currentRound, roundtableId);
  }
}

/** Short roundtable outcome for a Plane comment; the full write-up is in the wiki. */
function formatSummaryComment(topic: string, summary: RoundtableSummary, wikiUrl: string | null): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- None');
  const actions = Object.entries(summary.actionItems)
    .filter(([, items]) => items.length > 0)
    .map(([agent, items]) => items.map((i) => `- ${agent}: ${i}`).join('\n'))
    .join('\n');
  return [
    `## Roundtable: ${topic}`,
    '',
    '### Decisions',
    list(summary.decisions),
    '',
    '### Open conflicts',
    list(summary.openConflicts),
    '',
    '### Action items',
    actions || '- None',
    ...(wikiUrl ? ['', `Full summary: ${wikiUrl}`] : []),
  ].join('\n');
}

/**
 * Finalizes a discussion session: persists status, summarizes the full
 * transcript so far, saves to Outline, and emits the closing SSE events.
 */
async function finishRoundtableSession(params: {
  roundtableId: number;
  featureId: number;
  topic: string;
  orderedAgents: Agent[];
  finalStatus: 'completed' | 'terminated';
  onEvent: (event: string) => void;
}): Promise<RoundtableSummary> {
  const { roundtableId, featureId, topic, orderedAgents, finalStatus, onEvent } = params;

  db.prepare(
    `UPDATE roundtables SET status = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(finalStatus, roundtableId);

  onEvent(`data: ${JSON.stringify({ type: 'roundtable_done', status: finalStatus })}\n\n`);
  onEvent(`data: ${JSON.stringify({ type: 'summarizing' })}\n\n`);

  const summary = await summarizeRoundtable(roundtableId, featureId, topic, orderedAgents);

  let outlineSaved = false;
  let wikiUrl: string | null = null;
  const feature = getFeatureById(featureId);
  try {
    if (feature) {
      const doc = await saveRoundtableSummary({
        featureName: feature.name,
        topic,
        summary: '',
        decisions: summary.decisions,
        conflicts: summary.openConflicts,
        actionItems: summary.actionItems,
        agentRoles: orderedAgents.map((a) => normalizeAgentRole(a.role)),
      });
      outlineSaved = true;
      wikiUrl = `${(process.env.OUTLINE_BASE_URL ?? 'http://localhost:3002').replace(/\/$/, '')}${doc.url}`;
    }
  } catch (err) {
    console.error(
      '[Outline] Failed to save roundtable summary:',
      err instanceof Error ? err.message : err
    );
  }

  // Leave the outcome on the Plane work item the discussion was about, so it
  // is visible where the work is tracked. Best effort, like the wiki save.
  let planeCommented = false;
  if (feature?.jira_type === 'issue') {
    try {
      await addIssueComment('narrator', featureId, formatSummaryComment(topic, summary, wikiUrl));
      planeCommented = true;
    } catch (err) {
      console.error(
        '[Plane] Failed to comment roundtable summary:',
        err instanceof Error ? err.message : err
      );
    }
  }

  onEvent(`data: ${JSON.stringify({ type: 'summary', summary, outline: { saved: outlineSaved }, plane: { commented: planeCommented } })}\n\n`);

  return summary;
}

export interface StartRoundtableParams {
  featureId: number;
  topic: string;
  /** Agent IDs to include in the discussion. Defaults to all agents in canonical order. */
  agentIds?: number[];
  onEvent: (event: string) => void;
}

/**
 * Main roundtable orchestration entry point.
 */
export async function startRoundtable(
  params: StartRoundtableParams
): Promise<RoundtableResult> {
  const { featureId, topic, agentIds, onEvent } = params;

  const orderedAgents = resolveOrderedAgents(agentIds);
  if (orderedAgents.length === 0) {
    throw new Error('No valid agents selected for roundtable');
  }

  const rtResult = db
    .prepare('INSERT INTO roundtables (feature_id, topic) VALUES (?, ?)')
    .run(featureId, topic);

  const roundtableId = Number(rtResult.lastInsertRowid);

  onEvent(`data: ${JSON.stringify({ type: 'roundtable_created', roundtableId })}\n\n`);

  const finalStatus = await runDiscussionSession({
    roundtableId,
    featureId,
    topic,
    orderedAgents,
    startRound: 1,
    onEvent,
  });

  const summary = await finishRoundtableSession({
    roundtableId,
    featureId,
    topic,
    orderedAgents,
    finalStatus,
    onEvent,
  });

  return { roundtableId, status: finalStatus, summary };
}

export interface ContinueRoundtableParams {
  roundtableId: number;
  message: string;
  /** Agent IDs to include in this session. Defaults to whichever agents already participated. */
  agentIds?: number[];
  onEvent: (event: string) => void;
}

/**
 * Sends a follow-up message into an existing (completed/terminated) roundtable.
 * Runs another bounded session of rounds, appended to the existing turn history,
 * then re-summarizes over the full transcript.
 */
export async function continueRoundtable(
  params: ContinueRoundtableParams
): Promise<RoundtableResult> {
  const { roundtableId, message, agentIds, onEvent } = params;

  const roundtable = db
    .prepare('SELECT * FROM roundtables WHERE id = ?')
    .get(roundtableId) as RoundtableRow | undefined;

  if (!roundtable) throw new Error(`Roundtable not found: ${roundtableId}`);
  if (roundtable.status === 'active') {
    throw new Error('Roundtable is already active');
  }

  const existingTurns = getTurns(roundtableId);
  const participantIds = agentIds ?? [...new Set(existingTurns.map((t) => t.agent_id))];
  const orderedAgents = resolveOrderedAgents(
    participantIds.length > 0 ? participantIds : undefined
  );
  if (orderedAgents.length === 0) {
    throw new Error('No valid agents selected for roundtable');
  }

  const startRound = Math.max(0, ...existingTurns.map((t) => t.round_number)) + 1;

  db.prepare(
    `UPDATE roundtables SET status = 'active', updated_at = datetime('now') WHERE id = ?`
  ).run(roundtableId);

  const finalStatus = await runDiscussionSession({
    roundtableId,
    featureId: roundtable.feature_id,
    topic: message,
    orderedAgents,
    startRound,
    onEvent,
  });

  const summary = await finishRoundtableSession({
    roundtableId,
    featureId: roundtable.feature_id,
    topic: roundtable.topic,
    orderedAgents,
    finalStatus,
    onEvent,
  });

  return { roundtableId, status: finalStatus, summary };
}

export function getRoundtableById(id: number): {
  roundtable: RoundtableRow;
  turns: RoundtableTurnRow[];
} | null {
  const roundtable = db
    .prepare('SELECT * FROM roundtables WHERE id = ?')
    .get(id) as RoundtableRow | undefined;

  if (!roundtable) return null;

  const turns = getTurns(id);
  return { roundtable, turns };
}

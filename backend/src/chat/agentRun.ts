/**
 * The agent's tool loop for one chat reply.
 *
 * Each round streams one Messages API call. When Claude asks for tools:
 *  - read tools run straight away and their results go back to Claude;
 *  - write tools get a preview and the run pauses. The exact request so far
 *    (system, messages including thinking blocks, results gathered) is saved
 *    in agent_runs, and the chat shows an action card per write. Approving or
 *    declining resumes the run from that state, unchanged, so the replay is
 *    byte-identical: thinking blocks stay valid and the cached prefix matches.
 * After at most MAX_ROUNDS rounds the last call disallows tools, so the reply
 * always ends in text.
 */

import Anthropic from '@anthropic-ai/sdk';
import db from '../db/connection';
import { modelExtras, refusalNotice, type Effort } from '../llm/modelParams';
import { recordCall } from '../llm/usageLog';
import { indexNewMessages } from '../retrieval/indexer';
import type { ContextSource } from '../retrieval/context';
import type { ActionPreview, AgentTool, ToolContext } from '../tools';
import { apiTools, getTool, parseToolInput, toolsForRole } from '../tools';
import { maybeUpdateSummary } from './chatSummary';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MAX_ROUNDS = Math.max(1, Number(process.env.AGENT_TOOL_MAX_ROUNDS ?? 6) || 6);
const MAX_RESULT_CHARS = 30_000;
const MAX_JSON_RETRIES = 2;

// ─── Types ───────────────────────────────────────────────────────────────────

export type ToolCallStatus = 'pending' | 'done' | 'error' | 'rejected' | 'skipped';

/** A tool call as the chat UI shows it (chip, or action card while pending). */
export interface ToolCallView {
  id: number;
  runId: number;
  round: number;
  name: string;
  kind: 'read' | 'write';
  status: ToolCallStatus;
  summary: string | null;
  url: string | null;
  preview: ActionPreview | null;
}

interface PendingTurn {
  /** tool_use ids of the last assistant turn, in order. */
  toolUseIds: string[];
  /** Results already known (reads, errors); writes are added on resume. */
  results: Record<string, Anthropic.ToolResultBlockParam>;
}

export interface RunState {
  model: string;
  effort: Effort;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  round: number;
  /** The visible reply so far, across rounds. */
  text: string;
  sources: ContextSource[];
  strategy: string;
  /** Off when AGENT_TOOLS_ENABLED=false: the run is a single plain call. */
  toolsEnabled: boolean;
  ctx: ToolContext;
  pending?: PendingTurn;
}

export interface RunIO {
  onChunk: (text: string) => void;
  /** A tool call finished, failed or was decided. */
  onTool?: (call: ToolCallView) => void;
  /** The run paused; these writes wait for the user. */
  onApproval?: (runId: number, calls: ToolCallView[]) => void;
  /** Drop the last `chars` characters already sent (a round is being retried). */
  onRetract?: (chars: number) => void;
}

export type RunOutcome =
  | { status: 'done'; runId: number; messageId: number; text: string }
  | { status: 'awaiting_approval'; runId: number; text: string };

interface ToolCallRow {
  id: number;
  run_id: number;
  round: number;
  tool_use_id: string;
  name: string;
  kind: 'read' | 'write';
  input: string;
  preview: string | null;
  status: ToolCallStatus;
  summary: string | null;
  link_url: string | null;
}

function toView(row: ToolCallRow): ToolCallView {
  return {
    id: row.id,
    runId: row.run_id,
    round: row.round,
    name: row.name,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    url: row.link_url,
    preview: row.preview ? (JSON.parse(row.preview) as ActionPreview) : null,
  };
}

function getCall(id: number): ToolCallRow {
  return db.prepare('SELECT * FROM tool_calls WHERE id = ?').get(id) as unknown as ToolCallRow;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

function saveState(runId: number, status: string, state: RunState): void {
  db.prepare(`UPDATE agent_runs SET status = ?, state = ?, updated_at = datetime('now') WHERE id = ?`).run(
    status,
    JSON.stringify(state),
    runId
  );
}

function insertCall(params: {
  runId: number;
  state: RunState;
  toolUseId: string;
  name: string;
  kind: 'read' | 'write';
  input: unknown;
  status: ToolCallStatus;
  preview?: ActionPreview | null;
  summary?: string | null;
  url?: string | null;
  result?: string | null;
  durationMs?: number | null;
}): ToolCallRow {
  const r = db
    .prepare(
      `INSERT INTO tool_calls
         (run_id, conversation_id, round, tool_use_id, name, kind, input, preview, status, summary, link_url, result, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.runId,
      params.state.ctx.conversationId,
      params.state.round,
      params.toolUseId,
      params.name,
      params.kind,
      JSON.stringify(params.input ?? null),
      params.preview ? JSON.stringify(params.preview) : null,
      params.status,
      params.summary ?? null,
      params.url ?? null,
      params.result ?? null,
      params.durationMs ?? null
    );
  return getCall(Number(r.lastInsertRowid));
}

function clipResult(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…[truncated]` : text;
}

function toolResult(toolUseId: string, content: string, isError = false): Anthropic.ToolResultBlockParam {
  return { type: 'tool_result', tool_use_id: toolUseId, content: clipResult(content), ...(isError ? { is_error: true } : {}) };
}

/** Runs a tool and records the call. Errors become an is_error result, never an exception. */
async function execute(
  runId: number,
  state: RunState,
  tool: AgentTool,
  toolUseId: string,
  input: unknown
): Promise<{ row: ToolCallRow; result: Anthropic.ToolResultBlockParam }> {
  const started = Date.now();
  try {
    const out = await tool.run(input as never, state.ctx);
    const row = insertCall({
      runId, state, toolUseId, name: tool.name, kind: tool.kind, input,
      status: 'done', summary: out.summary, url: out.url ?? null, result: clipResult(out.content), durationMs: Date.now() - started,
    });
    return { row, result: toolResult(toolUseId, out.content) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const row = insertCall({
      runId, state, toolUseId, name: tool.name, kind: tool.kind, input,
      status: 'error', summary: `${tool.name} failed: ${message}`, result: message, durationMs: Date.now() - started,
    });
    return { row, result: toolResult(toolUseId, `Error: ${message}`, true) };
  }
}

// ─── The loop ────────────────────────────────────────────────────────────────

/** Creates a run for a new reply and starts its loop. */
export async function startRun(
  params: { agentId: number; conversationId: number; state: RunState },
  io: RunIO
): Promise<RunOutcome> {
  const r = db
    .prepare(`INSERT INTO agent_runs (conversation_id, agent_id, status, state) VALUES (?, ?, 'running', ?)`)
    .run(params.conversationId, params.agentId, JSON.stringify(params.state));
  return runLoop(Number(r.lastInsertRowid), params.state, io);
}

async function runLoop(runId: number, state: RunState, io: RunIO): Promise<RunOutcome> {
  const tools = state.toolsEnabled ? toolsForRole(state.ctx.role) : [];
  const toolDefs = tools.length ? apiTools(tools) : undefined;
  const extras = modelExtras(state.model, state.effort);
  let jsonRetries = 0;

  while (state.round < MAX_ROUNDS) {
    state.round++;
    const lastRound = state.round === MAX_ROUNDS;
    const roundStart = state.text.length;
    let firstText = true;
    const startedAt = Date.now();
    let firstTokenAt: number | null = null;

    const stream = anthropic.messages.stream(
      {
        model: state.model,
        max_tokens: 32000,
        system: state.system,
        messages: state.messages,
        ...(toolDefs ? { tools: toolDefs } : {}),
        // Last round: answer with what was gathered.
        ...(toolDefs && lastRound ? { tool_choice: { type: 'none' } } : {}),
        ...extras.body,
      } as Anthropic.MessageStreamParams,
      { headers: extras.headers }
    );
    stream.on('text', (delta) => {
      firstTokenAt ??= Date.now();
      // Text from a later round continues the same reply after a paragraph break.
      if (firstText && state.text && !state.text.endsWith('\n\n')) {
        const sep = state.text.endsWith('\n') ? '\n' : '\n\n';
        state.text += sep;
        io.onChunk(sep);
      }
      firstText = false;
      state.text += delta;
      io.onChunk(delta);
    });

    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // With eager input streaming, finalMessage rejects if a tool input was
      // not parseable JSON at all. Retry that round; rethrow API errors.
      if (err instanceof Anthropic.APIError || jsonRetries++ >= MAX_JSON_RETRIES) throw err;
      console.warn('[Tools] Tool input was not parseable JSON, retrying the round');
      io.onRetract?.(state.text.length - roundStart);
      state.text = state.text.slice(0, roundStart);
      state.round--;
      continue;
    }

    recordCall(
      { kind: 'chat', agentId: state.ctx.agentId, conversationId: state.ctx.conversationId, strategy: state.strategy },
      message,
      { startedAt, firstTokenAt }
    );

    if (message.stop_reason === 'refusal') {
      // A refusal can cut a tool_use off mid-input: never run that turn's tools.
      const notice = refusalNotice(message);
      const sep = state.text ? '\n\n' : '';
      state.text += sep + notice;
      io.onChunk(sep + notice);
      break;
    }

    const toolUses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (toolUses.length === 0) {
      if (message.stop_reason === 'max_tokens') console.warn(`[Chat] Reply truncated by max_tokens (model: ${state.model})`);
      break;
    }
    if (message.stop_reason === 'max_tokens') {
      // A tool input cut off at max_tokens can parse as a valid partial object.
      const note = '\n\n_(The reply hit the length limit before a tool call finished, so it was not run.)_';
      state.text += note;
      io.onChunk(note);
      break;
    }

    // Send Claude's turn back unchanged (thinking and tool_use blocks included).
    state.messages.push({ role: 'assistant', content: message.content });

    const results: Record<string, Anthropic.ToolResultBlockParam> = {};
    const waiting: ToolCallView[] = [];
    for (const tu of toolUses) {
      const tool = getTool(state.ctx.role, tu.name);
      if (!tool) {
        const row = insertCall({ runId, state, toolUseId: tu.id, name: tu.name, kind: 'read', input: tu.input, status: 'error', summary: `Unknown tool ${tu.name}` });
        results[tu.id] = toolResult(tu.id, `Error: no tool named ${tu.name} is available to you.`, true);
        io.onTool?.(toView(row));
        continue;
      }
      const parsed = parseToolInput(tool, tu.input);
      if (!parsed.ok) {
        const row = insertCall({ runId, state, toolUseId: tu.id, name: tool.name, kind: tool.kind, input: tu.input, status: 'error', summary: parsed.error, result: parsed.error });
        results[tu.id] = toolResult(tu.id, parsed.error, true);
        io.onTool?.(toView(row));
        continue;
      }
      if (tool.kind === 'read') {
        const { row, result } = await execute(runId, state, tool, tu.id, parsed.input);
        results[tu.id] = result;
        io.onTool?.(toView(row));
        continue;
      }
      // Write: prepare the action card and wait for the user.
      try {
        const preview = await tool.preview(parsed.input as never, state.ctx);
        const row = insertCall({ runId, state, toolUseId: tu.id, name: tool.name, kind: 'write', input: parsed.input, status: 'pending', preview, summary: preview.title });
        waiting.push(toView(row));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const row = insertCall({ runId, state, toolUseId: tu.id, name: tool.name, kind: 'write', input: parsed.input, status: 'error', summary: `${tool.name} failed: ${msg}`, result: msg });
        results[tu.id] = toolResult(tu.id, `Error: ${msg}`, true);
        io.onTool?.(toView(row));
      }
    }

    if (waiting.length > 0) {
      state.pending = { toolUseIds: toolUses.map((t) => t.id), results };
      saveState(runId, 'awaiting_approval', state);
      io.onApproval?.(runId, waiting);
      return { status: 'awaiting_approval', runId, text: state.text };
    }

    state.messages.push({ role: 'user', content: toolUses.map((t) => results[t.id]!) });
    saveState(runId, 'running', state);
  }

  return finishRun(runId, state);
}

/** Saves the reply as a chat message and links the run's tool calls to it. */
function finishRun(runId: number, state: RunState, note = ''): RunOutcome {
  const text = note ? `${state.text}${state.text ? '\n\n' : ''}${note}` : state.text;
  const r = db
    .prepare('INSERT INTO messages (conversation_id, role, content, context_sources) VALUES (?, ?, ?, ?)')
    .run(state.ctx.conversationId, 'assistant', text, state.sources.length ? JSON.stringify(state.sources) : null);
  const messageId = Number(r.lastInsertRowid);
  db.prepare('UPDATE tool_calls SET message_id = ? WHERE run_id = ?').run(messageId, runId);
  // The full request isn't needed once the reply is saved; keep a small record.
  db.prepare(`UPDATE agent_runs SET status = ?, state = ?, message_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
    note ? 'abandoned' : 'done',
    JSON.stringify({ rounds: state.round, model: state.model }),
    messageId,
    runId
  );
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(state.ctx.conversationId);

  void indexNewMessages();
  void maybeUpdateSummary(state.ctx.conversationId, state.ctx.agentId);
  return { status: 'done', runId, messageId, text };
}

// ─── Approvals ───────────────────────────────────────────────────────────────

export class RunNotWaitingError extends Error {}

interface RunRow {
  id: number;
  conversation_id: number;
  agent_id: number;
  status: string;
  state: string;
}

function getRun(runId: number): RunRow | undefined {
  return db.prepare('SELECT id, conversation_id, agent_id, status, state FROM agent_runs WHERE id = ?').get(runId) as
    | RunRow
    | undefined;
}

function pendingCalls(runId: number): ToolCallRow[] {
  return db.prepare(`SELECT * FROM tool_calls WHERE run_id = ? AND status = 'pending' ORDER BY id`).all(runId) as unknown as ToolCallRow[];
}

export function getRunConversation(runId: number): number | null {
  return getRun(runId)?.conversation_id ?? null;
}

/**
 * Applies the user's decisions on a paused run's writes (approve runs the
 * tool, reject tells Claude it was declined), then continues the loop.
 * Every pending call needs a decision.
 */
export async function resumeRun(runId: number, decisions: Record<number, boolean>, io: RunIO): Promise<RunOutcome> {
  const calls = pendingCalls(runId);
  const missing = calls.filter((c) => decisions[c.id] === undefined);
  if (missing.length) throw new Error(`Missing decisions for tool calls ${missing.map((c) => c.id).join(', ')}`);

  // Claim the run, so a double click can't run the writes twice.
  const claimed = db
    .prepare(`UPDATE agent_runs SET status = 'running', updated_at = datetime('now') WHERE id = ? AND status = 'awaiting_approval'`)
    .run(runId);
  if (Number(claimed.changes) !== 1) throw new RunNotWaitingError('This action was already decided');

  const run = getRun(runId)!;
  const state = JSON.parse(run.state) as RunState;
  const pending = state.pending;
  if (!pending) throw new Error('Run has no pending tool calls');

  for (const call of calls) {
    const tool = getTool(state.ctx.role, call.name);
    const input = JSON.parse(call.input) as unknown;
    let result: Anthropic.ToolResultBlockParam;
    let status: ToolCallStatus;
    let summary = call.summary;
    let url: string | null = null;
    let stored: string;
    const started = Date.now();

    if (!decisions[call.id]) {
      status = 'rejected';
      stored = 'The user declined this action.';
      result = toolResult(call.tool_use_id, "The user declined this action. Don't retry it unless they ask.");
    } else if (!tool) {
      status = 'error';
      stored = `Tool ${call.name} is no longer available`;
      result = toolResult(call.tool_use_id, `Error: ${stored}`, true);
    } else {
      try {
        const out = await tool.run(input as never, state.ctx);
        status = 'done';
        summary = out.summary;
        url = out.url ?? null;
        stored = clipResult(out.content);
        result = toolResult(call.tool_use_id, out.content);
      } catch (err) {
        status = 'error';
        stored = err instanceof Error ? err.message : String(err);
        summary = `${call.name} failed: ${stored}`;
        result = toolResult(call.tool_use_id, `Error: ${stored}`, true);
      }
    }

    db.prepare(
      `UPDATE tool_calls SET status = ?, summary = ?, link_url = ?, result = ?, duration_ms = ?, decided_at = datetime('now') WHERE id = ?`
    ).run(status, summary, url, stored, Date.now() - started, call.id);
    pending.results[call.tool_use_id] = result;
    io.onTool?.(toView(getCall(call.id)));
  }

  state.messages.push({ role: 'user', content: pending.toolUseIds.map((id) => pending.results[id]!) });
  state.pending = undefined;
  saveState(runId, 'running', state);
  return runLoop(runId, state, io);
}

/**
 * A new message while a run still waits for approval: the waiting writes are
 * skipped and the reply so far is saved, so the history stays in order.
 */
export function abandonOpenRuns(conversationId: number): void {
  const runs = db
    .prepare(`SELECT id, conversation_id, agent_id, status, state FROM agent_runs WHERE conversation_id = ? AND status = 'awaiting_approval'`)
    .all(conversationId) as unknown as RunRow[];
  for (const run of runs) {
    const claimed = db
      .prepare(`UPDATE agent_runs SET status = 'running' WHERE id = ? AND status = 'awaiting_approval'`)
      .run(run.id);
    if (Number(claimed.changes) !== 1) continue;
    db.prepare(`UPDATE tool_calls SET status = 'skipped', decided_at = datetime('now') WHERE run_id = ? AND status = 'pending'`).run(run.id);
    finishRun(run.id, JSON.parse(run.state) as RunState, '_(Not done: the proposed actions were left without a decision.)_');
  }
}

// ─── Reads for the chat UI ───────────────────────────────────────────────────

export interface PendingRunView {
  runId: number;
  text: string;
  sources: ContextSource[];
  toolCalls: ToolCallView[];
}

/** A run of this chat that is waiting for the user, to redraw its cards after a reload. */
export function getPendingRun(conversationId: number): PendingRunView | null {
  const run = db
    .prepare(`SELECT id, conversation_id, agent_id, status, state FROM agent_runs WHERE conversation_id = ? AND status = 'awaiting_approval' ORDER BY id DESC LIMIT 1`)
    .get(conversationId) as RunRow | undefined;
  if (!run) return null;
  const state = JSON.parse(run.state) as RunState;
  const rows = db.prepare('SELECT * FROM tool_calls WHERE run_id = ? ORDER BY id').all(run.id) as unknown as ToolCallRow[];
  return { runId: run.id, text: state.text, sources: state.sources, toolCalls: rows.map(toView) };
}

/** Tool calls of saved replies, keyed by message id. */
export function getToolCallsByMessage(conversationId: number): Map<number, ToolCallView[]> {
  const rows = db
    .prepare('SELECT * FROM tool_calls WHERE conversation_id = ? AND message_id IS NOT NULL ORDER BY id')
    .all(conversationId) as unknown as (ToolCallRow & { message_id: number })[];
  const out = new Map<number, ToolCallView[]>();
  for (const row of rows) {
    const list = out.get(row.message_id) ?? [];
    list.push(toView(row));
    out.set(row.message_id, list);
  }
  return out;
}


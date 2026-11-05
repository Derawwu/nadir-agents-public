/**
 * Single-agent chat session logic.
 *
 * Each agent can have many chats (rows in `conversations`). This module owns
 * chat lifecycle (create, list, rename, pin, archive, soft delete), calls the
 * Anthropic API with streaming, persists both the user message and the
 * complete assistant response, and auto-titles new chats.
 */

import Anthropic from '@anthropic-ai/sdk';
import db from '../db/connection';
import { getAgentById } from '../agents/agentService';
import { buildChatContext, withCacheBreakpoint } from '../agents/promptBuilder';
import { saveMemory, type MemoryType } from '../agents/memoryService';
import { getEffortForAgent, getModelForAgent, normalizeAgentRole, TITLE_MODEL } from '../agents/modelConfig';
import { modelExtras, textOf } from '../llm/modelParams';
import type { StoredImage } from './imageStore';
import { slugifyTitle } from './slug';
import { recordCall } from '../llm/usageLog';
import type { ContextSource } from '../retrieval/context';
import { isToolUseEnabled } from '../tools';
import {
  abandonOpenRuns,
  getPendingRun,
  getRunConversation,
  getToolCallsByMessage,
  resumeRun,
  startRun,
  type PendingRunView,
  type RunIO,
  type ToolCallView,
} from './agentRun';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export const DEFAULT_CHAT_TITLE = 'New chat';


// ─── Chats ───────────────────────────────────────────────────────────────────

export interface Chat {
  id: number;
  agent_id: number;
  feature_id: number | null;
  title: string;
  /** URL segment, unique per agent among live chats. */
  slug: string;
  pinned: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  message_count: number;
}

interface ChatRow {
  id: number;
  agent_id: number;
  feature_id: number | null;
  title: string;
  slug: string;
  pinned: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string | null;
  message_count: number;
}

const CHAT_SELECT = `
  SELECT c.id, c.agent_id, c.feature_id, c.title, c.slug, c.pinned, c.archived_at, c.created_at,
         COALESCE(c.updated_at, c.created_at) AS updated_at,
         (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
  FROM conversations c`;

function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    agent_id: row.agent_id,
    feature_id: row.feature_id,
    title: row.title,
    slug: row.slug,
    pinned: row.pinned === 1,
    archived: row.archived_at !== null,
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
    message_count: Number(row.message_count),
  };
}

/** Lists an agent's chats (excluding deleted): pinned first, then most recently active. */
export function listChats(agentId: number, includeArchived: boolean): Chat[] {
  const rows = db
    .prepare(
      `${CHAT_SELECT}
       WHERE c.agent_id = ? AND c.deleted_at IS NULL
         AND (? = 1 OR c.archived_at IS NULL)
       ORDER BY c.pinned DESC, updated_at DESC, c.id DESC`
    )
    .all(agentId, includeArchived ? 1 : 0) as unknown as ChatRow[];
  return rows.map(toChat);
}

export function getChat(chatId: number): Chat | undefined {
  const row = db
    .prepare(`${CHAT_SELECT} WHERE c.id = ? AND c.deleted_at IS NULL`)
    .get(chatId) as ChatRow | undefined;
  return row ? toChat(row) : undefined;
}

/** Looks up a live chat by its URL slug (archived chats included). */
export function getChatBySlug(agentId: number, slug: string): Chat | undefined {
  const row = db
    .prepare(`${CHAT_SELECT} WHERE c.agent_id = ? AND c.slug = ? AND c.deleted_at IS NULL`)
    .get(agentId, slug) as ChatRow | undefined;
  return row ? toChat(row) : undefined;
}

/** Slug for `title` that no other live chat of this agent uses ("misc", "misc-2", …). */
function uniqueSlug(agentId: number, title: string, excludeChatId: number | null): string {
  const base = slugifyTitle(title);
  const taken = new Set(
    (
      db
        .prepare(
          `SELECT slug FROM conversations
           WHERE agent_id = ? AND deleted_at IS NULL AND id IS NOT ? AND slug IS NOT NULL`
        )
        .all(agentId, excludeChatId) as unknown as { slug: string }[]
    ).map((r) => r.slug)
  );
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

export function createChat(params: {
  agentId: number;
  featureId?: number | null;
  title?: string;
}): Chat {
  const title = params.title?.trim() || DEFAULT_CHAT_TITLE;
  const result = db
    .prepare(
      `INSERT INTO conversations (agent_id, feature_id, title, slug, updated_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    )
    .run(params.agentId, params.featureId ?? null, title, uniqueSlug(params.agentId, title, null));
  return getChat(Number(result.lastInsertRowid))!;
}

export function updateChat(
  chatId: number,
  patch: { title?: string; pinned?: boolean; archived?: boolean; featureId?: number | null }
): Chat | undefined {
  if (patch.title !== undefined) {
    // The slug follows the title so the URL stays readable after renames.
    const current = getChat(chatId);
    const title = patch.title.trim() || DEFAULT_CHAT_TITLE;
    if (current && title !== current.title) {
      db.prepare('UPDATE conversations SET title = ?, slug = ? WHERE id = ?').run(
        title,
        uniqueSlug(current.agent_id, title, chatId),
        chatId
      );
    }
  }
  if (patch.pinned !== undefined) {
    db.prepare('UPDATE conversations SET pinned = ? WHERE id = ?').run(patch.pinned ? 1 : 0, chatId);
  }
  if (patch.archived !== undefined) {
    db.prepare(
      `UPDATE conversations
       SET archived_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
       WHERE id = ?`
    ).run(patch.archived ? 1 : 0, chatId);
  }
  if (patch.featureId !== undefined) {
    db.prepare('UPDATE conversations SET feature_id = ? WHERE id = ?').run(patch.featureId, chatId);
  }
  return getChat(chatId);
}

/** Soft delete — the chat disappears from the UI but its rows stay in the DB. */
export function deleteChat(chatId: number): boolean {
  const result = db
    .prepare(`UPDATE conversations SET deleted_at = datetime('now') WHERE id = ? AND deleted_at IS NULL`)
    .run(chatId);
  return Number(result.changes) > 0;
}

function touchChat(chatId: number): void {
  db.prepare(`UPDATE conversations SET updated_at = datetime('now') WHERE id = ?`).run(chatId);
}

// ─── Messaging ───────────────────────────────────────────────────────────────

export interface SendMessageParams {
  agentId: number;
  /** Only used when this message creates a new chat. */
  featureId?: number | null;
  message: string;
  images?: StoredImage[];
  /** Existing chat to post into; null/undefined creates a new chat. */
  conversationId?: number | null;
  onChunk: (chunk: string) => void;
  /** Called once, before streaming starts, with what retrieval added to the request. */
  onSources?: (sources: ContextSource[]) => void;
  /** Tool activity: finished calls, and writes waiting for approval. */
  onTool?: RunIO['onTool'];
  onApproval?: RunIO['onApproval'];
  onRetract?: RunIO['onRetract'];
}

export interface SendMessageResult {
  conversationId: number;
  fullResponse: string;
  /** True when the chat still has the default title and should be auto-named. */
  needsTitle: boolean;
  /** Set when the reply paused for the user to approve actions. */
  awaitingRunId: number | null;
}

/**
 * Sends a message in a chat and streams the reply via onChunk. The reply is
 * an agent run (chat/agentRun.ts): it may call tools, and pauses when a write
 * needs approval. Both messages are persisted.
 */
export async function sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
  const agent = getAgentById(params.agentId);
  if (!agent) throw new Error(`Agent not found: ${params.agentId}`);

  // An existing chat's own feature is authoritative; featureId from the request
  // only seeds a chat that is being created by this message.
  let chat = params.conversationId != null ? getChat(params.conversationId) : undefined;
  if (params.conversationId != null && (!chat || chat.agent_id !== params.agentId)) {
    throw new Error(`Chat not found for this agent: ${params.conversationId}`);
  }
  chat ??= createChat({ agentId: params.agentId, featureId: params.featureId });
  const conversationId = chat.id;

  // A reply still waiting for approval is closed first, so it stays before this message.
  abandonOpenRuns(conversationId);

  const agentRole = normalizeAgentRole(agent.role);

  const { system, messages, strategy, sources, retrievalFilter } = await buildChatContext({
    agentSystemPrompt: agent.system_prompt,
    agentId: params.agentId,
    agentRole,
    featureId: chat.feature_id,
    conversationId,
    userMessage: params.message,
    userImages: params.images,
  });

  params.onSources?.(sources);

  // Persist user message before the API call so it's recorded even if streaming fails.
  db.prepare('INSERT INTO messages (conversation_id, role, content, images) VALUES (?, ?, ?, ?)').run(
    conversationId,
    'user',
    params.message,
    params.images && params.images.length > 0 ? JSON.stringify(params.images) : null
  );
  touchChat(conversationId);

  const model = getModelForAgent(agentRole);
  const effort = getEffortForAgent(agentRole);
  const toolsOn = isToolUseEnabled();
  console.log(`[${agentRole}] Using model: ${model} (effort ${effort}, tools ${toolsOn ? 'on' : 'off'})`);

  // With tools, later rounds resend this turn: a breakpoint on it lets them
  // read its retrieved context from cache (system + history are the other two).
  if (toolsOn) messages[messages.length - 1] = withCacheBreakpoint(messages[messages.length - 1]!);

  const outcome = await startRun(
    {
      agentId: params.agentId,
      conversationId,
      state: {
        model,
        effort,
        system,
        messages,
        round: 0,
        text: '',
        sources,
        strategy,
        toolsEnabled: toolsOn,
        ctx: { agentId: params.agentId, role: agentRole, conversationId, featureId: chat.feature_id, retrievalFilter },
      },
    },
    { onChunk: params.onChunk, onTool: params.onTool, onApproval: params.onApproval, onRetract: params.onRetract }
  );

  return {
    conversationId,
    fullResponse: outcome.text,
    needsTitle: chat.title === DEFAULT_CHAT_TITLE,
    awaitingRunId: outcome.status === 'awaiting_approval' ? outcome.runId : null,
  };
}

export interface ResumeResult {
  conversationId: number;
  fullResponse: string;
  awaitingRunId: number | null;
}

/** Continues a paused reply after the user decided on its actions. */
export async function resumeReply(
  runId: number,
  decisions: Record<number, boolean>,
  io: RunIO
): Promise<ResumeResult> {
  const conversationId = getRunConversation(runId);
  if (conversationId === null) throw new Error(`Run not found: ${runId}`);
  const outcome = await resumeRun(runId, decisions, io);
  return {
    conversationId,
    fullResponse: outcome.text,
    awaitingRunId: outcome.status === 'awaiting_approval' ? outcome.runId : null,
  };
}

function fallbackTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'Image chat';
  return clean.length > 50 ? clean.slice(0, 47).trimEnd() + '…' : clean;
}

/**
 * Names a chat from its first exchange with a small, cheap model.
 * Falls back to a truncated user message if the call fails. Never overwrites
 * a title the user has already set.
 */
export async function generateChatTitle(
  chatId: number,
  userMessage: string,
  assistantReply: string
): Promise<Chat | null> {
  const chat = getChat(chatId);
  if (!chat || chat.title !== DEFAULT_CHAT_TITLE) return null;

  let title = fallbackTitle(userMessage);
  try {
    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: TITLE_MODEL,
      // Room for brief adaptive thinking on 5.x models before the title.
      max_tokens: 1024,
      ...(modelExtras(TITLE_MODEL, 'low').body as object),
      messages: [
        {
          role: 'user',
          content: `Write a short title (3-6 words) for a chat that starts with the exchange below. Reply with the title only, with no quotes and no trailing punctuation.

<user>${userMessage.slice(0, 2000)}</user>
<assistant>${assistantReply.slice(0, 2000)}</assistant>`,
        },
      ],
    });
    recordCall({ kind: 'title', agentId: chat.agent_id, conversationId: chatId }, response, { startedAt });
    const generated = textOf(response).trim().replace(/^["'\s]+|["'.\s]+$/g, '');
    if (generated) title = generated.slice(0, 80);
  } catch (err) {
    console.warn('[Chat] Title generation failed, using fallback:', err instanceof Error ? err.message : err);
  }

  // Re-check: the user may have renamed the chat while we were waiting.
  const current = getChat(chatId);
  if (!current || current.title !== DEFAULT_CHAT_TITLE) return null;
  return updateChat(chatId, { title }) ?? null;
}

// ─── History ─────────────────────────────────────────────────────────────────

interface MessageRow {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  images: string | null;
  context_sources: string | null;
  created_at: string;
}

export interface MessageImageRef {
  url: string;
  media_type: string;
}

export interface HistoryMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  images?: MessageImageRef[];
  contextSources?: ContextSource[];
  /** Tools the agent used while writing this reply. */
  toolCalls?: ToolCallView[];
  created_at: string;
}

/** A reply of this chat that is paused until the user approves or declines its actions. */
export function getChatPendingRun(chatId: number): PendingRunView | null {
  return getPendingRun(chatId);
}

/** Returns a chat's full message history in chronological order. */
export function getChatMessages(chatId: number): HistoryMessage[] {
  const rows = db
    .prepare(
      `SELECT id, role, content, images, context_sources, created_at FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC, id ASC`
    )
    .all(chatId) as unknown as MessageRow[];
  const toolCalls = getToolCallsByMessage(chatId);

  return rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    images: row.images
      ? (JSON.parse(row.images) as StoredImage[]).map((img) => ({
          url: `/uploads/${img.filename}`,
          media_type: img.media_type,
        }))
      : undefined,
    contextSources: row.context_sources ? (JSON.parse(row.context_sources) as ContextSource[]) : undefined,
    toolCalls: toolCalls.get(row.id),
  }));
}

// ─── Memory ──────────────────────────────────────────────────────────────────

/**
 * Saves a memory from a chat message. It is scoped to that chat, so it is only
 * injected there unless the user later promotes it to feature or agent scope.
 */
export function saveConversationMemory(params: {
  conversationId: number;
  agentId: number;
  type: MemoryType;
  content: string;
}): number {
  const chat = getChat(params.conversationId);
  if (!chat || chat.agent_id !== params.agentId) throw new Error('Chat not found for this agent');
  return saveMemory({
    agentId: params.agentId,
    featureId: chat.feature_id,
    conversationId: chat.id,
    scope: 'chat',
    type: params.type,
    content: params.content,
  });
}

/**
 * Single-agent chat session logic.
 *
 * Manages conversation lifecycle (create or resume), calls the Anthropic API
 * with streaming, and persists both the user message and the complete
 * assistant response to the messages table.
 */

import Anthropic from '@anthropic-ai/sdk';
import db from '../db/connection';
import { getAgentById } from '../agents/agentService';
import { buildChatContext } from '../agents/promptBuilder';
import { saveMemory, type MemoryType } from '../agents/memoryService';
import { getModelForAgent, normalizeAgentRole } from '../agents/modelConfig';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

interface ConversationRow {
  id: number;
}

/**
 * Returns an existing conversation for the agent+feature combination,
 * or creates one if none exists.
 */
export function getOrCreateConversation(agentId: number, featureId?: number | null): number {
  const existing = db
    .prepare(
      `SELECT id FROM conversations
       WHERE agent_id = ?
         AND (feature_id = ? OR (feature_id IS NULL AND ? IS NULL))
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(agentId, featureId ?? null, featureId ?? null) as ConversationRow | undefined;

  if (existing) return existing.id;

  const result = db
    .prepare('INSERT INTO conversations (agent_id, feature_id) VALUES (?, ?)')
    .run(agentId, featureId ?? null);

  return Number(result.lastInsertRowid);
}

export interface SendMessageParams {
  agentId: number;
  featureId?: number | null;
  message: string;
  conversationId?: number | null;
  onChunk: (chunk: string) => void;
}

export interface SendMessageResult {
  conversationId: number;
  fullResponse: string;
}

/**
 * Sends a message in a conversation, streams the response via onChunk,
 * and persists both messages to the DB.
 */
export async function sendMessage(params: SendMessageParams): Promise<SendMessageResult> {
  const agent = getAgentById(params.agentId);
  if (!agent) throw new Error(`Agent not found: ${params.agentId}`);

  const conversationId =
    params.conversationId ?? getOrCreateConversation(params.agentId, params.featureId);

  const agentRole = normalizeAgentRole(agent.role);

  const { system, messages } = await buildChatContext({
    agentSystemPrompt: agent.system_prompt,
    agentId: params.agentId,
    agentRole,
    featureId: params.featureId,
    conversationId,
    userMessage: params.message,
  });

  // Persist user message before the API call so it's recorded even if streaming fails.
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(
    conversationId,
    'user',
    params.message
  );
  const model = getModelForAgent(agentRole);
  console.log(`[${agentRole}] Using model: ${model}`);

  let fullResponse = '';

  const stream = anthropic.messages.stream({
    model,
    max_tokens: 4096,
    system,
    messages,
  });

  for await (const event of stream) {
    if (
      event.type === 'content_block_delta' &&
      event.delta.type === 'text_delta'
    ) {
      const chunk = event.delta.text;
      fullResponse += chunk;
      params.onChunk(chunk);
    }
  }

  const finalMessage = await stream.finalMessage();
  const usage = finalMessage.usage;
  console.log(`[Cache] input: ${usage.input_tokens}, cache_read: ${usage.cache_read_input_tokens ?? 0}, cache_write: ${usage.cache_creation_input_tokens ?? 0}`);

  // Persist complete assistant response after streaming finishes.
  db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(
    conversationId,
    'assistant',
    fullResponse
  );

  return { conversationId, fullResponse };
}

interface MessageRow {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface ConversationHistoryResult {
  conversationId: number | null;
  messages: MessageRow[];
}

/**
 * Returns the most recent conversation and its full message history for the
 * given agent + feature combination, or null conversationId if none exists.
 */
export function getConversationHistory(
  agentId: number,
  featureId: number | null
): ConversationHistoryResult {
  const conv = db
    .prepare(
      `SELECT id FROM conversations
       WHERE agent_id = ?
         AND (feature_id = ? OR (feature_id IS NULL AND ? IS NULL))
       ORDER BY created_at DESC
       LIMIT 1`
    )
    .get(agentId, featureId, featureId) as ConversationRow | undefined;

  if (!conv) return { conversationId: null, messages: [] };

  const messages = db
    .prepare(
      `SELECT id, role, content, created_at FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`
    )
    .all(conv.id) as unknown as MessageRow[];

  return { conversationId: conv.id, messages };
}

/**
 * Saves a memory entry tagged to the given conversation's agent and feature.
 */
export function saveConversationMemory(params: {
  conversationId: number;
  agentId: number;
  featureId?: number | null;
  type: MemoryType;
  content: string;
}): number {
  return saveMemory({
    agentId: params.agentId,
    featureId: params.featureId ?? null,
    type: params.type,
    content: params.content,
  });
}

/**
 * Memory read/write operations.
 *
 * Memories are agent-owned knowledge blobs with one of three scopes:
 *   - 'chat'    — tied to conversation_id; injected only into that chat
 *   - 'feature' — tied to feature_id; shared by every chat and roundtable on it
 *   - 'agent'   — global for the agent
 *
 * node:sqlite does not support generics on prepare() — rows are cast via
 * `as` assertions. Safe here because schema is controlled and stable.
 */

import db from '../db/connection';

export type MemoryType = 'decision' | 'lore' | 'technical' | 'visual' | 'flag' | 'conflict';
export type MemoryScope = 'chat' | 'feature' | 'agent';
export type MemorySource = 'user' | 'roundtable';

export const MEMORY_TYPES: MemoryType[] = ['decision', 'lore', 'technical', 'visual', 'flag', 'conflict'];
export const MEMORY_SCOPES: MemoryScope[] = ['chat', 'feature', 'agent'];

export interface Memory {
  id: number;
  agent_id: number;
  feature_id: number | null;
  conversation_id: number | null;
  scope: MemoryScope;
  source: MemorySource;
  type: MemoryType;
  content: string;
  created_at: string;
}

export interface SaveMemoryParams {
  agentId: number;
  featureId?: number | null;
  conversationId?: number | null;
  scope: MemoryScope;
  source?: MemorySource;
  type: MemoryType;
  content: string;
}

/**
 * Returns the memories visible in a given context, most recent first:
 * agent-wide memories, plus feature memories when featureId is given, plus
 * chat memories when conversationId is given.
 */
export function getMemoriesForContext(params: {
  agentId: number;
  featureId?: number | null;
  conversationId?: number | null;
  limit?: number;
}): Memory[] {
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE agent_id = ?
         AND (
           scope = 'agent'
           OR (scope = 'feature' AND feature_id = ?)
           OR (scope = 'chat' AND conversation_id = ?)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(
      params.agentId,
      params.featureId ?? null,
      params.conversationId ?? null,
      params.limit ?? 20
    ) as unknown as Memory[];
}

export function getMemoryById(id: number): Memory | undefined {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Memory | undefined;
}

/**
 * Persists a new memory entry.
 * Returns the rowid of the newly inserted memory.
 */
export function saveMemory(params: SaveMemoryParams): number {
  const result = db
    .prepare(
      `INSERT INTO memories (agent_id, feature_id, conversation_id, scope, source, type, content)
       VALUES (@agentId, @featureId, @conversationId, @scope, @source, @type, @content)`
    )
    .run({
      agentId: params.agentId,
      featureId: params.featureId ?? null,
      conversationId: params.conversationId ?? null,
      scope: params.scope,
      source: params.source ?? 'user',
      type: params.type,
      content: params.content,
    });

  // node:sqlite returns lastInsertRowid as number|bigint — coerce to number.
  return Number(result.lastInsertRowid);
}

/**
 * Moves a memory to a different scope. The caller supplies the chat/feature
 * the memory should attach to; validation of that pairing happens here.
 */
export function updateMemoryScope(
  id: number,
  scope: MemoryScope,
  target: { conversationId?: number | null; featureId?: number | null }
): Memory {
  const memory = getMemoryById(id);
  if (!memory) throw new Error('Memory not found');

  const conversationId = scope === 'chat' ? (target.conversationId ?? memory.conversation_id) : memory.conversation_id;
  const featureId = scope === 'feature' ? (target.featureId ?? memory.feature_id) : memory.feature_id;

  if (scope === 'chat' && conversationId == null) throw new Error('A chat is required for chat scope');
  if (scope === 'feature' && featureId == null) throw new Error('A feature is required for feature scope');

  db.prepare('UPDATE memories SET scope = ?, conversation_id = ?, feature_id = ? WHERE id = ?').run(
    scope,
    conversationId,
    featureId,
    id
  );
  return getMemoryById(id)!;
}

/**
 * Formats memories into the canonical injection string used in prompts.
 */
export function formatMemoriesForPrompt(memories: Memory[]): string {
  if (memories.length === 0) return '';
  const lines = memories.map((m) => `[${m.type.toUpperCase()}] ${m.content}`).join('\n');
  return `## Your Memory\n${lines}`;
}

/**
 * Composes the full context payload for each Anthropic API call.
 *
 * Assembly order (deliberate — must be maintained):
 *   1. Agent system prompt (persona and constraints)
 *   2. Feature brief (current work scope, if any)
 *   3. Relevant memories (recent knowledge, most recent first)
 *   4. Conversation history (ordered ASC so the model sees chronology)
 *   5. Current user message (the turn being responded to)
 *
 * This ordering ensures constraints are established before context,
 * and context before the immediate request.
 */

import type { ContentBlockParam, MessageParam, TextBlockParam } from '@anthropic-ai/sdk/resources/messages';
import { getFeatureById, type Feature } from '../features/featureService';
import { getMemoriesForContext, formatMemoriesForPrompt } from './memoryService';
import { searchDocuments, type AgentRole } from '../outline/outlineService';
import { readImageAsBase64, type StoredImage } from '../chat/imageStore';
import db from '../db/connection';

export interface SystemPromptParts {
  agentPrompt: string;    // static — cache this
  featureBrief: string;   // dynamic — do not cache
  memoriesBlock: string;  // dynamic — do not cache
  wikiDocsBlock: string;  // dynamic — do not cache
}

interface MessageRow {
  role: 'user' | 'assistant';
  content: string;
  images: string | null;
}

/**
 * Builds Anthropic content blocks for a message, inlining any attached images
 * as base64 (read from disk at call time — only the filename is stored in the DB).
 * Falls back to a plain string when there are no images, matching prior behavior.
 */
function buildContent(text: string, images?: StoredImage[]): string | ContentBlockParam[] {
  if (!images || images.length === 0) return text;

  const blocks: ContentBlockParam[] = images.map((img) => ({
    type: 'image',
    source: {
      type: 'base64',
      media_type: img.media_type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
      data: readImageAsBase64(img.filename),
    },
  }));

  if (text.trim()) {
    blocks.push({ type: 'text', text });
  }

  return blocks;
}

export async function getRelevantWikiDocs(
  role: AgentRole,
  feature: Feature | null
): Promise<string> {
  if (!feature) return '';

  try {
    const results = await searchDocuments(role, feature.name);

    if (!results || results.length === 0) return '';

    const topResults = results.slice(0, 3);
    console.log(`[Wiki] Injecting ${topResults.length} docs for feature "${feature.name}"`);
    const formatted = topResults.map((doc, i) => {
      const snippet = i === 0
        ? doc.text
        : doc.text.length > 800 ? doc.text.slice(0, 800) + '...' : doc.text;
      return `### ${doc.title}\n${snippet}`;
    }).join('\n\n');

    return `\n## Relevant Wiki Docs (from Outline)\n${formatted}`;
  } catch (err) {
    console.warn('[promptBuilder] Wiki doc fetch failed, continuing without:', err);
    return '';
  }
}

/**
 * Splits the system prompt into its three stable/dynamic parts for selective caching.
 * The agentPrompt is static per agent and qualifies for prompt caching.
 * featureBrief and memoriesBlock change per session and must not be cached.
 */
export async function buildSystemBlocks(
  agentSystemPrompt: string,
  feature: Feature | null,
  memoriesBlock: string,
  role: AgentRole
): Promise<SystemPromptParts> {
  let featureBrief = '';

  if (feature) {
    const lockedStr =
      feature.locked_decisions && feature.locked_decisions.length > 0
        ? feature.locked_decisions.map((d) => `- ${d}`).join('\n')
        : 'None';

    const featureLabel = feature.jira_key
      ? `[${feature.jira_key}] ${feature.name} (${feature.jira_type ?? 'issue'}) — ${feature.phase}`
      : `${feature.name} — ${feature.phase}`;

    const isClosed =
      feature.status === 'closed' ||
      feature.jira_status === 'completed' ||
      feature.jira_status === 'cancelled';

    const retroLine = isClosed
      ? '\n**STATUS: CLOSED** — treat this session as a retrospective doublecheck, not active development. Flag anything that was missed or could have been done better.'
      : '';

    featureBrief = `\n## Current Feature Brief
**FEATURE:** ${featureLabel}
**Description:** ${feature.description ?? 'No description provided.'}
**Locked Decisions (do not re-litigate these):**
${lockedStr}${retroLine}`;
  }

  const wikiDocsBlock = await getRelevantWikiDocs(role, feature);

  return {
    agentPrompt: agentSystemPrompt,
    featureBrief,
    memoriesBlock: memoriesBlock ? `\n${memoriesBlock}` : '',
    wikiDocsBlock,
  };
}

/**
 * Builds the flat system prompt string — kept for backward compatibility.
 * Callers that need caching should use buildSystemBlocks + buildCachedSystemParam.
 */
export async function buildSystemPrompt(
  agentSystemPrompt: string,
  feature: Feature | null,
  memoriesBlock: string,
  role: AgentRole
): Promise<string> {
  const parts = await buildSystemBlocks(agentSystemPrompt, feature, memoriesBlock, role);
  const sections = [parts.agentPrompt];
  if (parts.featureBrief) sections.push(parts.featureBrief);
  if (parts.memoriesBlock) sections.push(parts.memoriesBlock);
  if (parts.wikiDocsBlock) sections.push(parts.wikiDocsBlock);
  return sections.join('\n');
}

/**
 * Returns the system param as a multi-block array for the Anthropic API.
 * Block 1 (agentPrompt) is marked cache_control: ephemeral — it is static per
 * agent and will be reused across turns. Blocks 2 and 3 are dynamic and omit
 * cache_control so they never pollute the stable prefix.
 */
export function buildCachedSystemParam(parts: SystemPromptParts): TextBlockParam[] {
  const blocks: TextBlockParam[] = [];

  // Block 1: agent system prompt — mark for caching
  blocks.push({
    type: 'text',
    text: parts.agentPrompt,
    cache_control: { type: 'ephemeral' },
  });

  // Block 2: feature brief — dynamic, no cache
  if (parts.featureBrief) {
    blocks.push({
      type: 'text',
      text: parts.featureBrief,
    });
  }

  // Block 3: memories — dynamic, no cache
  if (parts.memoriesBlock) {
    blocks.push({
      type: 'text',
      text: parts.memoriesBlock,
    });
  }

  // Block 4: wiki docs — dynamic, no cache
  if (parts.wikiDocsBlock) {
    blocks.push({
      type: 'text',
      text: parts.wikiDocsBlock,
    });
  }

  return blocks;
}

/**
 * Builds the messages array for the Anthropic API.
 * Fetches conversation history from DB and appends the current user message.
 */
export function buildMessages(
  conversationId: number,
  currentUserMessage: string,
  currentImages?: StoredImage[]
): MessageParam[] {
  const history = db
    .prepare(
      `SELECT role, content, images FROM messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`
    )
    .all(conversationId) as unknown as MessageRow[];

  const messages: MessageParam[] = history.map((row) => ({
    role: row.role,
    content: buildContent(row.content, row.images ? (JSON.parse(row.images) as StoredImage[]) : undefined),
  }));

  messages.push({ role: 'user', content: buildContent(currentUserMessage, currentImages) });
  return messages;
}

/**
 * Full context composition for a single-agent chat turn.
 * Returns system as TextBlockParam[] with cache_control on the agent prompt block.
 */
export async function buildChatContext(params: {
  agentSystemPrompt: string;
  agentId: number;
  agentRole: AgentRole;
  featureId?: number | null;
  conversationId: number;
  userMessage: string;
  userImages?: StoredImage[];
}): Promise<{ system: TextBlockParam[]; messages: MessageParam[] }> {
  const feature = params.featureId ? (getFeatureById(params.featureId) ?? null) : null;
  const memories = getMemoriesForContext({
    agentId: params.agentId,
    featureId: params.featureId,
    conversationId: params.conversationId,
  });
  const memoriesBlock = formatMemoriesForPrompt(memories);

  const parts = await buildSystemBlocks(params.agentSystemPrompt, feature, memoriesBlock, params.agentRole);
  const system = buildCachedSystemParam(parts);
  const messages = buildMessages(params.conversationId, params.userMessage, params.userImages);

  return { system, messages };
}

/**
 * Context composition for a roundtable turn.
 *
 * Differs from chat context:
 * - No persistent conversation history (roundtable turns replace it)
 * - All previous turns from this session are injected as a single user message
 * - The "user message" is the topic + prior turns formatted together
 */
export async function buildRoundtableContext(params: {
  agentSystemPrompt: string;
  agentId: number;
  agentRole: AgentRole;
  featureId: number;
  topic: string;
  priorTurns: Array<{ agentName: string; round: number; content: string }>;
}): Promise<{ system: TextBlockParam[]; messages: MessageParam[] }> {
  const feature = getFeatureById(params.featureId) ?? null;
  // Roundtables have no chat, so they see agent-wide and feature memories only.
  const memories = getMemoriesForContext({ agentId: params.agentId, featureId: params.featureId });
  const memoriesBlock = formatMemoriesForPrompt(memories);

  const parts = await buildSystemBlocks(params.agentSystemPrompt, feature, memoriesBlock, params.agentRole);
  const system = buildCachedSystemParam(parts);

  // Delivered as a single user message to avoid the model treating prior
  // agent turns as its own previous output.
  let contextMessage = `## Roundtable Topic\n${params.topic}`;

  if (params.priorTurns.length > 0) {
    const turnsStr = params.priorTurns
      .map((t) => `### ${t.agentName} (Round ${t.round})\n${t.content}`)
      .join('\n\n');
    contextMessage += `\n\n## Discussion So Far\n${turnsStr}`;
  }

  contextMessage += '\n\nProvide your contribution to this roundtable discussion.';

  const messages: MessageParam[] = [{ role: 'user', content: contextMessage }];

  return { system, messages };
}

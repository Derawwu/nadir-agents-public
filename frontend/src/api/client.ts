/**
 * Typed API client for the Nadir agents backend.
 *
 * All endpoints match the backend route definitions exactly.
 * SSE streaming endpoints expose an onEvent callback pattern rather than
 * returning a promise — callers register handlers and the function returns
 * a cleanup function to abort the stream if needed.
 */

const BASE = '/api';

// ─── Shared types (mirror backend types) ─────────────────────────────────────

export interface Agent {
  id: number;
  name: string;
  role: string;
  system_prompt: string;
  created_at: string;
}

export type FeatureStatus = 'backlog' | 'active' | 'review' | 'closed';
export type FeaturePhase = 'kickoff' | 'spec' | 'design' | 'build' | 'review';

export interface Feature {
  id: number;
  name: string;
  description: string | null;
  status: FeatureStatus;
  phase: FeaturePhase;
  locked_decisions: string[] | null;
  jira_key: string | null;
  jira_type: string | null;
  jira_parent_key: string | null;
  jira_status: string | null;
  jira_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export type MemoryType = 'decision' | 'lore' | 'technical' | 'visual' | 'flag' | 'conflict';

// ─── SSE event types emitted by the backend ──────────────────────────────────

/** What an action card shows before the user approves or declines a write. */
export interface ActionPreview {
  title: string;
  fields: { label: string; value: string }[];
  body?: string;
}

export type ToolCallStatus = 'pending' | 'done' | 'error' | 'rejected' | 'skipped';

/** One tool the agent called while writing a reply. */
export interface ToolCall {
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

/** A reply paused until the user decides on its actions. */
export interface PendingRun {
  runId: number;
  text: string;
  sources: ContextSource[];
  toolCalls: ToolCall[];
}

export type ChatSSEEvent =
  | { type: 'chunk'; text: string }
  | { type: 'sources'; sources: ContextSource[] }
  | { type: 'tool'; call: ToolCall }
  | { type: 'approval'; runId: number; calls: ToolCall[] }
  | { type: 'retract'; chars: number }
  | { type: 'done'; conversationId: number; slug: string | null; awaitingRunId: number | null }
  | { type: 'title'; conversationId: number; title: string; slug: string }
  | { type: 'error'; error: string };

export type RoundtableSSEEvent =
  | { type: 'roundtable_created'; roundtableId: number }
  | { type: 'round_start'; round: number }
  | { type: 'agent_start'; agentId: number; agentName: string; round: number }
  | { type: 'chunk'; agentId: number; agentName: string; round: number; chunk: string }
  | {
      type: 'agent_done';
      agentId: number;
      agentName: string;
      round: number;
      hasConflict: boolean;
      conflictSummary: string | null;
      conflictTarget: string | null;
    }
  | { type: 'roundtable_done'; status: 'completed' | 'terminated' }
  | { type: 'summarizing' }
  | {
      type: 'summary';
      summary: {
        decisions: string[];
        openConflicts: string[];
        actionItems: Record<string, string[]>;
      };
      outline: { saved: boolean };
    }
  | { type: 'error'; error: string };

// ─── Agents ──────────────────────────────────────────────────────────────────

export async function fetchAgents(): Promise<Agent[]> {
  const res = await fetch(`${BASE}/agents`);
  if (!res.ok) throw new Error(`fetchAgents failed: ${res.status}`);
  return res.json() as Promise<Agent[]>;
}

// ─── Features ────────────────────────────────────────────────────────────────

export async function fetchFeatures(): Promise<Feature[]> {
  const res = await fetch(`${BASE}/features`);
  if (!res.ok) throw new Error(`fetchFeatures failed: ${res.status}`);
  return res.json() as Promise<Feature[]>;
}

export async function createFeature(params: {
  name: string;
  description?: string;
  phase?: FeaturePhase;
  locked_decisions?: string[];
}): Promise<Feature> {
  const res = await fetch(`${BASE}/features`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`createFeature failed: ${res.status}`);
  return res.json() as Promise<Feature>;
}

export async function updateFeature(
  id: number,
  params: Partial<Pick<Feature, 'name' | 'description' | 'status' | 'phase' | 'locked_decisions'>>
): Promise<Feature> {
  const res = await fetch(`${BASE}/features/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`updateFeature failed: ${res.status}`);
  return res.json() as Promise<Feature>;
}

export async function syncPlane(): Promise<{ synced: number; skipped: number; timestamp: string }> {
  const res = await fetch(`${BASE}/plane/sync`, { method: 'POST' });
  if (!res.ok) throw new Error(`syncPlane failed: ${res.status}`);
  return res.json() as Promise<{ synced: number; skipped: number; timestamp: string }>;
}

export interface MessageImageRef {
  url: string;
  media_type: string;
}

/** An excerpt retrieval added to the request that produced a reply. */
export interface ContextSource {
  type: 'message' | 'wiki' | 'diagram';
  title: string | null;
  url: string | null;
  conversationId: number | null;
  chatSlug: string | null;
  messageId: number | null;
  role: string | null;
  createdAt: string;
  snippet: string;
  similarity: number | null;
  keywordMatch: boolean;
}

export interface StoredMessage {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  images?: MessageImageRef[];
  contextSources?: ContextSource[];
  toolCalls?: ToolCall[];
  created_at: string;
}

export interface Chat {
  id: number;
  agent_id: number;
  feature_id: number | null;
  title: string;
  /** URL segment, unique per agent: /chat/<agent>/<slug> */
  slug: string;
  pinned: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatDetail {
  chat: Chat;
  messages: StoredMessage[];
  pendingRun: PendingRun | null;
}

export async function fetchChats(agentId: number, includeArchived = false): Promise<Chat[]> {
  const params = new URLSearchParams({ agentId: String(agentId) });
  if (includeArchived) params.set('archived', '1');
  const res = await fetch(`${BASE}/chat/chats?${params}`);
  if (!res.ok) throw new Error(`fetchChats failed: ${res.status}`);
  return res.json() as Promise<Chat[]>;
}

/** Resolves a readable chat URL; returns null if no live chat has that slug. */
export async function fetchChatBySlug(agentId: number, slug: string): Promise<ChatDetail | null> {
  const params = new URLSearchParams({ agentId: String(agentId), slug });
  const res = await fetch(`${BASE}/chat/chats/by-slug?${params}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchChatBySlug failed: ${res.status}`);
  return res.json() as Promise<ChatDetail>;
}

/** URL segment for an agent: "Narrator" → "narrator", "UX/UI" → "ux-ui". */
export function agentSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export async function fetchChat(chatId: number): Promise<ChatDetail> {
  const res = await fetch(`${BASE}/chat/chats/${chatId}`);
  if (!res.ok) throw new Error(`fetchChat failed: ${res.status}`);
  return res.json() as Promise<ChatDetail>;
}

export async function updateChat(
  chatId: number,
  patch: Partial<{ title: string; pinned: boolean; archived: boolean; featureId: number | null }>
): Promise<Chat> {
  const res = await fetch(`${BASE}/chat/chats/${chatId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`updateChat failed: ${res.status}`);
  return res.json() as Promise<Chat>;
}

export async function deleteChat(chatId: number): Promise<void> {
  const res = await fetch(`${BASE}/chat/chats/${chatId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`deleteChat failed: ${res.status}`);
}

export type MemoryScope = 'chat' | 'feature' | 'agent';

export interface Memory {
  id: number;
  agent_id: number;
  feature_id: number | null;
  conversation_id: number | null;
  scope: MemoryScope;
  source: 'user' | 'roundtable';
  type: MemoryType;
  content: string;
  created_at: string;
}

export async function fetchMemories(
  agentId: number,
  ctx: { chatId: number | null; featureId: number | null }
): Promise<Memory[]> {
  const params = new URLSearchParams();
  if (ctx.chatId !== null) params.set('chatId', String(ctx.chatId));
  if (ctx.featureId !== null) params.set('featureId', String(ctx.featureId));
  const res = await fetch(`${BASE}/agents/${agentId}/memories?${params}`);
  if (!res.ok) throw new Error(`fetchMemories failed: ${res.status}`);
  return res.json() as Promise<Memory[]>;
}

export async function updateMemoryScope(
  agentId: number,
  memoryId: number,
  body: { scope: MemoryScope; chatId?: number | null; featureId?: number | null }
): Promise<Memory> {
  const res = await fetch(`${BASE}/agents/${agentId}/memories/${memoryId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`updateMemoryScope failed: ${res.status}`);
  return res.json() as Promise<Memory>;
}

// ─── Chat ─────────────────────────────────────────────────────────────────────

/**
 * Sends a chat message and streams the response.
 * Returns a cleanup function that aborts the request when called.
 */
/**
 * Posts to an SSE endpoint and dispatches each `data: <json>` event to onEvent.
 * Returns a cleanup function that aborts the in-flight request.
 */
function postSSE<T>(url: string, body: unknown, onEvent: (event: T) => void): () => void {
  const controller = new AbortController();

  (async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      onEvent({ type: 'error', error: `Request failed: ${res.status}` } as T);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6)) as T;
            onEvent(event);
          } catch {
            // Malformed event — skip silently.
          }
        }
      }
    }
  })().catch((err: unknown) => {
    if (err instanceof Error && err.name !== 'AbortError') {
      onEvent({ type: 'error', error: err.message } as T);
    }
  });

  return () => controller.abort();
}

export interface PendingImage {
  filename: string;
  media_type: string;
  url: string;
}

export function sendChatMessage(
  params: {
    agentId: number;
    featureId?: number | null;
    message: string;
    images?: { filename: string; media_type: string }[];
    conversationId?: number | null;
  },
  onEvent: (event: ChatSSEEvent) => void
): () => void {
  return postSSE<ChatSSEEvent>(`${BASE}/chat/message`, params, onEvent);
}

/**
 * Approves or declines a paused reply's actions (one decision per pending
 * call) and streams the rest of the reply with the same events as a message.
 */
export function resumeRun(
  runId: number,
  decisions: Record<number, 'approve' | 'reject'>,
  onEvent: (event: ChatSSEEvent) => void
): () => void {
  return postSSE<ChatSSEEvent>(`${BASE}/chat/runs/${runId}/resume`, { decisions }, onEvent);
}

/** Uploads a pasted image (as a data URL) and returns its stored filename + URL. */
export async function uploadChatImage(dataUrl: string): Promise<PendingImage> {
  const res = await fetch(`${BASE}/chat/upload-image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl }),
  });
  if (!res.ok) throw new Error(`uploadChatImage failed: ${res.status}`);
  return res.json() as Promise<PendingImage>;
}

export async function saveMemory(params: {
  conversationId: number;
  agentId: number;
  type: MemoryType;
  content: string;
}): Promise<{ memoryId: number }> {
  const res = await fetch(`${BASE}/chat/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`saveMemory failed: ${res.status}`);
  return res.json() as Promise<{ memoryId: number }>;
}

// ─── Roundtable ──────────────────────────────────────────────────────────────

/**
 * Starts a roundtable and streams progress events.
 * Returns a cleanup function that aborts the request.
 */
export function startRoundtable(
  params: { featureId: number; topic: string; agentIds?: number[] },
  onEvent: (event: RoundtableSSEEvent) => void
): () => void {
  return postSSE<RoundtableSSEEvent>(`${BASE}/roundtable/start`, params, onEvent);
}

/**
 * Sends a follow-up message into an existing (completed/terminated) roundtable,
 * running another discussion round among the given (or previous) participants.
 * Emits the same event types as startRoundtable, minus `roundtable_created`.
 */
export function continueRoundtable(
  roundtableId: number,
  params: { message: string; agentIds?: number[] },
  onEvent: (event: RoundtableSSEEvent) => void
): () => void {
  return postSSE<RoundtableSSEEvent>(
    `${BASE}/roundtable/${roundtableId}/continue`,
    params,
    onEvent
  );
}

// ─── Outline ──────────────────────────────────────────────────────────────────

export type OutlineAgentRole = 'narrator' | 'architect' | 'uxui' | 'analyst';

/** Maps agent display name (as stored in DB) to the Outline role key. */
export function agentNameToOutlineRole(name: string): OutlineAgentRole {
  if (name === 'UX/UI') return 'uxui';
  return name.toLowerCase() as OutlineAgentRole;
}

export interface WikiSearchResult {
  title: string;
  snippet: string;
  url: string;
}

export async function quickSearchWiki(params: {
  role: OutlineAgentRole;
  query: string;
}): Promise<WikiSearchResult[]> {
  const res = await fetch(`${BASE}/outline/quick-search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`quickSearchWiki failed: ${res.status}`);
  const data = (await res.json()) as { results: WikiSearchResult[] };
  return data.results;
}

export async function saveMemoryToWiki(params: {
  role: OutlineAgentRole;
  featureName: string;
  memoryType: string;
  content: string;
}): Promise<void> {
  const res = await fetch(`${BASE}/outline/memory`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(body.error ?? `saveMemoryToWiki failed: ${res.status}`);
  }
}

// ─── Wiki / Outline browse ────────────────────────────────────────────────────

export interface WikiDocumentMeta {
  id: string;
  title: string;
  collectionId: string;
  collectionName: string;
  updatedAt: string;
  url: string;
  parentDocumentId: string | null;
}

export interface WikiDocumentContent {
  id: string;
  title: string;
  text: string;
  url: string;
}

export async function browseWiki(params: {
  role: OutlineAgentRole;
  query?: string;
  collectionId?: string;
}): Promise<WikiDocumentMeta[]> {
  const res = await fetch(`${BASE}/outline/browse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`browseWiki failed: ${res.status}`);
  const data = (await res.json()) as { results: WikiDocumentMeta[] };
  return data.results;
}

export interface WikiCollection {
  id: string;
  name: string;
}

export async function fetchWikiCollections(): Promise<WikiCollection[]> {
  const res = await fetch(`${BASE}/outline/collections`);
  if (!res.ok) throw new Error(`fetchWikiCollections failed: ${res.status}`);
  const data = (await res.json()) as { collections: WikiCollection[] };
  return data.collections;
}

export async function fetchDocumentContent(params: {
  role: OutlineAgentRole;
  documentId: string;
}): Promise<WikiDocumentContent> {
  const res = await fetch(`${BASE}/outline/document-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`fetchDocumentContent failed: ${res.status}`);
  return res.json() as Promise<WikiDocumentContent>;
}

// ─── Plane browse ─────────────────────────────────────────────────────────────

export interface PlaneIssueMeta {
  id: number;
  jira_key: string | null;
  name: string;
  status: string;
  phase: string;
}

export interface PlaneIssueContent {
  id: number;
  jira_key: string | null;
  name: string;
  description: string | null;
  locked_decisions: string[] | null;
  status: string;
  phase: string;
  jira_status: string | null;
}

export async function browsePlane(params: {
  query?: string;
  status?: string;
}): Promise<PlaneIssueMeta[]> {
  const res = await fetch(`${BASE}/plane/browse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`browsePlane failed: ${res.status}`);
  const data = (await res.json()) as { results: PlaneIssueMeta[] };
  return data.results;
}

export async function fetchPlaneIssueContent(params: {
  featureId: number;
}): Promise<PlaneIssueContent> {
  const res = await fetch(`${BASE}/plane/issue-content`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  if (!res.ok) throw new Error(`fetchPlaneIssueContent failed: ${res.status}`);
  return res.json() as Promise<PlaneIssueContent>;
}

export async function terminateRoundtable(id: number): Promise<void> {
  const res = await fetch(`${BASE}/roundtable/${id}/terminate`, { method: 'POST' });
  if (!res.ok) throw new Error(`terminateRoundtable failed: ${res.status}`);
}

// ─── Diagrams (proxied to the standalone diagram-tool app) ───────────────────

export interface DiagramMeta {
  id: number;
  folder_id: number | null;
  name: string;
  description: string | null;
  folder_path: string;
  created_at: string;
  updated_at: string;
}

export async function fetchDiagramList(): Promise<DiagramMeta[]> {
  const res = await fetch(`${BASE}/diagrams/list`);
  if (!res.ok) throw new Error(`fetchDiagramList failed: ${res.status}`);
  const data = (await res.json()) as { diagrams: DiagramMeta[] };
  return data.diagrams;
}

export async function fetchDiagramAgentFormat(id: string): Promise<string> {
  const res = await fetch(`${BASE}/diagrams/${id}/agent-format`);
  if (!res.ok) throw new Error(`fetchDiagramAgentFormat failed: ${res.status}`);
  const data = (await res.json()) as { text: string };
  return data.text;
}

export interface RoundtableTurn {
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

export interface RoundtableDetail {
  roundtable: {
    id: number;
    feature_id: number;
    topic: string;
    status: string;
    current_round: number;
    max_rounds: number;
    created_at: string;
    updated_at: string;
  };
  turns: RoundtableTurn[];
}

export async function fetchRoundtable(id: number): Promise<RoundtableDetail> {
  const res = await fetch(`${BASE}/roundtable/${id}`);
  if (!res.ok) throw new Error(`fetchRoundtable failed: ${res.status}`);
  return res.json() as Promise<RoundtableDetail>;
}

// ─── Data export (Outline + Plane + diagrams snapshot) ───────────────────────

export type DataExportStatus = 'idle' | 'running' | 'success' | 'error';

export interface DataExportJobState {
  status: DataExportStatus;
  startedAt: string | null;
  finishedAt: string | null;
  message: string | null;
  commitHash: string | null;
  commitTimestamp: string | null;
}

export async function runDataExport(): Promise<DataExportJobState> {
  const res = await fetch(`${BASE}/data-export/run`, { method: 'POST' });
  if (res.status !== 202 && res.status !== 409) {
    throw new Error(`runDataExport failed: ${res.status}`);
  }
  return res.json() as Promise<DataExportJobState>;
}

export async function fetchDataExportStatus(): Promise<DataExportJobState> {
  const res = await fetch(`${BASE}/data-export/status`);
  if (!res.ok) throw new Error(`fetchDataExportStatus failed: ${res.status}`);
  return res.json() as Promise<DataExportJobState>;
}

// ─── Usage ───────────────────────────────────────────────────────────────────

export type UsageKind = 'chat' | 'roundtable_turn' | 'roundtable_summary' | 'title' | 'chat_summary' | 'eval';

export interface UsageTotals {
  calls: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number | null;
}

export interface UsageSummary {
  range: { days: number | null; kind: UsageKind | null };
  totals: UsageTotals;
  previous: UsageTotals | null;
  perMessage: { strategy: string; calls: number; avg_cost: number | null; avg_input: number | null }[];
  daily: { day: string; agentName: string | null; cost: number | null }[];
  byModel: { model: string; calls: number; cost: number | null }[];
  byKind: { kind: UsageKind; calls: number; cost: number | null }[];
  topChats: {
    id: number;
    title: string;
    slug: string;
    agentId: number;
    agentName: string;
    replies: number;
    avgInput: number | null;
    cacheRate: number | null;
    cost: number | null;
  }[];
  topRoundtables: { id: number; topic: string; calls: number; cacheRate: number | null; cost: number | null }[];
  windowedSince: string | null;
}

export interface ChatUsage {
  calls: number;
  cost: number;
  last: {
    inputTokens: number | null;
    outputTokens: number;
    cacheHitRate: number | null;
    cost: number | null;
    strategy: string | null;
    at: string;
  } | null;
}

export async function fetchUsageSummary(days: number | 'all', kind: UsageKind | null): Promise<UsageSummary> {
  const params = new URLSearchParams({ days: String(days) });
  if (kind) params.set('kind', kind);
  const res = await fetch(`${BASE}/usage/summary?${params}`);
  if (!res.ok) throw new Error(`Failed to fetch usage: ${res.status}`);
  return res.json() as Promise<UsageSummary>;
}

export async function fetchChatUsage(chatId: number): Promise<ChatUsage> {
  const res = await fetch(`${BASE}/usage/chats/${chatId}`);
  if (!res.ok) throw new Error(`Failed to fetch chat usage: ${res.status}`);
  return res.json() as Promise<ChatUsage>;
}

// ─── Model status ────────────────────────────────────────────────────────────

export type ModelIssue = 'upgrade' | 'deprecated' | 'unknown';

export interface ModelCheck {
  label: string;
  envVar: string;
  model: string;
  displayName: string | null;
  issues: ModelIssue[];
  latest: { id: string; displayName: string } | null;
  deprecatedAt: string | null;
  retiresAt: string | null;
}

export interface ModelStatus {
  checkedAt: string;
  upToDate: boolean;
  models: ModelCheck[];
}

export async function fetchModelStatus(): Promise<ModelStatus> {
  const res = await fetch(`${BASE}/models/status`);
  if (!res.ok) throw new Error(`Failed to check models: ${res.status}`);
  return res.json() as Promise<ModelStatus>;
}

// ─── Retrieval index ─────────────────────────────────────────────────────────

export interface RetrievalRebuildJob {
  status: 'idle' | 'running' | 'success' | 'error';
  message: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  embedded: number;
  toEmbed: number;
}

export interface RetrievalStatus {
  messageChunks: number;
  wikiChunks: number;
  diagramChunks: number;
  embedded: number;
  model: string;
  rebuild: RetrievalRebuildJob;
}

export async function fetchRetrievalStatus(): Promise<RetrievalStatus> {
  const res = await fetch(`${BASE}/retrieval/status`);
  if (!res.ok) throw new Error(`fetchRetrievalStatus failed: ${res.status}`);
  return res.json() as Promise<RetrievalStatus>;
}

/** Starts a full rebuild; resolves with the job (already running → the running job). */
export async function startRetrievalRebuild(): Promise<RetrievalRebuildJob> {
  const res = await fetch(`${BASE}/retrieval/rebuild`, { method: 'POST' });
  if (!res.ok && res.status !== 409) throw new Error(`startRetrievalRebuild failed: ${res.status}`);
  return res.json() as Promise<RetrievalRebuildJob>;
}

import dotenv from 'dotenv';
dotenv.config();

export interface OutlineDocument {
  id: string;
  title: string;
  text: string;
  collectionId: string;
  url: string;
  updatedAt: string;
}

export interface OutlineCollection {
  id: string;
  name: string;
}

export type AgentRole = 'narrator' | 'architect' | 'uxui' | 'analyst';

const ROLE_DISPLAY_NAME: Record<AgentRole, string> = {
  narrator: 'Narrator',
  architect: 'Architect',
  uxui: 'UX/UI',
  analyst: 'Analyst',
};

function getTokenForAgent(role: AgentRole): string {
  const map: Record<AgentRole, string | undefined> = {
    narrator: process.env.OUTLINE_TOKEN_NARRATOR,
    architect: process.env.OUTLINE_TOKEN_ARCHITECT,
    uxui: process.env.OUTLINE_TOKEN_UXUI,
    analyst: process.env.OUTLINE_TOKEN_ANALYST,
  };
  const token = map[role];
  if (!token) throw new Error(`Missing Outline token for agent role: ${role}`);
  return token;
}

async function fetchFromOutline(
  path: string,
  body: Record<string, unknown>,
  token: string
): Promise<unknown> {
  const baseUrl = process.env.OUTLINE_BASE_URL ?? 'http://localhost:3002';
  const res = await fetch(`${baseUrl}/api/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Outline API error ${res.status} at ${path}: ${errorText}`);
  }

  return res.json();
}

export async function getCollections(role: AgentRole): Promise<OutlineCollection[]> {
  const token = getTokenForAgent(role);
  const data = (await fetchFromOutline('collections.list', {}, token)) as {
    data: OutlineCollection[];
  };
  return data.data ?? [];
}

export async function getOrCreateCollection(role: AgentRole, name: string): Promise<string> {
  const collections = await getCollections(role);
  const existing = collections.find((c) => c.name === name);
  if (existing) return existing.id;

  const token = getTokenForAgent(role);
  const data = (await fetchFromOutline(
    'collections.create',
    { name, private: false },
    token
  )) as { data: OutlineCollection };
  return data.data.id;
}

const OUTLINE_TITLE_MAX_LENGTH = 100;

function truncateTitle(title: string, max: number = OUTLINE_TITLE_MAX_LENGTH): string {
  if (title.length <= max) return title;
  return `${title.slice(0, max - 1)}…`;
}

export async function createDocument(params: {
  role: AgentRole;
  title: string;
  text: string;
  collectionId: string;
  publish?: boolean;
}): Promise<OutlineDocument> {
  if (params.role === 'analyst') throw new Error('Analyst has read-only access');
  const token = getTokenForAgent(params.role);
  const data = (await fetchFromOutline(
    'documents.create',
    {
      title: truncateTitle(params.title),
      text: params.text,
      collectionId: params.collectionId,
      publish: params.publish ?? true,
    },
    token
  )) as { data: OutlineDocument };
  return data.data;
}

export async function updateDocument(params: {
  role: AgentRole;
  documentId: string;
  title?: string;
  text?: string;
}): Promise<OutlineDocument> {
  if (params.role === 'analyst') throw new Error('Analyst has read-only access');
  const token = getTokenForAgent(params.role);
  const body: Record<string, unknown> = { id: params.documentId };
  if (params.title !== undefined) body.title = truncateTitle(params.title);
  if (params.text !== undefined) body.text = params.text;
  const data = (await fetchFromOutline('documents.update', body, token)) as {
    data: OutlineDocument;
  };
  return data.data;
}

export interface OutlineDocumentMeta {
  id: string;
  title: string;
  collectionId: string;
  collectionName: string;
  updatedAt: string;
  url: string;
  parentDocumentId: string | null;
}

export async function listDocuments(role: AgentRole, collectionId?: string): Promise<OutlineDocumentMeta[]> {
  const token = getTokenForAgent(role);
  const body: Record<string, unknown> = { limit: 100 };
  if (collectionId) body.collectionId = collectionId;

  const [docsResult, collections] = await Promise.all([
    fetchFromOutline('documents.list', body, token) as Promise<{
      data: Array<{
        id: string;
        title: string;
        collectionId: string;
        url: string;
        updatedAt: string;
        parentDocumentId: string | null;
      }>;
    }>,
    getCollections(role),
  ]);

  const collectionMap = new Map(collections.map((c) => [c.id, c.name]));

  return (docsResult.data ?? []).map((doc) => ({
    id: doc.id,
    title: doc.title,
    collectionId: doc.collectionId,
    collectionName: collectionMap.get(doc.collectionId) ?? '',
    updatedAt: doc.updatedAt,
    url: doc.url,
    parentDocumentId: doc.parentDocumentId ?? null,
  }));
}

export async function getDocumentById(role: AgentRole, documentId: string): Promise<OutlineDocument> {
  const token = getTokenForAgent(role);
  const data = (await fetchFromOutline('documents.info', { id: documentId }, token)) as { data: OutlineDocument };
  return data.data;
}

export async function browseDocuments(role: AgentRole, query?: string, collectionId?: string): Promise<OutlineDocumentMeta[]> {
  if (query && query.trim()) {
    const [docs, collections] = await Promise.all([
      searchDocuments(role, query),
      getCollections(role),
    ]);
    const collectionMap = new Map(collections.map((c) => [c.id, c.name]));
    return docs.slice(0, 20).map((doc) => ({
      id: doc.id,
      title: doc.title,
      collectionId: doc.collectionId,
      collectionName: collectionMap.get(doc.collectionId) ?? '',
      updatedAt: doc.updatedAt,
      url: doc.url,
      parentDocumentId: null,
    }));
  }
  return listDocuments(role, collectionId);
}

export async function searchDocuments(
  role: AgentRole,
  query: string
): Promise<OutlineDocument[]> {
  const token = getTokenForAgent(role);
  const data = (await fetchFromOutline('documents.search', { query }, token)) as {
    data: Array<{ document: OutlineDocument }>;
  };
  return (data.data ?? []).map((item) => item.document);
}

export async function saveRoundtableSummary(params: {
  featureName: string;
  topic: string;
  summary: string;
  decisions: string[];
  conflicts: string[];
  actionItems: Record<string, string[]>;
  agentRoles: AgentRole[];
}): Promise<OutlineDocument> {
  const collectionId = await getOrCreateCollection('narrator', 'Roundtable Summaries');
  const date = new Date().toISOString().split('T')[0] as string;
  const title = `[ROUNDTABLE] ${params.featureName} — ${params.topic} (${date})`;

  const decisionsSection =
    params.decisions.length > 0
      ? params.decisions.map((d) => `- ${d}`).join('\n')
      : '_None_';

  const conflictsSection =
    params.conflicts.length > 0
      ? params.conflicts.map((c) => `- ${c}`).join('\n')
      : '_None_';

  const actionItemsSection = Object.entries(params.actionItems)
    .map(([agent, items]) => {
      if (items.length === 0) return `### ${agent}\n_None_`;
      return `### ${agent}\n${items.map((i) => `- ${i}`).join('\n')}`;
    })
    .join('\n\n');

  const text = [
    `## Feature`,
    params.featureName,
    ``,
    `## Topic`,
    params.topic,
    ``,
    `## Decisions Reached`,
    decisionsSection,
    ``,
    `## Open Conflicts`,
    conflictsSection,
    ``,
    `## Action Items`,
    actionItemsSection,
  ].join('\n');

  return createDocument({
    role: 'narrator',
    title,
    text,
    collectionId,
  });
}

export async function saveMemoryToOutline(params: {
  role: AgentRole;
  featureName: string;
  memoryType: string;
  content: string;
}): Promise<void> {
  const collectionName = ROLE_DISPLAY_NAME[params.role];
  const collectionId = await getOrCreateCollection(params.role, collectionName);
  const date = new Date().toISOString().split('T')[0] as string;
  const title = `[${params.memoryType.toUpperCase()}] ${params.featureName} — ${date}`;

  await createDocument({
    role: params.role,
    title,
    text: params.content,
    collectionId,
  });
}

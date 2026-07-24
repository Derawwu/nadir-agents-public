const BASE = '/api/diagrams';

export interface DiagramFolder {
  id: number;
  name: string;
  parent_id: number | null;
  created_at: string;
}

export interface DiagramSummary {
  id: number;
  folder_id: number | null;
  name: string;
  description: string | null;
  folder_path: string;
  created_at: string;
  updated_at: string;
}

export interface GraphNode {
  id: string;
  position: { x: number; y: number };
  data: { label: string; notes?: string; kind?: string };
  type?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  data?: { dependency?: boolean };
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Diagram {
  id: number;
  folder_id: number | null;
  name: string;
  description: string | null;
  graph_json: string;
  created_at: string;
  updated_at: string;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `Request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export function fetchFolders(): Promise<DiagramFolder[]> {
  return request<{ folders: DiagramFolder[] }>('/folders').then((r) => r.folders);
}

export function createFolder(name: string, parentId: number | null = null): Promise<DiagramFolder> {
  return request<{ folder: DiagramFolder }>('/folders', {
    method: 'POST',
    body: JSON.stringify({ name, parent_id: parentId }),
  }).then((r) => r.folder);
}

export function renameFolder(id: number, name: string): Promise<DiagramFolder> {
  return request<{ folder: DiagramFolder }>(`/folders/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  }).then((r) => r.folder);
}

export function deleteFolder(id: number): Promise<void> {
  return request(`/folders/${id}`, { method: 'DELETE' }).then(() => undefined);
}

export function fetchDiagrams(folderId?: number): Promise<DiagramSummary[]> {
  const qs = folderId !== undefined ? `?folder_id=${folderId}` : '';
  return request<{ diagrams: DiagramSummary[] }>(`${qs}`).then((r) => r.diagrams);
}

export function createDiagram(name: string, folderId: number | null): Promise<Diagram> {
  return request<{ diagram: Diagram }>('', {
    method: 'POST',
    body: JSON.stringify({ name, folder_id: folderId }),
  }).then((r) => r.diagram);
}

export function fetchDiagram(id: number): Promise<Diagram> {
  return request<{ diagram: Diagram }>(`/${id}`).then((r) => r.diagram);
}

export function updateDiagram(
  id: number,
  updates: { name?: string; description?: string; graph_json?: string; folder_id?: number | null }
): Promise<Diagram> {
  return request<{ diagram: Diagram }>(`/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  }).then((r) => r.diagram);
}

export function deleteDiagram(id: number): Promise<void> {
  return request(`/${id}`, { method: 'DELETE' }).then(() => undefined);
}

export function fetchAgentFormat(id: number): Promise<string> {
  return request<{ text: string }>(`/${id}/agent-format`).then((r) => r.text);
}

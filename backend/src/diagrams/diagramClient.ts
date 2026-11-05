/**
 * Thin proxy client for the standalone diagram-tool app (separate repo folder,
 * own DB, own port — see diagram-tool/). Mirrors outlineService's fetch pattern.
 */

import dotenv from 'dotenv';
dotenv.config();

export interface DiagramSummary {
  id: number;
  folder_id: number | null;
  name: string;
  description: string | null;
  folder_path: string;
  created_at: string;
  updated_at: string;
}

function getBaseUrl(): string {
  return process.env.DIAGRAM_TOOL_BASE_URL ?? 'http://localhost:3010';
}

async function fetchFromDiagramTool(path: string): Promise<unknown> {
  const res = await fetch(`${getBaseUrl()}/api/diagrams${path}`);
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Diagram tool API error ${res.status} at ${path}: ${errorText}`);
  }
  return res.json();
}

export async function listDiagramsFromTool(): Promise<DiagramSummary[]> {
  const data = (await fetchFromDiagramTool('')) as { diagrams: DiagramSummary[] };
  return data.diagrams;
}

export async function getAgentFormatFromTool(id: number): Promise<string | null> {
  try {
    const data = (await fetchFromDiagramTool(`/${id}/agent-format`)) as { text: string };
    return data.text;
  } catch {
    return null;
  }
}

// ─── Graph read / write (used by the add_to_diagram agent tool) ─────────────

export interface DiagramGraphNode {
  id: string;
  position: { x: number; y: number };
  data: { label: string; notes?: string; kind?: string };
  type?: string;
}

export interface DiagramGraphEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  data?: { dependency?: boolean };
}

export interface DiagramGraph {
  nodes: DiagramGraphNode[];
  edges: DiagramGraphEdge[];
}

export interface DiagramDetail extends DiagramSummary {
  graph: DiagramGraph;
}

export async function getDiagramFromTool(id: number): Promise<DiagramDetail> {
  const data = (await fetchFromDiagramTool(`/${id}`)) as { diagram: DiagramSummary & { graph_json: string } };
  const { graph_json, ...summary } = data.diagram;
  let graph: DiagramGraph = { nodes: [], edges: [] };
  try {
    const parsed = JSON.parse(graph_json) as Partial<DiagramGraph>;
    graph = { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
  } catch {
    // An unparseable graph is treated as empty; the write below replaces it.
  }
  return { ...summary, graph };
}

export async function saveDiagramGraph(id: number, graph: DiagramGraph): Promise<void> {
  const res = await fetch(`${getBaseUrl()}/api/diagrams/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ graph_json: JSON.stringify(graph) }),
  });
  if (!res.ok) throw new Error(`Diagram tool API error ${res.status} saving diagram ${id}: ${await res.text()}`);
}

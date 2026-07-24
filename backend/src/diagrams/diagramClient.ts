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

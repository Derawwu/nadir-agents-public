import db from '../db/connection';

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

export interface Diagram extends DiagramSummary {
  graph_json: string;
}

interface FolderRow {
  id: number;
  name: string;
  parent_id: number | null;
  created_at: string;
}

interface DiagramRow {
  id: number;
  folder_id: number | null;
  name: string;
  description: string | null;
  graph_json: string;
  created_at: string;
  updated_at: string;
}

function parseGraph(graphJson: string): Graph {
  try {
    const parsed = JSON.parse(graphJson) as Partial<Graph>;
    return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
  } catch {
    return { nodes: [], edges: [] };
  }
}

// ── Folders ──────────────────────────────────────────────────────────────

export function listFolders(): DiagramFolder[] {
  return db.prepare('SELECT * FROM diagram_folders ORDER BY name').all() as unknown as DiagramFolder[];
}

export function createFolder(name: string, parentId: number | null): DiagramFolder {
  const result = db
    .prepare('INSERT INTO diagram_folders (name, parent_id) VALUES (?, ?)')
    .run(name, parentId);
  return db
    .prepare('SELECT * FROM diagram_folders WHERE id = ?')
    .get(Number(result.lastInsertRowid)) as unknown as DiagramFolder;
}

export function renameFolder(id: number, name: string): DiagramFolder | null {
  db.prepare('UPDATE diagram_folders SET name = ? WHERE id = ?').run(name, id);
  return db.prepare('SELECT * FROM diagram_folders WHERE id = ?').get(id) as unknown as DiagramFolder | undefined ?? null;
}

export function deleteFolder(id: number): void {
  db.prepare('UPDATE diagrams SET folder_id = NULL WHERE folder_id = ?').run(id);
  db.prepare('UPDATE diagram_folders SET parent_id = NULL WHERE parent_id = ?').run(id);
  db.prepare('DELETE FROM diagram_folders WHERE id = ?').run(id);
}

export function getFolderPath(folderId: number | null): string {
  if (folderId === null) return '';
  const parts: string[] = [];
  let currentId: number | null = folderId;
  const seen = new Set<number>();

  while (currentId !== null && !seen.has(currentId)) {
    seen.add(currentId);
    const row = db.prepare('SELECT * FROM diagram_folders WHERE id = ?').get(currentId) as
      | FolderRow
      | undefined;
    if (!row) break;
    parts.unshift(row.name);
    currentId = row.parent_id;
  }

  return parts.join(' / ');
}

// ── Diagrams ─────────────────────────────────────────────────────────────

export function listDiagrams(folderId?: number): DiagramSummary[] {
  const rows = (
    folderId !== undefined
      ? db.prepare('SELECT id, folder_id, name, description, created_at, updated_at FROM diagrams WHERE folder_id = ? ORDER BY name').all(folderId)
      : db.prepare('SELECT id, folder_id, name, description, created_at, updated_at FROM diagrams ORDER BY name').all()
  ) as unknown as DiagramSummary[];
  return rows;
}

export function createDiagram(name: string, folderId: number | null, description?: string): Diagram {
  const result = db
    .prepare('INSERT INTO diagrams (folder_id, name, description) VALUES (?, ?, ?)')
    .run(folderId, name, description ?? null);
  return getDiagram(Number(result.lastInsertRowid)) as Diagram;
}

export function getDiagram(id: number): Diagram | null {
  const row = db.prepare('SELECT * FROM diagrams WHERE id = ?').get(id) as DiagramRow | undefined;
  return row ?? null;
}

export function updateDiagram(
  id: number,
  updates: { name?: string; description?: string; graph_json?: string; folder_id?: number | null }
): Diagram | null {
  const existing = getDiagram(id);
  if (!existing) return null;

  const name = updates.name ?? existing.name;
  const description = updates.description !== undefined ? updates.description : existing.description;
  const graphJson = updates.graph_json ?? existing.graph_json;
  const folderId = updates.folder_id !== undefined ? updates.folder_id : existing.folder_id;

  db.prepare(
    `UPDATE diagrams SET name = ?, description = ?, graph_json = ?, folder_id = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(name, description, graphJson, folderId, id);

  return getDiagram(id);
}

export function deleteDiagram(id: number): void {
  db.prepare('DELETE FROM diagrams WHERE id = ?').run(id);
}

// ── Agent-readable export ───────────────────────────────────────────────

function sanitizeForMermaid(text: string): string {
  return text.replace(/"/g, '\\"').replace(/\r?\n/g, ' ').trim();
}

export function serializeDiagramForAgent(id: number): string | null {
  const diagram = getDiagram(id);
  if (!diagram) return null;

  const graph = parseGraph(diagram.graph_json);
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...graph.edges].sort((a, b) => a.id.localeCompare(b.id));
  const folderPath = getFolderPath(diagram.folder_id);

  const nodeLabelById = new Map(nodes.map((n) => [n.id, n.data.label]));

  // Mermaid flowchart block
  const mermaidLines: string[] = ['flowchart TD'];
  for (const node of nodes) {
    mermaidLines.push(`  ${node.id}["${sanitizeForMermaid(node.data.label)}"]`);
  }
  for (const edge of edges) {
    const label = edge.label ? sanitizeForMermaid(edge.label) : '';
    mermaidLines.push(
      label ? `  ${edge.source} -->|${label}| ${edge.target}` : `  ${edge.source} --> ${edge.target}`
    );
  }
  const mermaidBlock = ['```mermaid', ...mermaidLines, '```'].join('\n');

  // Structured dependency listing
  const nodeLines = nodes.map((n) => {
    const parts = [`- [${n.id}] ${n.data.label}`];
    if (n.data.kind) parts.push(`(kind: ${n.data.kind})`);
    if (n.data.notes) parts.push(`— notes: ${n.data.notes}`);
    return parts.join(' ');
  });

  const edgeLines = edges.map((e) => {
    const src = nodeLabelById.get(e.source) ?? e.source;
    const tgt = nodeLabelById.get(e.target) ?? e.target;
    const suffix: string[] = [];
    if (e.label) suffix.push(`label: "${e.label}"`);
    if (e.data?.dependency) suffix.push('dependency: true');
    return `- ${src} --> ${tgt}${suffix.length ? '  (' + suffix.join(', ') + ')' : ''}`;
  });

  const incoming = new Set(edges.map((e) => e.target));
  const outgoing = new Set(edges.map((e) => e.source));
  const roots = nodes.filter((n) => !incoming.has(n.id)).map((n) => n.data.label);
  const leaves = nodes.filter((n) => !outgoing.has(n.id)).map((n) => n.data.label);

  const listingBlock = [
    'Nodes:',
    ...(nodeLines.length ? nodeLines : ['(none)']),
    '',
    'Dependencies (edges):',
    ...(edgeLines.length ? edgeLines : ['(none)']),
    '',
    `Roots (no incoming edges): ${roots.length ? roots.join(', ') : '(none)'}`,
    `Leaves (no outgoing edges): ${leaves.length ? leaves.join(', ') : '(none)'}`,
  ].join('\n');

  const metadataBlock = [
    `Diagram: ${diagram.name}`,
    `Folder: ${folderPath || '(root)'}`,
    `Nodes: ${nodes.length}, Edges: ${edges.length}`,
    `Last updated: ${diagram.updated_at}`,
  ].join('\n');

  return [metadataBlock, mermaidBlock, listingBlock].join('\n\n');
}

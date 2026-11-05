/**
 * Write tools: each one shows an action card first and only runs once the
 * user approves it. There are deliberately no delete tools.
 */

import { z } from 'zod';
import { createDocument, getDocumentById, getOrCreateCollection, updateDocument } from '../outline/outlineService';
import { addIssueComment, createIssue, PLANE_PRIORITIES, updateIssue } from '../plane/planeService';
import { getFeatureContent } from '../plane/planeService';
import { getDiagramFromTool, saveDiagramGraph, type DiagramGraphEdge, type DiagramGraphNode } from '../diagrams/diagramClient';
import { MEMORY_TYPES, saveMemory } from '../agents/memoryService';
import type { AgentRole } from '../agents/modelConfig';
import { defineWrite, type WriteTool } from './types';

const OUTLINE_BASE_URL = (process.env.OUTLINE_BASE_URL ?? 'http://localhost:3002').replace(/\/$/, '');
const DIAGRAM_APP_URL = (process.env.DIAGRAM_APP_URL ?? 'http://localhost:5173/diagrams').replace(/\/$/, '');

/** Agents that can change the wiki and Plane; the analyst only reads, as in Outline. */
const EDITORS: AgentRole[] = ['narrator', 'architect', 'uxui'];

const ROLE_COLLECTION: Record<AgentRole, string> = {
  narrator: 'Narrator',
  architect: 'Architect',
  uxui: 'UX/UI',
  analyst: 'Analyst',
};

const APPROVAL_NOTE = ' The user sees a preview and approves or declines it before it runs.';

const priority = z.enum(PLANE_PRIORITIES);
const state = z
  .string()
  .max(40)
  .describe('Plane state name ("In Progress"), state group ("started") or status ("backlog", "active", "closed")');

function issueLabel(featureId: number): string {
  const f = getFeatureContent(featureId);
  return f ? `${f.jira_key ? `${f.jira_key} ` : ''}${f.name}` : `feature ${featureId}`;
}

function optionalFields(fields: [string, string | undefined][]): { label: string; value: string }[] {
  return fields.filter((f): f is [string, string] => f[1] !== undefined).map(([label, value]) => ({ label, value }));
}

const createWikiPage = defineWrite({
  name: 'create_wiki_page',
  roles: EDITORS,
  description:
    'Create a new wiki page in Outline. Use markdown. Defaults to your own collection. ' +
    'Check list_wiki_pages first so you update an existing page instead of duplicating it.' +
    APPROVAL_NOTE,
  schema: z.object({
    title: z.string().min(1).max(100),
    text: z.string().min(1).max(50_000).describe('Page body in markdown'),
    collection: z.string().min(1).max(100).optional().describe('Collection name; created if missing'),
  }),
  preview({ title, text, collection }, ctx) {
    return {
      title: 'Create wiki page',
      fields: [
        { label: 'Title', value: title },
        { label: 'Collection', value: collection ?? ROLE_COLLECTION[ctx.role] },
      ],
      body: text,
    };
  },
  async run({ title, text, collection }, ctx) {
    const collectionId = await getOrCreateCollection(ctx.role, collection ?? ROLE_COLLECTION[ctx.role]);
    const doc = await createDocument({ role: ctx.role, title, text, collectionId });
    return {
      content: `Created wiki page "${doc.title}" (id: ${doc.id}).`,
      summary: `Created wiki page "${doc.title}"`,
      url: `${OUTLINE_BASE_URL}${doc.url}`,
    };
  },
});

const updateWikiPage = defineWrite({
  name: 'update_wiki_page',
  roles: EDITORS,
  description:
    'Edit an existing wiki page: append a section (mode "append", safest) or replace the whole text (mode "replace"; ' +
    'read the page first and keep what should stay). Optionally rename it.' +
    APPROVAL_NOTE,
  schema: z.object({
    id: z.string().min(1).describe('Wiki page id'),
    mode: z.enum(['append', 'replace']),
    text: z.string().min(1).max(50_000).describe('Markdown to append, or the full new text'),
    title: z.string().min(1).max(100).optional().describe('New title'),
  }),
  async preview({ id, mode, text, title }, ctx) {
    const doc = await getDocumentById(ctx.role, id);
    return {
      title: mode === 'append' ? 'Append to wiki page' : 'Replace wiki page text',
      fields: optionalFields([
        ['Page', doc.title],
        ['New title', title],
        ['Current length', `${doc.text.length} characters`],
      ]),
      body: text,
    };
  },
  async run({ id, mode, text, title }, ctx) {
    const current = await getDocumentById(ctx.role, id);
    const newText = mode === 'append' ? `${current.text.trimEnd()}\n\n${text}` : text;
    const doc = await updateDocument({ role: ctx.role, documentId: id, text: newText, title });
    return {
      content: `Updated wiki page "${doc.title}" (${mode}).`,
      summary: `${mode === 'append' ? 'Appended to' : 'Rewrote'} wiki page "${doc.title}"`,
      url: `${OUTLINE_BASE_URL}${doc.url}`,
    };
  },
});

const createPlaneIssue = defineWrite({
  name: 'create_plane_issue',
  roles: EDITORS,
  description:
    'Create a Plane work item (issue). The description takes markdown-style headings (#) and bullets (-).' + APPROVAL_NOTE,
  schema: z.object({
    name: z.string().min(1).max(255),
    description: z.string().max(20_000).optional(),
    state: state.optional(),
    priority: priority.optional(),
  }),
  preview({ name, description, state, priority }) {
    return {
      title: 'Create Plane issue',
      fields: optionalFields([
        ['Title', name],
        ['State', state ?? 'Backlog'],
        ['Priority', priority],
      ]),
      body: description,
    };
  },
  async run(input, ctx) {
    const r = await createIssue(ctx.role, input);
    return { content: `Created ${r.key} "${r.name}" (feature id: ${r.featureId}).`, summary: `Created ${r.key} "${r.name}"`, url: r.url };
  },
});

const updatePlaneIssue = defineWrite({
  name: 'update_plane_issue',
  roles: EDITORS,
  description:
    'Change a Plane work item: title, description (replaces it), state or priority. ' +
    'Prefer comment_on_plane_issue for notes, so the description the user wrote is kept.' +
    APPROVAL_NOTE,
  schema: z.object({
    feature_id: z.number().int().positive(),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(20_000).optional(),
    state: state.optional(),
    priority: priority.optional(),
  }),
  preview({ feature_id, name, description, state, priority }) {
    return {
      title: 'Update Plane issue',
      fields: optionalFields([
        ['Issue', issueLabel(feature_id)],
        ['New title', name],
        ['State', state],
        ['Priority', priority],
        ['Description', description !== undefined ? 'replaced (below)' : undefined],
      ]),
      body: description,
    };
  },
  async run({ feature_id, ...fields }, ctx) {
    const r = await updateIssue(ctx.role, feature_id, fields);
    return { content: `Updated ${r.key} "${r.name}".`, summary: `Updated ${r.key} "${r.name}"`, url: r.url };
  },
});

const commentOnPlaneIssue = defineWrite({
  name: 'comment_on_plane_issue',
  roles: EDITORS,
  description: 'Add a comment to a Plane work item, as your own Plane user.' + APPROVAL_NOTE,
  schema: z.object({
    feature_id: z.number().int().positive(),
    text: z.string().min(1).max(20_000),
  }),
  preview({ feature_id, text }) {
    return { title: 'Comment on Plane issue', fields: [{ label: 'Issue', value: issueLabel(feature_id) }], body: text };
  },
  async run({ feature_id, text }, ctx) {
    const r = await addIssueComment(ctx.role, feature_id, text);
    return { content: `Commented on ${r.key}.`, summary: `Commented on ${r.key} "${r.name}"`, url: r.url };
  },
});

const diagramNode = z.object({
  label: z.string().min(1).max(120),
  kind: z.string().max(40).optional().describe('Node kind, e.g. system, mechanic, screen'),
  notes: z.string().max(2000).optional(),
});
const diagramEdge = z.object({
  from: z.string().min(1).describe('Label or id of an existing or new node'),
  to: z.string().min(1).describe('Label or id of an existing or new node'),
  label: z.string().max(120).optional(),
  dependency: z.boolean().optional().describe('True if "from" depends on "to"'),
});

const addToDiagram = defineWrite({
  name: 'add_to_diagram',
  roles: EDITORS,
  description:
    'Add nodes and edges to an existing diagram. Edges refer to nodes by label (existing or new) or id. ' +
    'Nothing already in the diagram is changed or removed. Read the diagram first.' +
    APPROVAL_NOTE,
  schema: z.object({
    diagram_id: z.number().int().positive(),
    nodes: z.array(diagramNode).max(30).default([]),
    edges: z.array(diagramEdge).max(60).default([]),
  }),
  async preview({ diagram_id, nodes, edges }) {
    const d = await getDiagramFromTool(diagram_id);
    const lines = [
      ...nodes.map((n) => `+ node: ${n.label}${n.kind ? ` [${n.kind}]` : ''}${n.notes ? ` — ${n.notes}` : ''}`),
      ...edges.map((e) => `+ edge: ${e.from} → ${e.to}${e.label ? ` (${e.label})` : ''}${e.dependency ? ' [depends on]' : ''}`),
    ];
    return {
      title: 'Add to diagram',
      fields: [
        { label: 'Diagram', value: d.name },
        { label: 'Adds', value: `${nodes.length} nodes, ${edges.length} edges` },
      ],
      body: lines.join('\n'),
    };
  },
  async run({ diagram_id, nodes, edges }) {
    if (nodes.length === 0 && edges.length === 0) throw new Error('Nothing to add');
    const d = await getDiagramFromTool(diagram_id);
    const graph = { nodes: [...d.graph.nodes], edges: [...d.graph.edges] };
    const stamp = Date.now().toString(36);

    // Place new nodes in a row under the existing ones.
    const maxY = graph.nodes.reduce((m, n) => Math.max(m, n.position.y), 0);
    const minX = graph.nodes.length ? Math.min(...graph.nodes.map((n) => n.position.x)) : 0;
    const added: DiagramGraphNode[] = nodes.map((n, i) => ({
      id: `agent-${stamp}-${i}`,
      position: { x: minX + i * 220, y: graph.nodes.length ? maxY + 160 : 0 },
      data: { label: n.label, ...(n.kind ? { kind: n.kind } : {}), ...(n.notes ? { notes: n.notes } : {}) },
    }));
    graph.nodes.push(...added);

    const resolve = (ref: string): string => {
      const r = ref.trim().toLowerCase();
      const hit = graph.nodes.find((n) => n.id.toLowerCase() === r) ?? graph.nodes.find((n) => n.data.label.trim().toLowerCase() === r);
      if (!hit) throw new Error(`No node "${ref}" in diagram "${d.name}"`);
      return hit.id;
    };
    const newEdges: DiagramGraphEdge[] = edges.map((e, i) => ({
      id: `agent-${stamp}-e${i}`,
      source: resolve(e.from),
      target: resolve(e.to),
      ...(e.label ? { label: e.label } : {}),
      ...(e.dependency ? { data: { dependency: true } } : {}),
    }));
    graph.edges.push(...newEdges);

    await saveDiagramGraph(diagram_id, graph);
    return {
      content: `Added ${added.length} nodes and ${newEdges.length} edges to diagram "${d.name}".`,
      summary: `Added ${added.length} nodes, ${newEdges.length} edges to "${d.name}"`,
      url: DIAGRAM_APP_URL,
    };
  },
});

const saveMemoryTool = defineWrite({
  name: 'save_memory',
  description:
    'Save a memory you will see in future sessions: a decision, lore, technical note, visual note, flag or conflict. ' +
    'Scope "chat" = this chat only, "feature" = every chat on this chat\'s feature, "agent" = all your chats.' +
    APPROVAL_NOTE,
  schema: z.object({
    type: z.enum(MEMORY_TYPES as [string, ...string[]]),
    content: z.string().min(1).max(4000),
    scope: z.enum(['chat', 'feature', 'agent']).default('chat'),
  }),
  preview({ type, content, scope }, ctx) {
    return {
      title: 'Save memory',
      fields: [
        { label: 'Type', value: type },
        { label: 'Scope', value: scope === 'feature' && !ctx.featureId ? 'chat (no feature on this chat)' : scope },
      ],
      body: content,
    };
  },
  async run({ type, content, scope }, ctx) {
    const effective = scope === 'feature' && !ctx.featureId ? 'chat' : scope;
    const id = saveMemory({
      agentId: ctx.agentId,
      featureId: ctx.featureId,
      conversationId: ctx.conversationId,
      scope: effective,
      type: type as (typeof MEMORY_TYPES)[number],
      content,
    });
    return { content: `Saved ${type} memory #${id} (${effective} scope).`, summary: `Saved ${type} memory (${effective})` };
  },
});

export const WRITE_TOOLS: WriteTool[] = [
  createWikiPage,
  updateWikiPage,
  createPlaneIssue,
  updatePlaneIssue,
  commentOnPlaneIssue,
  addToDiagram,
  saveMemoryTool,
];

/**
 * Read tools: run as soon as the agent calls them, no approval.
 */

import { z } from 'zod';
import { searchChunks } from '../retrieval/search';
import { browseDocuments, getDocumentById } from '../outline/outlineService';
import { getAgentFormatFromTool, listDiagramsFromTool } from '../diagrams/diagramClient';
import { browseFeatures, getFeatureContent } from '../plane/planeService';
import { defineRead, type ReadTool } from './types';

const OUTLINE_BASE_URL = (process.env.OUTLINE_BASE_URL ?? 'http://localhost:3002').replace(/\/$/, '');
const MAX_PAGE_CHARS = 20_000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated, ${text.length - max} more characters]` : text;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

const searchKnowledge = defineRead({
  name: 'search_knowledge',
  description:
    'Search the project knowledge base: your earlier chats, wiki pages and diagrams. Hybrid keyword + semantic search. ' +
    'Relevant excerpts for the latest message are already in <context>; use this for follow-up lookups, other phrasings, ' +
    'or a different topic. Results give ids for read_wiki_page and read_diagram.',
  schema: z.object({
    query: z.string().min(2).max(300).describe('What to look for, in natural language or keywords'),
    sources: z
      .array(z.enum(['message', 'wiki', 'diagram']))
      .optional()
      .describe('Limit to these source types (default: all)'),
    limit: z.number().int().min(1).max(10).optional().describe('Maximum results (default 6)'),
  }),
  async run({ query, sources, limit = 6 }, ctx) {
    const hits = (await searchChunks(query, { filter: ctx.retrievalFilter, limit: 20 }))
      .filter((h) => !sources || sources.includes(h.sourceType))
      .slice(0, limit);
    if (hits.length === 0) return { content: 'No results.', summary: `Searched "${query}" · no results` };
    const content = hits
      .map((h, i) => {
        const label =
          h.sourceType === 'wiki'
            ? `wiki page "${h.title ?? ''}" (id: ${h.sourceId})`
            : h.sourceType === 'diagram'
              ? `diagram "${h.title ?? ''}" (id: ${h.sourceId})`
              : `chat "${h.title ?? ''}", ${h.role === 'assistant' ? 'you' : 'user'}, ${h.createdAt.slice(0, 10)}`;
        return `[${i + 1}] ${label}\n${clip(h.text, 1500)}`;
      })
      .join('\n\n');
    return { content, summary: `Searched "${query}" · ${plural(hits.length, 'result')}` };
  },
});

const listWikiPages = defineRead({
  name: 'list_wiki_pages',
  description:
    'List wiki pages, optionally filtered by a search query. Returns page ids, titles and collections. ' +
    'Check this before creating a page, to update an existing one instead of making a duplicate.',
  schema: z.object({
    query: z.string().max(200).optional().describe('Search text; omit to list recent pages'),
  }),
  async run({ query }, ctx) {
    const docs = (await browseDocuments(ctx.role, query)).slice(0, 30);
    if (docs.length === 0) return { content: 'No pages found.', summary: 'Listed wiki pages · none found' };
    return {
      content: docs.map((d) => `- ${d.title} (id: ${d.id}, collection: ${d.collectionName || 'none'})`).join('\n'),
      summary: query ? `Listed wiki pages for "${query}" · ${docs.length}` : `Listed wiki pages · ${docs.length}`,
    };
  },
});

const readWikiPage = defineRead({
  name: 'read_wiki_page',
  description: 'Read the full text of one wiki page by id (ids come from search_knowledge or list_wiki_pages).',
  schema: z.object({ id: z.string().min(1).describe('Wiki page id') }),
  async run({ id }, ctx) {
    const doc = await getDocumentById(ctx.role, id);
    return {
      content: `# ${doc.title}\n\n${clip(doc.text, MAX_PAGE_CHARS)}`,
      summary: `Read wiki page "${doc.title}"`,
      url: `${OUTLINE_BASE_URL}${doc.url}`,
    };
  },
});

const listDiagrams = defineRead({
  name: 'list_diagrams',
  description: 'List the project diagrams (dependency and flow graphs) with their ids and folders.',
  schema: z.object({}),
  async run() {
    const diagrams = await listDiagramsFromTool();
    if (diagrams.length === 0) return { content: 'No diagrams.', summary: 'Listed diagrams · none' };
    return {
      content: diagrams
        .map((d) => `- ${d.name} (id: ${d.id}${d.folder_path ? `, folder: ${d.folder_path}` : ''})${d.description ? `: ${d.description}` : ''}`)
        .join('\n'),
      summary: `Listed diagrams · ${diagrams.length}`,
    };
  },
});

const readDiagram = defineRead({
  name: 'read_diagram',
  description: 'Read one diagram as text: its nodes (with kind and notes) and the edges between them.',
  schema: z.object({ id: z.number().int().positive().describe('Diagram id') }),
  async run({ id }) {
    const text = await getAgentFormatFromTool(id);
    if (text === null) throw new Error(`Diagram ${id} not found`);
    const name = /^#\s*(.+)$/m.exec(text)?.[1]?.trim() ?? `#${id}`;
    return { content: clip(text, MAX_PAGE_CHARS), summary: `Read diagram "${name}"` };
  },
});

const listPlaneIssues = defineRead({
  name: 'list_plane_issues',
  description:
    'List Plane work items (issues) and local features, optionally filtered by text or status. ' +
    'Returns feature ids for read_plane_issue, update_plane_issue and comment_on_plane_issue.',
  schema: z.object({
    query: z.string().max(200).optional().describe('Text to match in the key (e.g. NB-10), title or description'),
    status: z.enum(['backlog', 'active', 'review', 'closed']).optional(),
  }),
  async run({ query, status }) {
    const items = browseFeatures({ query, status });
    if (items.length === 0) return { content: 'No issues found.', summary: 'Listed Plane issues · none found' };
    return {
      content: items.map((f) => `- ${f.jira_key ? `${f.jira_key} ` : ''}${f.name} (feature id: ${f.id}, status: ${f.status})`).join('\n'),
      summary: `Listed Plane issues · ${items.length}`,
    };
  },
});

const readPlaneIssue = defineRead({
  name: 'read_plane_issue',
  description: 'Read one Plane work item or feature: title, status, description and locked decisions.',
  schema: z.object({ feature_id: z.number().int().positive().describe('Feature id from list_plane_issues') }),
  async run({ feature_id }) {
    const f = getFeatureContent(feature_id);
    if (!f) throw new Error(`Feature ${feature_id} not found`);
    const locked = f.locked_decisions?.length ? f.locked_decisions.map((d) => `- ${d}`).join('\n') : 'None';
    return {
      content: [
        `# ${f.jira_key ? `${f.jira_key} ` : ''}${f.name}`,
        `Status: ${f.status}${f.jira_status ? ` (Plane: ${f.jira_status})` : ''} · Phase: ${f.phase}`,
        '',
        f.description || '(no description)',
        '',
        `Locked decisions:\n${locked}`,
      ].join('\n'),
      summary: `Read ${f.jira_key ?? 'feature'} "${f.name}"`,
    };
  },
});

export const READ_TOOLS: ReadTool[] = [
  searchKnowledge,
  listWikiPages,
  readWikiPage,
  listDiagrams,
  readDiagram,
  listPlaneIssues,
  readPlaneIssue,
];

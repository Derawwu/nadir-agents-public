/**
 * Shared shapes for agent tools.
 *
 * A tool is a zod schema (which also produces the JSON Schema Claude sees),
 * a description, and a run function. Read tools run as soon as the agent
 * calls them. Write tools first produce a preview; the chat shows it as an
 * action card and the tool only runs once the user approves it.
 */

import type { z } from 'zod';
import type { AgentRole } from '../agents/modelConfig';
import type { ChunkFilter } from '../retrieval/search';

export interface ToolContext {
  agentId: number;
  role: AgentRole;
  conversationId: number;
  featureId: number | null;
  /** Chunks this chat may search: the same rules as automatic retrieval. */
  retrievalFilter: ChunkFilter;
}

export interface ToolOutcome {
  /** What goes back to Claude in the tool_result. */
  content: string;
  /** One line for the chip in the chat, e.g. `Searched "sneak" · 4 results`. */
  summary: string;
  /** Link to what was read or written (wiki page, Plane issue, diagram). */
  url?: string | null;
}

/** What an action card shows before the user decides. */
export interface ActionPreview {
  /** e.g. "Create wiki page" */
  title: string;
  /** Short facts: target, collection, state… */
  fields: { label: string; value: string }[];
  /** The text that will be written, if any. */
  body?: string;
}

interface BaseTool<S extends z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Roles allowed to use the tool; omitted = every agent. */
  roles?: AgentRole[];
  run: (input: z.infer<S>, ctx: ToolContext) => Promise<ToolOutcome>;
}

export interface ReadTool<S extends z.ZodType = z.ZodType> extends BaseTool<S> {
  kind: 'read';
}

export interface WriteTool<S extends z.ZodType = z.ZodType> extends BaseTool<S> {
  kind: 'write';
  preview: (input: z.infer<S>, ctx: ToolContext) => Promise<ActionPreview> | ActionPreview;
}

export type AgentTool = ReadTool | WriteTool;

/**
 * Define a tool with its input type inferred from its schema. The registry
 * holds tools of mixed schemas, so the result is widened; inputs are always
 * parsed with the tool's own schema before run/preview see them.
 */
export function defineRead<S extends z.ZodType>(tool: Omit<ReadTool<S>, 'kind'>): ReadTool {
  return { ...tool, kind: 'read' } as unknown as ReadTool;
}

export function defineWrite<S extends z.ZodType>(tool: Omit<WriteTool<S>, 'kind'>): WriteTool {
  return { ...tool, kind: 'write' } as unknown as WriteTool;
}

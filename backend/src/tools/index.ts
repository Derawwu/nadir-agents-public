/**
 * Tool registry: which tools an agent gets, in the shape the Messages API
 * takes, and parsing of the inputs Claude sends back.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AgentRole } from '../agents/modelConfig';
import { READ_TOOLS } from './readTools';
import { WRITE_TOOLS } from './writeTools';
import type { AgentTool } from './types';

export type { AgentTool, ToolContext, ToolOutcome, ActionPreview } from './types';

/** Fixed order: the tool list is the start of the cached prompt prefix. */
const ALL_TOOLS: AgentTool[] = [...READ_TOOLS, ...WRITE_TOOLS];

export function isToolUseEnabled(): boolean {
  return (process.env.AGENT_TOOLS_ENABLED ?? 'true').toLowerCase() !== 'false';
}

export function toolsForRole(role: AgentRole): AgentTool[] {
  return ALL_TOOLS.filter((t) => !t.roles || t.roles.includes(role));
}

export function getTool(role: AgentRole, name: string): AgentTool | undefined {
  return toolsForRole(role).find((t) => t.name === name);
}

/**
 * API tool definitions. eager_input_streaming streams large inputs (page
 * text) as they are generated; the server no longer validates them, so every
 * input goes through parseToolInput before a tool sees it.
 */
export function apiTools(tools: AgentTool[]): Anthropic.Tool[] {
  return tools.map((t) => {
    const { $schema: _ignored, ...schema } = z.toJSONSchema(t.schema, { io: 'input' }) as Record<string, unknown>;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Tool.InputSchema,
      eager_input_streaming: true,
    };
  });
}

export type ParsedInput = { ok: true; input: unknown } | { ok: false; error: string };

export function parseToolInput(tool: AgentTool, raw: unknown): ParsedInput {
  const parsed = tool.schema.safeParse(raw);
  if (parsed.success) return { ok: true, input: parsed.data };
  return { ok: false, error: `Invalid input for ${tool.name}: ${z.prettifyError(parsed.error)}` };
}

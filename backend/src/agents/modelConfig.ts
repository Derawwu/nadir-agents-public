import { parseEffort, type Effort } from '../llm/modelParams';

export type AgentRole = 'narrator' | 'architect' | 'uxui' | 'analyst';

const DEFAULT_MODEL = 'claude-sonnet-5-5';

/** Effort for agent replies when ANTHROPIC_EFFORT_<ROLE> is not set. */
const DEFAULT_AGENT_EFFORT: Effort = 'medium';

const MODEL_ENV_MAP: Record<AgentRole, string> = {
  narrator: 'ANTHROPIC_MODEL_NARRATOR',
  architect: 'ANTHROPIC_MODEL_ARCHITECT',
  uxui: 'ANTHROPIC_MODEL_UXUI',
  analyst: 'ANTHROPIC_MODEL_ANALYST',
};

const EFFORT_ENV_MAP: Record<AgentRole, string> = {
  narrator: 'ANTHROPIC_EFFORT_NARRATOR',
  architect: 'ANTHROPIC_EFFORT_ARCHITECT',
  uxui: 'ANTHROPIC_EFFORT_UXUI',
  analyst: 'ANTHROPIC_EFFORT_ANALYST',
};

export function getModelForAgent(role: AgentRole): string {
  const envVar = MODEL_ENV_MAP[role];
  const model = process.env[envVar];
  if (!model) {
    console.warn(`[ModelConfig] ${envVar} not set, defaulting to ${DEFAULT_MODEL}`);
    return DEFAULT_MODEL;
  }
  return model;
}

export function getEffortForAgent(role: AgentRole): Effort {
  return parseEffort(process.env[EFFORT_ENV_MAP[role]], DEFAULT_AGENT_EFFORT);
}

/** Small model for chat titles. Low effort: a title needs no deliberation. */
export const TITLE_MODEL = process.env.ANTHROPIC_MODEL_TITLE ?? 'claude-haiku-5-5';

/** Neutral model that summarizes finished roundtables into decisions and action items. */
export const ROUNDTABLE_SUMMARY_MODEL = process.env.ANTHROPIC_MODEL_ROUNDTABLE_SUMMARY ?? 'claude-sonnet-5-5';

export function normalizeAgentRole(rawRole: string): AgentRole {
  const r = rawRole.toLowerCase();
  if (r.includes('narrator') || r === 'pm') return 'narrator';
  if (r.includes('architect') || r === 'tech_lead') return 'architect';
  if (r.includes('ux') || r === 'art_lead') return 'uxui';
  if (r.includes('analyst')) return 'analyst';
  throw new Error(`Unknown agent role: ${rawRole}`);
}

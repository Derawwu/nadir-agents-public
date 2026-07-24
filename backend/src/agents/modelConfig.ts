export type AgentRole = 'narrator' | 'architect' | 'uxui' | 'analyst';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

const MODEL_ENV_MAP: Record<AgentRole, string> = {
  narrator: 'ANTHROPIC_MODEL_NARRATOR',
  architect: 'ANTHROPIC_MODEL_ARCHITECT',
  uxui: 'ANTHROPIC_MODEL_UXUI',
  analyst: 'ANTHROPIC_MODEL_ANALYST',
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

export function normalizeAgentRole(rawRole: string): AgentRole {
  const r = rawRole.toLowerCase();
  if (r.includes('narrator') || r === 'pm') return 'narrator';
  if (r.includes('architect') || r === 'tech_lead') return 'architect';
  if (r.includes('ux') || r === 'art_lead') return 'uxui';
  if (r.includes('analyst')) return 'analyst';
  throw new Error(`Unknown agent role: ${rawRole}`);
}

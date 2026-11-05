/**
 * Checks whether the models this app is configured to use are still current.
 *
 * Uses Anthropic's Models API, which lists every available model with its
 * family ("line": opus, sonnet, haiku...), release date and lifecycle dates.
 * For each configured model it reports:
 *   - a newer active model in the same line (upgrade available),
 *   - a deprecation or retirement date (the model will stop working),
 *   - an id the API doesn't know (typo, or already retired).
 *
 * The list changes rarely, so results are cached in memory for an hour.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getModelForAgent, ROUNDTABLE_SUMMARY_MODEL, TITLE_MODEL, type AgentRole } from '../agents/modelConfig';
import { getSummaryModel } from '../agents/contextConfig';
import { normalizeModelId } from './pricing';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CACHE_MS = 60 * 60 * 1000;

/** The fields of a Models API entry this check reads (Anthropic.ModelInfo fits it). */
interface ApiModel {
  id: string;
  display_name: string;
  created_at: string;
  line?: string | null;
  lifecycle?: string;
  deprecated_at?: string | null;
  retires_at?: string | null;
}

export interface ModelUsage {
  /** What the model is used for, e.g. "Narrator" or "Chat titles". */
  label: string;
  /** Env var that sets it. */
  envVar: string;
  model: string;
}

export type ModelIssue = 'upgrade' | 'deprecated' | 'unknown';

export interface ModelCheck extends ModelUsage {
  displayName: string | null;
  issues: ModelIssue[];
  /** Newest active model in the same line, when it is not the configured one. */
  latest: { id: string; displayName: string } | null;
  deprecatedAt: string | null;
  retiresAt: string | null;
}

export interface ModelStatus {
  checkedAt: string;
  upToDate: boolean;
  models: ModelCheck[];
}

const AGENT_USAGES: { role: AgentRole; label: string; envVar: string }[] = [
  { role: 'narrator', label: 'Narrator', envVar: 'ANTHROPIC_MODEL_NARRATOR' },
  { role: 'architect', label: 'Architect', envVar: 'ANTHROPIC_MODEL_ARCHITECT' },
  { role: 'uxui', label: 'UX/UI', envVar: 'ANTHROPIC_MODEL_UXUI' },
  { role: 'analyst', label: 'Analyst', envVar: 'ANTHROPIC_MODEL_ANALYST' },
];

function configuredModels(): ModelUsage[] {
  return [
    ...AGENT_USAGES.map(({ role, label, envVar }) => ({ label, envVar, model: getModelForAgent(role) })),
    { label: 'Chat titles', envVar: 'ANTHROPIC_MODEL_TITLE', model: TITLE_MODEL },
    { label: 'Chat summaries', envVar: 'ANTHROPIC_MODEL_SUMMARY', model: getSummaryModel() },
    { label: 'Roundtable summaries', envVar: 'ANTHROPIC_MODEL_ROUNDTABLE_SUMMARY', model: ROUNDTABLE_SUMMARY_MODEL },
  ];
}

/** Family of a model: the API's "line", or parsed from the id for older entries. */
function lineOf(m: ApiModel): string | null {
  return m.line ?? /^claude-([a-z]+)-/.exec(m.id)?.[1] ?? null;
}

function isActive(m: ApiModel): boolean {
  return (m.lifecycle ?? 'active') === 'active' && !m.deprecated_at;
}

async function listModels(): Promise<ApiModel[]> {
  const out: ApiModel[] = [];
  for await (const m of anthropic.models.list({ limit: 100 })) out.push(m);
  return out;
}

export function checkModels(usages: ModelUsage[], available: ApiModel[]): ModelCheck[] {
  const byId = new Map(available.map((m) => [m.id, m]));
  // Aliases like "claude-haiku-4-5" resolve to dated ids like "claude-haiku-4-5-20251001".
  const find = (id: string) => byId.get(id) ?? available.find((m) => normalizeModelId(m.id) === normalizeModelId(id));

  const newestByLine = new Map<string, ApiModel>();
  for (const m of available) {
    const line = lineOf(m);
    if (!line || !isActive(m)) continue;
    const cur = newestByLine.get(line);
    if (!cur || m.created_at > cur.created_at) newestByLine.set(line, m);
  }

  return usages.map((u) => {
    const info = find(u.model);
    const issues: ModelIssue[] = [];
    let latest: ModelCheck['latest'] = null;
    if (!info) {
      issues.push('unknown');
    } else {
      if (info.deprecated_at || info.retires_at || (info.lifecycle && info.lifecycle !== 'active')) issues.push('deprecated');
      const line = lineOf(info);
      const newest = line ? newestByLine.get(line) : undefined;
      if (newest && newest.id !== info.id && newest.created_at > info.created_at) {
        issues.push('upgrade');
        latest = { id: newest.id, displayName: newest.display_name };
      }
    }
    return {
      ...u,
      displayName: info?.display_name ?? null,
      issues,
      latest,
      deprecatedAt: info?.deprecated_at ?? null,
      retiresAt: info?.retires_at ?? null,
    };
  });
}

let cache: { at: number; status: ModelStatus } | null = null;

export async function getModelStatus(force = false): Promise<ModelStatus> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.status;
  const models = checkModels(configuredModels(), await listModels());
  const status: ModelStatus = {
    checkedAt: new Date().toISOString(),
    upToDate: models.every((m) => m.issues.length === 0),
    models,
  };
  cache = { at: Date.now(), status };
  return status;
}

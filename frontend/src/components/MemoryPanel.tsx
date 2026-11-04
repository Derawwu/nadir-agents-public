/**
 * Displays the memories the agent will see in the current chat, grouped by
 * scope: this chat only, the chat's feature, and agent-wide. Each memory can
 * be moved between scopes (e.g. promote a chat memory to agent-wide).
 */

import { useEffect, useState } from 'react';
import {
  saveMemoryToWiki,
  agentNameToOutlineRole,
  fetchMemories,
  updateMemoryScope,
} from '../api/client';
import type { Memory, MemoryScope } from '../api/client';

const TYPE_COLORS: Record<string, string> = {
  decision: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  lore: 'text-purple-400 bg-purple-400/10 border-purple-400/20',
  technical: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/20',
  visual: 'text-green-400 bg-green-400/10 border-green-400/20',
  flag: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
  conflict: 'text-red-400 bg-red-400/10 border-red-400/20',
};

const SCOPE_LABELS: Record<MemoryScope, string> = {
  chat: 'This chat',
  feature: 'Feature',
  agent: 'Agent-wide',
};

type WikiStatus = 'idle' | 'saving' | 'saved' | 'error';

interface Props {
  agentId: number | null;
  agentName: string | null;
  /** Null for a new chat that has not been sent yet. */
  chatId: number | null;
  featureId: number | null;
  featureName: string | null;
  /** Increment to trigger a refresh (e.g. after a memory is saved). */
  refreshTrigger: number;
}

export function MemoryPanel({ agentId, agentName, chatId, featureId, featureName, refreshTrigger }: Props) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wikiStatus, setWikiStatus] = useState<Record<number, WikiStatus>>({});
  const [localRefresh, setLocalRefresh] = useState(0);

  useEffect(() => {
    if (!agentId) {
      setMemories([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    fetchMemories(agentId, { chatId, featureId })
      .then((data) => { if (!cancelled) setMemories(data); })
      .catch(() => { if (!cancelled) setMemories([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agentId, chatId, featureId, refreshTrigger, localRefresh]);

  async function handleSaveToWiki(memory: Memory) {
    if (!agentName) return;
    setWikiStatus((prev) => ({ ...prev, [memory.id]: 'saving' }));
    try {
      await saveMemoryToWiki({
        role: agentNameToOutlineRole(agentName),
        featureName: featureName ?? 'Global',
        memoryType: memory.type,
        content: memory.content,
      });
      setWikiStatus((prev) => ({ ...prev, [memory.id]: 'saved' }));
    } catch {
      setWikiStatus((prev) => ({ ...prev, [memory.id]: 'error' }));
    }
  }

  async function handleMove(memory: Memory, scope: MemoryScope) {
    if (!agentId || scope === memory.scope) return;
    setError(null);
    try {
      await updateMemoryScope(agentId, memory.id, { scope, chatId, featureId });
      setLocalRefresh((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to move memory');
    }
  }

  if (!agentId) {
    return (
      <div className="text-xs text-gray-600 text-center py-8">Select an agent to view memories.</div>
    );
  }

  const sections: MemoryScope[] = ['chat', 'feature', 'agent'];
  const availableScopes = sections.filter(
    (s) => (s !== 'chat' || chatId !== null) && (s !== 'feature' || featureId !== null)
  );

  return (
    <div className="space-y-4">
      <p className="text-xs text-gray-500 uppercase tracking-widest">
        Memories ({memories.length})
      </p>

      {loading && <div className="text-xs text-gray-600">Loading...</div>}
      {error && <div className="text-xs text-red-400">{error}</div>}

      {!loading && memories.length === 0 && (
        <div className="text-xs text-gray-600">
          {chatId === null
            ? 'No memories yet. Memories you save in this chat stay in this chat.'
            : 'No memories yet.'}
        </div>
      )}

      {sections.map((scope) => {
        const items = memories.filter((m) => m.scope === scope);
        if (items.length === 0) return null;
        return (
          <div key={scope} className="space-y-2">
            <p className="text-[10px] text-gray-600 uppercase tracking-widest">
              {SCOPE_LABELS[scope]}
              {scope === 'feature' && featureName ? ` · ${featureName}` : ''} ({items.length})
            </p>
            {items.map((m) => {
              const ws = wikiStatus[m.id] ?? 'idle';
              return (
                <div key={m.id} className="p-3 rounded border bg-surface-200 border-border text-xs">
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <span
                      className={`inline-block px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide
                        ${TYPE_COLORS[m.type] ?? 'text-gray-400 bg-gray-400/10 border-gray-400/20'}`}
                    >
                      {m.type}
                    </span>

                    {agentName && agentName !== 'Analyst' && (
                      <button
                        onClick={() => { void handleSaveToWiki(m); }}
                        disabled={ws === 'saving' || ws === 'saved'}
                        className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border transition-colors
                          ${ws === 'saved'
                            ? 'text-green-400 border-green-400/30 bg-green-400/10 cursor-default'
                            : ws === 'error'
                            ? 'text-red-400 border-red-400/30 bg-red-400/10 hover:bg-red-400/20 cursor-pointer'
                            : ws === 'saving'
                            ? 'text-gray-500 border-gray-600 cursor-default'
                            : 'text-gray-400 border-gray-600 hover:text-gray-200 hover:border-gray-400 cursor-pointer'
                          }`}
                      >
                        {ws === 'saved' ? '✓ Saved' : ws === 'saving' ? 'Saving…' : ws === 'error' ? 'Retry' : 'Save to Wiki'}
                      </button>
                    )}
                  </div>

                  <p className="text-gray-300 leading-relaxed whitespace-pre-wrap">{m.content}</p>
                  <div className="flex items-center justify-between gap-2 mt-1.5">
                    <p className="text-gray-600 text-[10px]">
                      {new Date(m.created_at).toLocaleString()}
                      {m.source === 'roundtable' && ' · roundtable'}
                    </p>
                    {availableScopes.length > 1 && (
                      <select
                        value={m.scope}
                        onChange={(e) => { void handleMove(m, e.target.value as MemoryScope); }}
                        className="bg-surface-100 border border-border rounded text-[10px] text-gray-400 px-1 py-0.5
                                   focus:outline-none focus:border-accent"
                        title="Where this memory is visible"
                      >
                        {availableScopes.map((s) => (
                          <option key={s} value={s}>{SCOPE_LABELS[s]}</option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

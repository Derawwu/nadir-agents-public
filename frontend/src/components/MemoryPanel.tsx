/**
 * Displays the current agent's memories for the selected feature.
 * Memories are loaded from the backend on mount and when agent/feature changes.
 */

import { useEffect, useState } from 'react';
import { saveMemoryToWiki, agentNameToOutlineRole } from '../api/client';

const TYPE_COLORS: Record<string, string> = {
  decision: 'text-blue-400 bg-blue-400/10 border-blue-400/20',
  lore: 'text-purple-400 bg-purple-400/10 border-purple-400/20',
  technical: 'text-cyan-400 bg-cyan-400/10 border-cyan-400/20',
  visual: 'text-green-400 bg-green-400/10 border-green-400/20',
  flag: 'text-yellow-400 bg-yellow-400/10 border-yellow-400/20',
  conflict: 'text-red-400 bg-red-400/10 border-red-400/20',
};

interface Memory {
  id: number;
  agent_id: number;
  feature_id: number | null;
  type: string;
  content: string;
  created_at: string;
}

type WikiStatus = 'idle' | 'saving' | 'saved' | 'error';

interface Props {
  agentId: number | null;
  agentName: string | null;
  featureId: number | null;
  featureName: string | null;
  /** Increment to trigger a refresh (e.g. after a memory is saved). */
  refreshTrigger: number;
}

export function MemoryPanel({ agentId, agentName, featureId, featureName, refreshTrigger }: Props) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(false);
  const [wikiStatus, setWikiStatus] = useState<Record<number, WikiStatus>>({});

  useEffect(() => {
    if (!agentId) {
      setMemories([]);
      return;
    }

    setLoading(true);
    fetch(`/api/agents/${agentId}/memories${featureId != null ? `?featureId=${featureId}` : ''}`)
      .then((r) => r.json())
      .then((data: Memory[]) => setMemories(data))
      .catch(() => setMemories([]))
      .finally(() => setLoading(false));
  }, [agentId, featureId, refreshTrigger]);

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

  if (!agentId) {
    return (
      <div className="text-xs text-gray-600 text-center py-8">Select an agent to view memories.</div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-gray-500 uppercase tracking-widest">
        Memories ({memories.length})
      </p>

      {loading && (
        <div className="text-xs text-gray-600">Loading...</div>
      )}

      {!loading && memories.length === 0 && (
        <div className="text-xs text-gray-600">No memories yet.</div>
      )}

      {memories.map((m) => {
        const ws = wikiStatus[m.id] ?? 'idle';
        return (
          <div
            key={m.id}
            className="p-3 rounded border bg-surface-200 border-border text-xs"
          >
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
            <p className="text-gray-600 mt-1.5 text-[10px]">
              {new Date(m.created_at).toLocaleString()}
              {m.feature_id == null && ' · global'}
            </p>
          </div>
        );
      })}
    </div>
  );
}

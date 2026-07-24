import { useEffect, useRef, useState } from 'react';
import { AgentSelector } from '../components/AgentSelector';
import { FeatureSelector } from '../components/FeatureSelector';
import { ChatWindow } from '../components/ChatWindow';
import { MemoryPanel } from '../components/MemoryPanel';
import { fetchAgents, fetchFeatures, fetchConversationHistory } from '../api/client';
import type { Agent, Feature, ConversationHistory } from '../api/client';

const LS_AGENT_KEY = 'nadir_active_agent_id';
const LS_FEATURE_KEY = 'nadir_active_feature_id';

function readStoredInt(key: string): number | null {
  const v = localStorage.getItem(key);
  if (v === null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

export function ChatPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<number | null>(null);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const [conversationHistory, setConversationHistory] = useState<ConversationHistory | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Read localStorage once on mount so we can restore selections after data loads.
  const pendingAgentId = useRef<number | null>(readStoredInt(LS_AGENT_KEY));
  const pendingFeatureId = useRef<number | null>(readStoredInt(LS_FEATURE_KEY));

  useEffect(() => {
    Promise.all([fetchAgents(), fetchFeatures()])
      .then(([a, f]) => {
        setAgents(a);
        setFeatures(f);

        // Restore agent from localStorage; fall back to first agent.
        const stored = pendingAgentId.current;
        const agentId =
          stored !== null && a.some((ag) => ag.id === stored)
            ? stored
            : a.length > 0
            ? a[0].id
            : null;
        setSelectedAgentId(agentId);

        // Restore feature from localStorage; fall back to null (General).
        const storedFeat = pendingFeatureId.current;
        const featureId =
          storedFeat !== null && f.some((feat) => feat.id === storedFeat)
            ? storedFeat
            : null;
        setSelectedFeatureId(featureId);
      })
      .catch((e: unknown) =>
        setLoadError(e instanceof Error ? e.message : 'Failed to load data')
      );
  }, []);

  // Persist agent selection to localStorage.
  useEffect(() => {
    if (selectedAgentId !== null) {
      localStorage.setItem(LS_AGENT_KEY, String(selectedAgentId));
    }
  }, [selectedAgentId]);

  // Persist feature selection to localStorage.
  useEffect(() => {
    if (selectedFeatureId !== null) {
      localStorage.setItem(LS_FEATURE_KEY, String(selectedFeatureId));
    } else {
      localStorage.removeItem(LS_FEATURE_KEY);
    }
  }, [selectedFeatureId]);

  // Load conversation history whenever the agent or feature selection changes.
  useEffect(() => {
    if (selectedAgentId === null) {
      setConversationId(null);
      setConversationHistory(null);
      return;
    }

    let cancelled = false;
    setHistoryLoading(true);
    setConversationHistory(null);

    fetchConversationHistory(selectedAgentId, selectedFeatureId)
      .then((history) => {
        if (cancelled) return;
        setConversationId(history.conversationId);
        setConversationHistory(history);
      })
      .catch(() => {
        if (cancelled) return;
        setConversationId(null);
        setConversationHistory(null);
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedAgentId, selectedFeatureId]);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
  const selectedFeature = features.find((f) => f.id === selectedFeatureId) ?? null;
  const isClosedFeature = selectedFeature?.status === 'closed';

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center text-red-400 text-sm">
        {loadError}
      </div>
    );
  }

  const chatContent = (() => {
    if (selectedAgentId === null) {
      return (
        <div className="flex-1 flex items-center justify-center text-gray-600">
          Select an agent to start chatting.
        </div>
      );
    }
    if (historyLoading) {
      return (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          Loading conversation…
        </div>
      );
    }
    return (
      <ChatWindow
        key={`${selectedAgentId}-${selectedFeatureId ?? 'none'}`}
        agentId={selectedAgentId}
        agentName={selectedAgent?.name ?? null}
        featureId={selectedFeatureId}
        conversationId={conversationId}
        initialMessages={conversationHistory?.messages ?? []}
        onConversationCreated={setConversationId}
        onMemorySaved={() => setMemoryRefresh((n) => n + 1)}
      />
    );
  })();

  return (
    <div className="flex h-full">
      {/* Left sidebar */}
      <aside className="w-56 shrink-0 border-r border-border p-4 overflow-y-auto space-y-8">
        <AgentSelector
          agents={agents}
          selectedId={selectedAgentId}
          onSelect={(id) => setSelectedAgentId(id)}
        />
        <FeatureSelector
          features={features}
          selectedId={selectedFeatureId}
          onSelect={(id) => setSelectedFeatureId(id)}
          onFeatureCreated={(f) => {
            setFeatures((prev) => [f, ...prev]);
            setSelectedFeatureId(f.id);
          }}
          onSynced={() => {
            fetchFeatures().then(setFeatures).catch(console.error);
          }}
        />
      </aside>

      {/* Main chat area */}
      <main className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-border px-6 py-3 flex items-center gap-3">
          <span className="text-sm font-medium text-gray-200">
            {selectedAgent?.name ?? '—'}
          </span>
          {selectedFeatureId && (
            <>
              <span className="text-gray-600">·</span>
              <span className="text-sm text-gray-500">
                {features.find((f) => f.id === selectedFeatureId)?.name ?? ''}
              </span>
            </>
          )}
        </div>

        {isClosedFeature && (
          <div className="mx-0 px-6 py-2 bg-gray-800 border-b border-border text-xs text-gray-400">
            This feature is closed. Agents will treat this as a retrospective review.
          </div>
        )}

        {chatContent}
      </main>

      {/* Right memory panel */}
      <aside className="w-72 shrink-0 border-l border-border p-4 overflow-y-auto">
        <MemoryPanel
          agentId={selectedAgentId}
          agentName={selectedAgent?.name ?? null}
          featureId={selectedFeatureId}
          featureName={selectedFeature?.name ?? null}
          refreshTrigger={memoryRefresh}
        />
      </aside>
    </div>
  );
}

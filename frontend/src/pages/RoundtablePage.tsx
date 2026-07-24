import { useEffect, useRef, useState } from 'react';
import {
  fetchFeatures,
  fetchAgents,
  startRoundtable,
  continueRoundtable,
  terminateRoundtable,
} from '../api/client';
import type { Agent, Feature, RoundtableSSEEvent } from '../api/client';
import { RoundtableView } from '../components/RoundtableView';
import type { AgentTurn, RoundtableSummary } from '../components/RoundtableView';
import { ContextTrayBar } from '../components/ContextTrayBar';
import { useContextTray } from '../contexts/ContextTrayContext';

const AGENT_COLORS: Record<string, string> = {
  Narrator: 'text-agent-narrator border-agent-narrator',
  Architect: 'text-agent-architect border-agent-architect',
  'UX/UI': 'text-agent-ux border-agent-ux',
  Analyst: 'text-agent-analyst border-agent-analyst',
};

type PageStatus = 'idle' | 'active' | 'completed' | 'terminated';

export function RoundtablePage() {
  const [features, setFeatures] = useState<Feature[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedFeatureId, setSelectedFeatureId] = useState<number | null>(null);
  const [selectedAgentIds, setSelectedAgentIds] = useState<number[]>([]);
  const [topic, setTopic] = useState('');
  const [status, setStatus] = useState<PageStatus>('idle');
  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [summary, setSummary] = useState<RoundtableSummary | null>(null);
  const [currentRound, setCurrentRound] = useState(1);
  const [roundtableId, setRoundtableId] = useState<number | null>(null);
  const [terminating, setTerminating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outlineSaved, setOutlineSaved] = useState<boolean | null>(null);
  const [followUp, setFollowUp] = useState('');
  const [sendingFollowUp, setSendingFollowUp] = useState(false);
  const cleanupRef = useRef<(() => void) | null>(null);
  const { augmentMessage } = useContextTray();

  useEffect(() => {
    fetchFeatures().then(setFeatures).catch(console.error);
    fetchAgents().then((a) => {
      setAgents(a);
      setSelectedAgentIds(a.map((ag) => ag.id));
    }).catch(console.error);
  }, []);

  function toggleAgent(id: number) {
    setSelectedAgentIds((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    );
  }

  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  function handleSSEEvent(event: RoundtableSSEEvent) {
    switch (event.type) {
      case 'roundtable_created':
        setRoundtableId(event.roundtableId);
        break;

      case 'round_start':
        setCurrentRound(event.round);
        break;

      case 'agent_start':
        // Add a new empty turn entry for streaming into.
        setTurns((prev) => [
          ...prev,
          {
            agentId: event.agentId,
            agentName: event.agentName,
            round: event.round,
            content: '',
            isStreaming: true,
            hasConflict: false,
            conflictSummary: null,
            conflictTarget: null,
          },
        ]);
        break;

      case 'chunk':
        // Append chunk to the last turn for this agent in this round.
        setTurns((prev) => {
          const idx = [...prev].reverse().findIndex(
            (t) => t.agentId === event.agentId && t.round === event.round
          );
          if (idx === -1) return prev;
          const realIdx = prev.length - 1 - idx;
          return prev.map((t, i) =>
            i === realIdx ? { ...t, content: t.content + event.chunk } : t
          );
        });
        break;

      case 'agent_done':
        setTurns((prev) => {
          const idx = [...prev].reverse().findIndex(
            (t) => t.agentId === event.agentId && t.round === event.round
          );
          if (idx === -1) return prev;
          const realIdx = prev.length - 1 - idx;
          return prev.map((t, i) =>
            i === realIdx
              ? {
                  ...t,
                  isStreaming: false,
                  hasConflict: event.hasConflict,
                  conflictSummary: event.conflictSummary,
                  conflictTarget: event.conflictTarget,
                }
              : t
          );
        });
        break;

      case 'roundtable_done':
        setStatus(event.status);
        setSendingFollowUp(false);
        break;

      case 'summary':
        setSummary(event.summary);
        setOutlineSaved(event.outline.saved);
        break;

      case 'error':
        setError(event.error);
        setStatus('terminated');
        setSendingFollowUp(false);
        break;
    }
  }

  async function handleStart() {
    if (!selectedFeatureId || !topic.trim() || status === 'active') return;
    if (selectedAgentIds.length === 0) return;

    setTurns([]);
    setSummary(null);
    setError(null);
    setOutlineSaved(null);
    setCurrentRound(1);
    setRoundtableId(null);
    setStatus('active');

    const { text: augmentedTopic } = await augmentMessage(topic.trim());

    cleanupRef.current = startRoundtable(
      { featureId: selectedFeatureId, topic: augmentedTopic, agentIds: selectedAgentIds },
      handleSSEEvent
    );
  }

  async function handleContinue() {
    if (!roundtableId || !followUp.trim() || status === 'active') return;
    if (selectedAgentIds.length === 0) return;

    const message = followUp.trim();
    setFollowUp('');
    setError(null);
    setOutlineSaved(null);
    setSendingFollowUp(true);
    setStatus('active');

    const { text: augmented } = await augmentMessage(message);

    cleanupRef.current = continueRoundtable(
      roundtableId,
      { message: augmented, agentIds: selectedAgentIds },
      handleSSEEvent
    );
  }

  async function handleTerminate() {
    if (!roundtableId || terminating) return;
    setTerminating(true);
    try {
      await terminateRoundtable(roundtableId);
      cleanupRef.current?.();
      setStatus('terminated');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to terminate');
    } finally {
      setTerminating(false);
    }
  }

  const selectedFeature = features.find((f) => f.id === selectedFeatureId);

  return (
    <div className="flex flex-col h-full">
      {/* Controls bar */}
      <div className="border-b border-border space-y-0">
        <ContextTrayBar />
        <div className="px-6 py-4 space-y-3">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <label className="text-xs text-gray-500 uppercase tracking-widest mb-1 block">
              Feature
            </label>
            <select
              className="input text-sm"
              value={selectedFeatureId ?? ''}
              onChange={(e) =>
                setSelectedFeatureId(e.target.value ? parseInt(e.target.value, 10) : null)
              }
              disabled={status === 'active'}
            >
              <option value="">Select a feature...</option>
              {features.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({f.phase})
                </option>
              ))}
            </select>
          </div>

          <div className="flex-[2]">
            <label className="text-xs text-gray-500 uppercase tracking-widest mb-1 block">
              Topic
            </label>
            <input
              className="input text-sm"
              placeholder="What should the team discuss?"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              disabled={status === 'active'}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleStart(); }}
            />
          </div>

          <div className="self-end">
            <button
              className="btn-primary"
              onClick={() => void handleStart()}
              disabled={
                !selectedFeatureId || !topic.trim() || status === 'active' || selectedAgentIds.length === 0
              }
            >
              {status === 'active' ? 'Running...' : 'Start Roundtable'}
            </button>
          </div>
        </div>

        <div>
          <label className="text-xs text-gray-500 uppercase tracking-widest mb-1.5 block">
            Participants
          </label>
          <div className="flex items-center gap-2 flex-wrap">
            {agents.map((agent) => {
              const colorClass = AGENT_COLORS[agent.name] ?? 'text-gray-300 border-border';
              const isSelected = selectedAgentIds.includes(agent.id);

              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => toggleAgent(agent.id)}
                  disabled={status === 'active'}
                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors duration-150
                    ${isSelected
                      ? `${colorClass} bg-surface-200`
                      : 'text-gray-500 border-border hover:text-gray-300 hover:border-gray-500'
                    }`}
                >
                  {agent.name}
                </button>
              );
            })}
          </div>
          {selectedAgentIds.length === 0 && (
            <p className="text-xs text-red-400 mt-1">Select at least one agent.</p>
          )}
        </div>

        {status === 'active' && (
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
              Round {currentRound}
            </span>
            {selectedFeature && (
              <span>· {selectedFeature.name}</span>
            )}
          </div>
        )}
        </div>
      </div>

      {/* Closed feature banner */}
      {selectedFeature?.status === 'closed' && (
        <div className="mx-6 mt-4 px-4 py-2 rounded border border-gray-700 bg-gray-800 text-gray-400 text-xs">
          This feature is closed. Agents will treat this as a retrospective review.
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="mx-6 mt-4 px-4 py-2 rounded border border-conflict/30 bg-conflict/10 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* Outline save status — shown once summary arrives */}
      {outlineSaved !== null && (
        <div className={`mx-6 mt-3 flex items-center gap-2 text-xs
          ${outlineSaved ? 'text-green-400' : 'text-yellow-500'}`}
        >
          {outlineSaved ? (
            <>
              <span>✓ Saved to Outline</span>
              <a
                href="http://localhost:3002"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-green-300 transition-colors"
              >
                View in Outline
              </a>
            </>
          ) : (
            <span>Outline save failed — check backend logs</span>
          )}
        </div>
      )}

      {/* Live feed */}
      <div className="flex-1 min-h-0">
        {status === 'idle' ? (
          <div className="flex h-full items-center justify-center text-gray-600 text-sm">
            Configure a feature and topic above to start a roundtable.
          </div>
        ) : (
          <RoundtableView
            turns={turns}
            summary={summary}
            status={status as 'active' | 'completed' | 'terminated'}
            onTerminate={handleTerminate}
            terminating={terminating}
          />
        )}
      </div>

      {/* Follow-up — continue the same roundtable with a new question */}
      {roundtableId !== null && (status === 'completed' || status === 'terminated') && (
        <div className="border-t border-border px-6 py-4">
          <div className="flex gap-3">
            <input
              className="input text-sm flex-1"
              placeholder="Ask a follow-up to continue this roundtable…"
              value={followUp}
              onChange={(e) => setFollowUp(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleContinue(); }}
              disabled={sendingFollowUp || selectedAgentIds.length === 0}
            />
            <button
              className="btn-primary px-5"
              onClick={() => void handleContinue()}
              disabled={!followUp.trim() || sendingFollowUp || selectedAgentIds.length === 0}
            >
              {sendingFollowUp ? '...' : 'Continue'}
            </button>
          </div>
          <p className="text-xs text-gray-600 mt-1.5">
            Continues with the current participants above — adjust the chips first if needed.
          </p>
        </div>
      )}
    </div>
  );
}

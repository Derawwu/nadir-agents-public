/**
 * Live roundtable feed component.
 *
 * Displays agent turns grouped by round as they stream in.
 * Conflict indicators are highlighted inline.
 * Summary panel appears after termination.
 */

import { useEffect, useRef } from 'react';
import { CopyButton } from './CopyButton';

const AGENT_COLORS: Record<string, string> = {
  Narrator: 'border-agent-narrator text-agent-narrator',
  Architect: 'border-agent-architect text-agent-architect',
  'UX/UI': 'border-agent-ux text-agent-ux',
  Analyst: 'border-agent-analyst text-agent-analyst',
};

export interface AgentTurn {
  agentId: number;
  agentName: string;
  round: number;
  content: string;
  isStreaming: boolean;
  hasConflict: boolean;
  conflictSummary: string | null;
  conflictTarget: string | null;
}

export interface RoundtableSummary {
  decisions: string[];
  openConflicts: string[];
  actionItems: Record<string, string[]>;
}

interface Props {
  turns: AgentTurn[];
  summary: RoundtableSummary | null;
  status: 'active' | 'completed' | 'terminated' | null;
  onTerminate: () => void;
  terminating: boolean;
}

export function RoundtableView({ turns, summary, status, onTerminate, terminating }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevTurnCountRef = useRef(0);

  // Autoscroll only when a new turn starts, not on every streamed chunk of
  // the current turn's content.
  useEffect(() => {
    const isNewTurn = turns.length > prevTurnCountRef.current;
    prevTurnCountRef.current = turns.length;
    if (isNewTurn) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [turns]);

  // Group turns by round number.
  const byRound = turns.reduce<Record<number, AgentTurn[]>>((acc, t) => {
    if (!acc[t.round]) acc[t.round] = [];
    acc[t.round].push(t);
    return acc;
  }, {});

  const rounds = Object.keys(byRound)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <div className="flex flex-col h-full overflow-y-auto px-6 py-4 space-y-6">
      {rounds.length === 0 && status === 'active' && (
        <div className="text-center text-gray-600 text-sm mt-16">
          Roundtable starting...
        </div>
      )}

      {rounds.map((round) => (
        <div key={round}>
          <div className="flex items-center gap-3 mb-4">
            <div className="h-px flex-1 bg-border" />
            <span className="text-xs text-gray-500 uppercase tracking-widest">
              Round {round}
            </span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <div className="space-y-4">
            {byRound[round].map((turn, i) => {
              const colorClass = AGENT_COLORS[turn.agentName] ?? 'border-border text-gray-300';

              return (
                <div key={i} className={`border-l-2 pl-4 ${colorClass.split(' ')[0]}`}>
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`text-sm font-medium ${colorClass.split(' ')[1]}`}>
                      {turn.agentName}
                    </span>
                    {turn.isStreaming && (
                      <span className="text-xs text-gray-600 animate-pulse">responding...</span>
                    )}
                    {turn.hasConflict && (
                      <span className="text-xs bg-conflict/20 text-red-400 border border-conflict/30 px-1.5 py-0.5 rounded">
                        conflict
                      </span>
                    )}
                    {!turn.isStreaming && <CopyButton content={turn.content} className="ml-auto" />}
                  </div>

                  <div className="text-sm text-gray-300 leading-relaxed whitespace-pre-wrap">
                    {turn.content}
                    {turn.isStreaming && (
                      <span className="inline-block w-1.5 h-3.5 ml-1 bg-gray-400 animate-pulse align-middle" />
                    )}
                  </div>

                  {turn.hasConflict && turn.conflictSummary && (
                    <div className="mt-2 p-2 rounded bg-conflict/10 border border-conflict/20 text-xs text-red-400">
                      <span className="font-medium">Conflict with {turn.conflictTarget}:</span>{' '}
                      {turn.conflictSummary}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* Summary panel */}
      {summary && (
        <div className="panel p-5 space-y-4">
          <div className="flex items-center gap-2">
            <span
              className={`text-xs px-2 py-0.5 rounded border ${
                status === 'completed'
                  ? 'text-green-400 border-green-400/30 bg-green-400/10'
                  : 'text-red-400 border-red-400/30 bg-red-400/10'
              }`}
            >
              {status === 'completed' ? 'Completed' : 'Terminated'}
            </span>
            <span className="text-sm font-medium text-gray-200">Roundtable Summary</span>
          </div>

          {summary.decisions.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Decisions Reached</p>
              <ul className="space-y-1">
                {summary.decisions.map((d, i) => (
                  <li key={i} className="text-sm text-gray-300 flex gap-2">
                    <span className="text-green-400 mt-0.5 shrink-0">✓</span>
                    {d}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {summary.openConflicts.length > 0 && (
            <div>
              <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">Open Conflicts</p>
              <ul className="space-y-1">
                {summary.openConflicts.map((c, i) => (
                  <li key={i} className="text-sm text-red-400 flex gap-2">
                    <span className="mt-0.5 shrink-0">⚠</span>
                    {c}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {Object.entries(summary.actionItems).map(([agent, items]) =>
            items.length > 0 ? (
              <div key={agent}>
                <p className="text-xs text-gray-500 uppercase tracking-widest mb-2">
                  {agent} — Action Items
                </p>
                <ul className="space-y-1">
                  {items.map((item, i) => (
                    <li key={i} className="text-sm text-gray-300 flex gap-2">
                      <span className="text-accent mt-0.5 shrink-0">→</span>
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          )}
        </div>
      )}

      {/* Active status + terminate */}
      {status === 'active' && turns.length > 0 && (
        <div className="flex justify-end pt-2">
          <button className="btn-danger" onClick={onTerminate} disabled={terminating}>
            {terminating ? 'Terminating...' : 'Terminate Roundtable'}
          </button>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

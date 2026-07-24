import type { Agent } from '../api/client';

// Maps agent name to its theme color class for visual distinction.
const AGENT_COLORS: Record<string, string> = {
  Narrator: 'text-agent-narrator border-agent-narrator',
  Architect: 'text-agent-architect border-agent-architect',
  'UX/UI': 'text-agent-ux border-agent-ux',
  Analyst: 'text-agent-analyst border-agent-analyst',
};

const AGENT_ROLE_LABELS: Record<string, string> = {
  pm: 'PM',
  tech_lead: 'Tech Lead',
  art_lead: 'Art Lead',
  analyst: 'QA / Scout',
};

interface Props {
  agents: Agent[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

export function AgentSelector({ agents, selectedId, onSelect }: Props) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-gray-500 uppercase tracking-widest mb-3">Agents</p>
      {agents.map((agent) => {
        const colorClass = AGENT_COLORS[agent.name] ?? 'text-gray-300 border-border';
        const isSelected = agent.id === selectedId;

        return (
          <button
            key={agent.id}
            onClick={() => onSelect(agent.id)}
            className={`w-full text-left px-3 py-2.5 rounded border transition-colors duration-150
              ${isSelected
                ? `${colorClass} bg-surface-200`
                : 'text-gray-400 border-transparent hover:bg-surface-200 hover:text-gray-200'
              }`}
          >
            <div className="font-medium text-sm">{agent.name}</div>
            <div className="text-xs opacity-60 mt-0.5">{AGENT_ROLE_LABELS[agent.role] ?? agent.role}</div>
          </button>
        );
      })}
    </div>
  );
}

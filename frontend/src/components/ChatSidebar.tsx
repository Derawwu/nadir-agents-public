/**
 * Claude-style chat sidebar: compact agent switcher, "New chat", a title
 * filter, and the selected agent's chats grouped by recency. Each chat row has
 * a hover menu for rename / pin / archive / delete.
 */

import { useEffect, useMemo, useState } from 'react';
import type { Agent, Chat } from '../api/client';
import { AGENT_COLORS } from './AgentSelector';
import { parseDbTimestamp } from '../utils/dateFormat';

interface Props {
  agents: Agent[];
  selectedAgentId: number | null;
  onSelectAgent: (id: number) => void;
  chats: Chat[];
  activeChatId: number | null;
  showArchived: boolean;
  onToggleArchived: () => void;
  onNewChat: () => void;
  onOpenChat: (id: number) => void;
  onRename: (id: number, title: string) => void;
  onTogglePin: (chat: Chat) => void;
  onToggleArchive: (chat: Chat) => void;
  onDelete: (chat: Chat) => void;
}

type GroupLabel = 'Pinned' | 'Today' | 'Yesterday' | 'Previous 7 days' | 'Previous 30 days' | 'Older' | 'Archived';

function groupFor(chat: Chat, now: Date): GroupLabel {
  if (chat.archived) return 'Archived';
  if (chat.pinned) return 'Pinned';
  const updated = parseDbTimestamp(chat.updated_at);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const t = updated.getTime();
  if (t >= startOfToday) return 'Today';
  if (t >= startOfToday - dayMs) return 'Yesterday';
  if (t >= startOfToday - 7 * dayMs) return 'Previous 7 days';
  if (t >= startOfToday - 30 * dayMs) return 'Previous 30 days';
  return 'Older';
}

const GROUP_ORDER: GroupLabel[] = ['Pinned', 'Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days', 'Older', 'Archived'];

export function ChatSidebar({
  agents,
  selectedAgentId,
  onSelectAgent,
  chats,
  activeChatId,
  showArchived,
  onToggleArchived,
  onNewChat,
  onOpenChat,
  onRename,
  onTogglePin,
  onToggleArchive,
  onDelete,
}: Props) {
  const [filter, setFilter] = useState('');
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');

  // Close the row menu on any outside click.
  useEffect(() => {
    if (menuFor === null) return;
    const close = () => setMenuFor(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuFor]);

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const now = new Date();
    const map = new Map<GroupLabel, Chat[]>();
    for (const chat of chats) {
      if (q && !chat.title.toLowerCase().includes(q)) continue;
      const g = groupFor(chat, now);
      map.set(g, [...(map.get(g) ?? []), chat]);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ label: g, chats: map.get(g)! }));
  }, [chats, filter]);

  function startRename(chat: Chat) {
    setMenuFor(null);
    setRenamingId(chat.id);
    setRenameValue(chat.title);
  }

  function commitRename() {
    if (renamingId !== null && renameValue.trim()) onRename(renamingId, renameValue.trim());
    setRenamingId(null);
  }

  return (
    <div className="flex flex-col h-full">
      {/* Agent switcher */}
      <div className="p-3 border-b border-border">
        <p className="text-[10px] text-gray-500 uppercase tracking-widest mb-2">Agent</p>
        <div className="grid grid-cols-2 gap-1.5">
          {agents.map((agent) => {
            const isSelected = agent.id === selectedAgentId;
            const colorClass = AGENT_COLORS[agent.name] ?? 'text-gray-300 border-border';
            return (
              <button
                key={agent.id}
                onClick={() => onSelectAgent(agent.id)}
                className={`px-2 py-1.5 rounded border text-xs font-medium truncate transition-colors
                  ${isSelected
                    ? `${colorClass} bg-surface-200`
                    : 'text-gray-400 border-transparent hover:bg-surface-200 hover:text-gray-200'}`}
              >
                {agent.name}
              </button>
            );
          })}
        </div>
      </div>

      {/* New chat + filter */}
      <div className="p-3 space-y-2">
        <button className="btn-ghost w-full text-xs py-1.5" onClick={onNewChat} disabled={selectedAgentId === null}>
          + New chat
        </button>
        <input
          className="input text-xs py-1.5"
          placeholder="Search chats…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>

      {/* Chat list */}
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {groups.length === 0 && (
          <p className="text-xs text-gray-600 px-2 py-4 text-center">
            {filter ? 'No chats match.' : 'No chats yet.'}
          </p>
        )}

        {groups.map((group) => (
          <div key={group.label} className="mb-3">
            <p className="text-[10px] text-gray-600 uppercase tracking-widest px-2 mb-1">{group.label}</p>
            {group.chats.map((chat) => {
              const isActive = chat.id === activeChatId;
              if (renamingId === chat.id) {
                return (
                  <input
                    key={chat.id}
                    autoFocus
                    className="input text-xs py-1 mb-0.5"
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename();
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                  />
                );
              }
              return (
                <div key={chat.id} className="relative group">
                  <button
                    onClick={() => onOpenChat(chat.id)}
                    onDoubleClick={() => startRename(chat)}
                    title={chat.title}
                    className={`w-full text-left pl-2 pr-7 py-1.5 rounded text-xs truncate transition-colors
                      ${isActive
                        ? 'bg-surface-200 text-gray-100'
                        : 'text-gray-400 hover:bg-surface-200 hover:text-gray-200'}`}
                  >
                    {chat.pinned && !chat.archived && <span className="mr-1 opacity-60">📌</span>}
                    {chat.title}
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setMenuFor(menuFor === chat.id ? null : chat.id);
                    }}
                    className={`absolute right-1 top-1/2 -translate-y-1/2 px-1.5 rounded text-gray-500
                      hover:text-gray-200 hover:bg-surface-100 text-xs
                      ${menuFor === chat.id || isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                    aria-label="Chat options"
                  >
                    ⋯
                  </button>
                  {menuFor === chat.id && (
                    <div
                      className="absolute right-0 top-full mt-0.5 z-20 w-36 bg-surface-100 border border-border
                                 rounded shadow-lg py-1 text-xs"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MenuItem onClick={() => startRename(chat)}>Rename</MenuItem>
                      {!chat.archived && (
                        <MenuItem onClick={() => { setMenuFor(null); onTogglePin(chat); }}>
                          {chat.pinned ? 'Unpin' : 'Pin'}
                        </MenuItem>
                      )}
                      <MenuItem onClick={() => { setMenuFor(null); onToggleArchive(chat); }}>
                        {chat.archived ? 'Unarchive' : 'Archive'}
                      </MenuItem>
                      <MenuItem danger onClick={() => { setMenuFor(null); onDelete(chat); }}>
                        Delete
                      </MenuItem>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="border-t border-border px-3 py-2">
        <button
          onClick={onToggleArchived}
          className="text-[11px] text-gray-600 hover:text-gray-400 transition-colors"
        >
          {showArchived ? 'Hide archived' : 'Show archived'}
        </button>
      </div>
    </div>
  );
}

function MenuItem({
  children,
  onClick,
  danger,
}: {
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 hover:bg-surface-200
        ${danger ? 'text-red-400' : 'text-gray-300'}`}
    >
      {children}
    </button>
  );
}

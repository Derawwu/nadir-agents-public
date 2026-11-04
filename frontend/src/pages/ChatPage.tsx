/**
 * Chat page — Claude-style multi-chat per agent.
 *
 * URL is the source of truth: /chat/<agent>/<chat>, e.g. /chat/narrator/misc.
 * <agent> is the agent's name as a slug, <chat> is the chat's slug (derived
 * from its title) or "new" for an unsent draft. /chat/<agent> reopens that
 * agent's last-opened chat (or its most recent one, or a new draft).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChatSidebar } from '../components/ChatSidebar';
import { FeatureSelector } from '../components/FeatureSelector';
import { ChatWindow } from '../components/ChatWindow';
import { MemoryPanel } from '../components/MemoryPanel';
import {
  agentSlug,
  fetchAgents,
  fetchFeatures,
  fetchChats,
  fetchChat,
  fetchChatBySlug,
  updateChat,
  deleteChat,
} from '../api/client';
import type { Agent, Chat, Feature, StoredMessage } from '../api/client';

const LS_AGENT_KEY = 'nadir_active_agent_id';
const lastChatKey = (agentId: number) => `nadir_last_chat_${agentId}`;

function readStoredInt(key: string): number | null {
  const v = localStorage.getItem(key);
  if (v === null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

export function ChatPage() {
  const params = useParams<{ agentSlug?: string; chatSlug?: string }>();
  const navigate = useNavigate();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [features, setFeatures] = useState<Feature[]>([]);
  const [chats, setChats] = useState<Chat[] | null>(null);
  // Which agent `chats` was loaded for — guards against acting on the previous
  // agent's list during the render right after switching agents.
  const [chatsAgentId, setChatsAgentId] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [activeChat, setActiveChatState] = useState<Chat | null>(null);
  const [initialMessages, setInitialMessages] = useState<StoredMessage[]>([]);
  const [windowKey, setWindowKey] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [draftFeatureId, setDraftFeatureId] = useState<number | null>(null);
  const [featurePickerOpen, setFeaturePickerOpen] = useState(false);
  const [renamingTitle, setRenamingTitle] = useState<string | null>(null);
  const [memoryRefresh, setMemoryRefresh] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Mirrors activeChat synchronously so the load effect can tell "the URL now
  // points at the chat that's already on screen" (after create or rename)
  // and keep the mounted ChatWindow instead of reloading it.
  const activeChatRef = useRef<Chat | null>(null);
  // Only the latest metadata refresh may apply (done + title fetches can race).
  const metaSeqRef = useRef(0);

  function setActiveChat(chat: Chat | null) {
    activeChatRef.current = chat;
    setActiveChatState(chat);
  }

  const agent = agents.find((a) => agentSlug(a.name) === params.agentSlug) ?? null;
  const agentId = agent?.id ?? null;
  const agentPath = agent ? `/chat/${agentSlug(agent.name)}` : '/chat';
  const chatPath = (chat: Chat) => `${agentPath}/${chat.slug}`;
  const isDraft = params.chatSlug === 'new';
  const chatSlug = params.chatSlug && !isDraft ? params.chatSlug : null;

  // ── Initial data ──────────────────────────────────────────────────────────
  useEffect(() => {
    Promise.all([fetchAgents(), fetchFeatures()])
      .then(([a, f]) => {
        setAgents(a);
        setFeatures(f);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : 'Failed to load data'));
  }, []);

  // ── Resolve a missing/unknown agent in the URL ────────────────────────────
  useEffect(() => {
    if (agents.length === 0 || agent) return;
    const stored = readStoredInt(LS_AGENT_KEY);
    const fallback = agents.find((a) => a.id === stored) ?? agents[0];
    navigate(`/chat/${agentSlug(fallback.name)}`, { replace: true });
  }, [agents, agent, navigate]);

  useEffect(() => {
    if (agentId !== null) localStorage.setItem(LS_AGENT_KEY, String(agentId));
  }, [agentId]);

  // ── Chat list for the selected agent ──────────────────────────────────────
  const refreshChats = useCallback(async () => {
    if (agentId === null) return;
    let list: Chat[] = [];
    try {
      list = await fetchChats(agentId, showArchived);
    } catch {
      // Leave the list empty on failure.
    }
    setChats(list);
    setChatsAgentId(agentId);
  }, [agentId, showArchived]);

  useEffect(() => {
    setChats(null);
    void refreshChats();
  }, [refreshChats]);

  // ── /chat/<agent> with no chat → reopen last / most recent / new ──────────
  useEffect(() => {
    if (agentId === null || params.chatSlug !== undefined || chats === null || chatsAgentId !== agentId) return;
    const last = readStoredInt(lastChatKey(agentId));
    const target =
      (last !== null && chats.find((c) => c.id === last)) ||
      chats.find((c) => !c.archived);
    navigate(target ? `${agentPath}/${target.slug}` : `${agentPath}/new`, { replace: true });
  }, [agentId, agentPath, params.chatSlug, chats, chatsAgentId, navigate]);

  // ── Load the selected chat (or set up a draft) ────────────────────────────
  useEffect(() => {
    setFeaturePickerOpen(false);
    setRenamingTitle(null);

    if (agentId === null) return;
    if (activeChatRef.current && activeChatRef.current.agent_id !== agentId) setActiveChat(null);

    if (isDraft) {
      setActiveChat(null);
      setInitialMessages([]);
      setDraftFeatureId(null);
      setWindowKey(`new-${agentId}-${Date.now()}`);
      return;
    }

    if (chatSlug === null) return;

    const shown = activeChatRef.current;
    if (shown && shown.agent_id === agentId && shown.slug === chatSlug) {
      // Already on screen (just created or renamed) — keep the window as is.
      localStorage.setItem(lastChatKey(agentId), String(shown.id));
      return;
    }

    let cancelled = false;
    setChatLoading(true);
    fetchChatBySlug(agentId, chatSlug)
      .then((detail) => {
        if (cancelled) return;
        if (!detail) {
          localStorage.removeItem(lastChatKey(agentId));
          navigate(agentPath, { replace: true });
          return;
        }
        localStorage.setItem(lastChatKey(agentId), String(detail.chat.id));
        setActiveChat(detail.chat);
        setInitialMessages(detail.messages);
        setWindowKey(`chat-${detail.chat.id}`);
      })
      .catch(() => {
        if (!cancelled) navigate(agentPath, { replace: true });
      })
      .finally(() => {
        if (!cancelled) setChatLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // agentPath is derived from agentId; listing it would refire needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, chatSlug, isDraft, navigate]);

  // ── Actions ───────────────────────────────────────────────────────────────
  /** Applies an updated chat locally; if it's the open one, follows its new slug. */
  function patchLocal(updated: Chat) {
    setChats((prev) => prev?.map((c) => (c.id === updated.id ? updated : c)) ?? prev);
    if (activeChatRef.current?.id === updated.id) {
      const slugChanged = activeChatRef.current.slug !== updated.slug;
      setActiveChat(updated);
      if (slugChanged) navigate(chatPath(updated), { replace: true });
    }
  }

  /** Re-fetches the open chat's metadata (title/slug) and moves the URL to it. */
  function refreshActiveMeta(id: number) {
    const seq = ++metaSeqRef.current;
    fetchChat(id)
      .then((d) => {
        if (seq !== metaSeqRef.current) return;
        setActiveChat(d.chat);
        navigate(chatPath(d.chat), { replace: true });
      })
      .catch(() => undefined);
  }

  async function handleRename(id: number, title: string) {
    patchLocal(await updateChat(id, { title }));
  }

  async function handleTogglePin(chat: Chat) {
    await updateChat(chat.id, { pinned: !chat.pinned });
    void refreshChats();
  }

  async function handleToggleArchive(chat: Chat) {
    patchLocal(await updateChat(chat.id, { archived: !chat.archived }));
    void refreshChats();
  }

  async function handleDelete(chat: Chat) {
    if (!window.confirm(`Delete "${chat.title}"? It will be hidden from the chat list.`)) return;
    await deleteChat(chat.id);
    if (agentId !== null && readStoredInt(lastChatKey(agentId)) === chat.id) {
      localStorage.removeItem(lastChatKey(agentId));
    }
    await refreshChats();
    if (activeChatRef.current?.id === chat.id) {
      setActiveChat(null);
      navigate(agentPath);
    }
  }

  async function handleFeatureChange(featureId: number | null) {
    setFeaturePickerOpen(false);
    if (activeChat) {
      patchLocal(await updateChat(activeChat.id, { featureId }));
    } else {
      setDraftFeatureId(featureId);
    }
  }

  function handleConversationCreated(id: number) {
    void refreshChats();
    // A draft just became a real chat: move the URL from /new to its slug
    // without remounting the window (the stream may still deliver a title).
    if (isDraft) refreshActiveMeta(id);
  }

  function handleTitleGenerated(id: number, title: string, slug: string) {
    setChats((prev) => prev?.map((c) => (c.id === id ? { ...c, title, slug } : c)) ?? prev);
    refreshActiveMeta(id);
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center text-red-400 text-sm">{loadError}</div>
    );
  }

  const selectedAgent = agent;
  const featureId = activeChat ? activeChat.feature_id : draftFeatureId;
  const selectedFeature = features.find((f) => f.id === featureId) ?? null;
  const isClosedFeature = selectedFeature?.status === 'closed';
  const title = activeChat?.title ?? 'New chat';

  function commitTitle() {
    if (activeChat && renamingTitle !== null && renamingTitle.trim() && renamingTitle.trim() !== activeChat.title) {
      void handleRename(activeChat.id, renamingTitle.trim());
    }
    setRenamingTitle(null);
  }

  const chatContent = (() => {
    if (agentId === null || (!isDraft && chatSlug === null)) {
      return <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">Loading…</div>;
    }
    if (chatLoading || !windowKey) {
      return (
        <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
          Loading conversation…
        </div>
      );
    }
    return (
      <ChatWindow
        key={windowKey}
        agentId={agentId}
        agentName={selectedAgent?.name ?? null}
        featureId={featureId}
        conversationId={activeChat?.id ?? null}
        initialMessages={initialMessages}
        onConversationCreated={handleConversationCreated}
        onTitleGenerated={handleTitleGenerated}
        onMemorySaved={() => setMemoryRefresh((n) => n + 1)}
      />
    );
  })();

  return (
    <div className="flex h-full">
      {/* Left sidebar: agents + chats */}
      <aside className="w-60 shrink-0 border-r border-border">
        <ChatSidebar
          agents={agents}
          selectedAgentId={agentId}
          onSelectAgent={(id) => {
            const a = agents.find((x) => x.id === id);
            if (a) navigate(`/chat/${agentSlug(a.name)}`);
          }}
          chats={chatsAgentId === agentId ? (chats ?? []) : []}
          activeChatId={activeChat?.id ?? null}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((v) => !v)}
          onNewChat={() => agentId !== null && navigate(`${agentPath}/new`)}
          onOpenChat={(id) => {
            const c = chats?.find((x) => x.id === id);
            if (c) navigate(chatPath(c));
          }}
          onRename={(id, t) => void handleRename(id, t)}
          onTogglePin={(c) => void handleTogglePin(c)}
          onToggleArchive={(c) => void handleToggleArchive(c)}
          onDelete={(c) => void handleDelete(c)}
        />
      </aside>

      {/* Main chat area */}
      <main className="flex-1 flex flex-col min-w-0">
        <div className="border-b border-border px-6 py-3 flex items-center gap-3 relative">
          <span className="text-sm font-medium text-gray-400 shrink-0">{selectedAgent?.name ?? '—'}</span>
          <span className="text-gray-600">·</span>

          {renamingTitle !== null ? (
            <input
              autoFocus
              className="input text-sm py-1 max-w-sm"
              value={renamingTitle}
              onChange={(e) => setRenamingTitle(e.target.value)}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTitle();
                if (e.key === 'Escape') setRenamingTitle(null);
              }}
            />
          ) : (
            <button
              className="text-sm text-gray-200 truncate hover:text-white disabled:cursor-default"
              onClick={() => activeChat && setRenamingTitle(activeChat.title)}
              disabled={!activeChat}
              title={activeChat ? 'Click to rename' : undefined}
            >
              {title}
            </button>
          )}

          {activeChat?.archived && (
            <span className="text-[10px] uppercase tracking-wide text-gray-500 border border-border rounded px-1.5 py-0.5">
              Archived
            </span>
          )}

          <button
            className="ml-auto text-xs text-gray-400 hover:text-gray-200 border border-border rounded px-2 py-1
                       max-w-[16rem] truncate"
            onClick={() => setFeaturePickerOpen((v) => !v)}
            title="The feature this chat is about"
          >
            Feature: {selectedFeature ? selectedFeature.name : 'General'} ▾
          </button>

          {featurePickerOpen && (
            <div className="fixed inset-0 z-20" onClick={() => setFeaturePickerOpen(false)} />
          )}
          {featurePickerOpen && (
            <div
              className="absolute right-6 top-full mt-1 z-30 w-72 max-h-[70vh] overflow-y-auto bg-surface-100
                         border border-border rounded shadow-xl p-3"
            >
              <FeatureSelector
                features={features}
                selectedId={featureId}
                onSelect={(id) => void handleFeatureChange(id)}
                onFeatureCreated={(f) => {
                  setFeatures((prev) => [f, ...prev]);
                  void handleFeatureChange(f.id);
                }}
                onSynced={() => {
                  fetchFeatures().then(setFeatures).catch(console.error);
                }}
              />
            </div>
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
          agentId={agentId}
          agentName={selectedAgent?.name ?? null}
          chatId={activeChat?.id ?? null}
          featureId={featureId}
          featureName={selectedFeature?.name ?? null}
          refreshTrigger={memoryRefresh}
        />
      </aside>
    </div>
  );
}

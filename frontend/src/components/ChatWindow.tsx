import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageBubble } from './MessageBubble';
import { ContextTrayBar } from './ContextTrayBar';
import { useContextTray } from '../contexts/ContextTrayContext';
import { sendChatMessage, saveMemory } from '../api/client';
import type { MemoryType, StoredMessage } from '../api/client';
import { dayKey, formatDayLabel } from '../utils/dateFormat';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  isStreaming?: boolean;
  isInfo?: boolean;
}

interface Props {
  agentId: number | null;
  agentName: string | null;
  featureId: number | null;
  conversationId: number | null;
  initialMessages: StoredMessage[];
  onConversationCreated: (id: number) => void;
  onMemorySaved: () => void;
}

const BOTTOM_THRESHOLD_PX = 80;

export function ChatWindow({
  agentId,
  agentName,
  featureId,
  conversationId,
  initialMessages,
  onConversationCreated,
  onMemorySaved,
}: Props) {
  const [messages, setMessages] = useState<Message[]>(() =>
    initialMessages.map((m) => ({
      id: String(m.id),
      role: m.role,
      content: m.content,
      createdAt: m.created_at,
    }))
  );
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [matchIndex, setMatchIndex] = useState(0);

  const listRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const cleanupRef = useRef<(() => void) | null>(null);
  const activeConvRef = useRef<number | null>(conversationId);
  const isAtBottomRef = useRef(true);
  const prevMessageCountRef = useRef(0);
  const { augmentMessage } = useContextTray();

  // Keep the ref in sync with the latest conversationId.
  useEffect(() => {
    activeConvRef.current = conversationId;
  }, [conversationId]);

  // Autoscroll only when a new message is appended (e.g. on send), not while
  // an existing assistant message's content is growing mid-stream.
  useEffect(() => {
    const isNewMessage = messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (isNewMessage && isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
  }

  function scrollToBottom() {
    isAtBottomRef.current = true;
    setIsAtBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  // Abort any in-flight stream on unmount.
  useEffect(() => {
    return () => {
      cleanupRef.current?.();
    };
  }, []);

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return messages.filter((m) => !m.isInfo && m.content.toLowerCase().includes(q));
  }, [messages, searchQuery]);

  useEffect(() => {
    setMatchIndex(0);
  }, [searchQuery]);

  useEffect(() => {
    if (searchMatches.length === 0) return;
    const target = searchMatches[matchIndex % searchMatches.length];
    messageRefs.current.get(target.id)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [matchIndex, searchMatches]);

  function goToMatch(delta: number) {
    if (searchMatches.length === 0) return;
    setMatchIndex((i) => (i + delta + searchMatches.length) % searchMatches.length);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery('');
  }

  async function handleSend() {
    if (!agentId || !input.trim() || sending) return;

    const userText = input.trim();
    setInput('');
    setSending(true);
    setError(null);

    const now = () => new Date().toISOString();
    const userMsgId = `user-${Date.now()}`;
    const attachInfoMsgId = `attach-${Date.now()}`;
    const assistantMsgId = `assistant-${Date.now()}`;

    // Show user message immediately.
    setMessages((prev) => [
      ...prev,
      { id: userMsgId, role: 'user', content: userText, createdAt: now() },
    ]);

    // Fetch any tray context (may be a no-op if tray is empty).
    const { text: messageToSend, attachedCount } = await augmentMessage(userText);

    // Show attachment indicator if context was attached.
    if (attachedCount > 0) {
      setMessages((prev) => [
        ...prev,
        {
          id: attachInfoMsgId,
          role: 'user',
          content: `📎 ${attachedCount} context item${attachedCount !== 1 ? 's' : ''} attached`,
          isInfo: true,
          createdAt: now(),
        },
      ]);
    }

    // Add streaming assistant placeholder.
    setMessages((prev) => [
      ...prev,
      { id: assistantMsgId, role: 'assistant', content: '', isStreaming: true, createdAt: now() },
    ]);

    let resolvedConvId = activeConvRef.current;

    cleanupRef.current = sendChatMessage(
      {
        agentId,
        featureId,
        message: messageToSend,
        conversationId: resolvedConvId,
      },
      (event) => {
        if (event.type === 'chunk') {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, content: m.content + event.text } : m
            )
          );
        } else if (event.type === 'done') {
          resolvedConvId = event.conversationId;
          activeConvRef.current = event.conversationId;
          onConversationCreated(event.conversationId);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, isStreaming: false } : m
            )
          );
          setSending(false);
        } else if (event.type === 'error') {
          setError(event.error);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, isStreaming: false, content: '[Error: ' + event.error + ']' }
                : m
            )
          );
          setSending(false);
        }
      }
    );
  }

  async function handleSaveMemory(messageContent: string, type: MemoryType): Promise<void> {
    if (!agentId || !activeConvRef.current) return;
    await saveMemory({
      conversationId: activeConvRef.current,
      agentId,
      featureId,
      type,
      content: messageContent,
    });
    onMemorySaved();
  }

  if (!agentId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-600">
        Select an agent to start chatting.
      </div>
    );
  }

  const activeMatchId =
    searchMatches.length > 0 ? searchMatches[matchIndex % searchMatches.length].id : null;

  return (
    <div className="flex flex-col h-full">
      {/* Search bar */}
      {searchOpen && (
        <div className="border-b border-border px-6 py-2 flex items-center gap-2 bg-surface-100">
          <input
            autoFocus
            className="input flex-1 text-sm py-1.5"
            placeholder="Search in this conversation…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') closeSearch();
              if (e.key === 'Enter') goToMatch(e.shiftKey ? -1 : 1);
            }}
          />
          <span className="text-xs text-gray-500 shrink-0 w-14 text-center">
            {searchQuery.trim() ? `${searchMatches.length ? (matchIndex % searchMatches.length) + 1 : 0}/${searchMatches.length}` : ''}
          </span>
          <button
            className="text-gray-500 hover:text-gray-200 text-sm px-1.5"
            onClick={() => goToMatch(-1)}
            disabled={searchMatches.length === 0}
            title="Previous match"
          >
            ↑
          </button>
          <button
            className="text-gray-500 hover:text-gray-200 text-sm px-1.5"
            onClick={() => goToMatch(1)}
            disabled={searchMatches.length === 0}
            title="Next match"
          >
            ↓
          </button>
          <button
            className="text-gray-500 hover:text-gray-200 text-sm px-1.5"
            onClick={closeSearch}
            title="Close search"
          >
            ✕
          </button>
        </div>
      )}

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-6 py-4 relative" ref={listRef} onScroll={handleScroll}>
        {!searchOpen && (
          <button
            className="absolute top-2 right-3 text-xs text-gray-500 hover:text-gray-200 border border-border
                       rounded px-2 py-1 bg-surface-100/80 z-10"
            onClick={() => setSearchOpen(true)}
            title="Search in conversation"
          >
            🔍
          </button>
        )}

        {messages.length === 0 && (
          <div className="text-center text-gray-600 text-sm mt-16">
            Start a conversation with {agentName ?? 'this agent'}.
          </div>
        )}

        {messages.map((msg, i) => {
          const prev = messages[i - 1];
          const showDivider = !prev || dayKey(prev.createdAt) !== dayKey(msg.createdAt);

          return (
            <div key={msg.id}>
              {showDivider && (
                <div className="flex items-center justify-center my-3">
                  <span className="text-[11px] uppercase tracking-wide text-gray-500 bg-surface-100
                                    border border-border rounded-full px-3 py-0.5">
                    {formatDayLabel(msg.createdAt)}
                  </span>
                </div>
              )}

              {msg.isInfo ? (
                <div className="text-xs text-blue-400 text-center my-1 opacity-75">
                  {msg.content}
                </div>
              ) : (
                <div
                  ref={(el) => {
                    if (el) messageRefs.current.set(msg.id, el);
                    else messageRefs.current.delete(msg.id);
                  }}
                  className={activeMatchId === msg.id ? 'ring-1 ring-accent/60 rounded-lg' : undefined}
                >
                  <MessageBubble
                    role={msg.role}
                    content={msg.content}
                    createdAt={msg.createdAt}
                    agentName={msg.role === 'assistant' ? (agentName ?? undefined) : undefined}
                    isStreaming={msg.isStreaming}
                    highlight={searchQuery.trim() || undefined}
                    onSaveMemory={
                      msg.role === 'assistant'
                        ? (type, content) => handleSaveMemory(content, type)
                        : undefined
                    }
                  />
                </div>
              )}
            </div>
          );
        })}

        {error && (
          <div className="text-red-400 text-xs text-center mb-4">{error}</div>
        )}

        <div ref={bottomRef} />
      </div>

      {!isAtBottom && (
        <div className="relative">
          <button
            className="absolute -top-12 right-6 text-xs bg-surface-200 border border-border rounded-full
                       px-3 py-1.5 text-gray-300 hover:text-white hover:border-accent/50 shadow-md"
            onClick={scrollToBottom}
          >
            ↓ Jump to latest
          </button>
        </div>
      )}

      {/* Context tray bar */}
      <ContextTrayBar />

      {/* Input area */}
      <div className="border-t border-border px-6 py-4">
        <div className="flex gap-3">
          <textarea
            className="input resize-y h-20 min-h-[3rem] max-h-[60vh] text-sm"
            placeholder={`Message ${agentName ?? 'agent'}…`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            disabled={sending}
          />
          <button
            className="btn-primary px-5 self-end"
            onClick={() => void handleSend()}
            disabled={sending || !input.trim()}
          >
            {sending ? '...' : 'Send'}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1.5">Enter to send · Shift+Enter for newline · drag bottom-right corner to resize</p>
      </div>
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { MessageBubble } from './MessageBubble';
import { ContextTrayBar } from './ContextTrayBar';
import { ContextSources } from './ContextSources';
import { ToolActivity } from './ToolActivity';
import { useContextTray } from '../contexts/ContextTrayContext';
import { resumeRun, sendChatMessage, saveMemory, uploadChatImage } from '../api/client';
import type {
  ChatSSEEvent,
  ContextSource,
  MemoryType,
  MessageImageRef,
  PendingImage,
  PendingRun,
  StoredMessage,
  ToolCall,
} from '../api/client';
import { dayKey, formatDayLabel } from '../utils/dateFormat';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: MessageImageRef[];
  sources?: ContextSource[];
  /** Tools the agent used for this reply. */
  toolCalls?: ToolCall[];
  /** Set while the reply is paused for approval of its actions. */
  runId?: number | null;
  createdAt: string;
  isStreaming?: boolean;
  isInfo?: boolean;
}

/** Adds or replaces tool calls by id, keeping their order. */
function mergeCalls(existing: ToolCall[] | undefined, incoming: ToolCall[]): ToolCall[] {
  const out = [...(existing ?? [])];
  for (const call of incoming) {
    const i = out.findIndex((c) => c.id === call.id);
    if (i >= 0) out[i] = call;
    else out.push(call);
  }
  return out;
}

interface Props {
  agentId: number | null;
  agentName: string | null;
  featureId: number | null;
  conversationId: number | null;
  initialMessages: StoredMessage[];
  /** A reply of this chat that is waiting for the user to approve its actions. */
  initialPendingRun?: PendingRun | null;
  /** Fires after each completed reply with the chat id (new or existing). */
  onConversationCreated: (id: number, slug: string | null) => void;
  /** Fires when the backend auto-titles a new chat (the slug changes with it). */
  onTitleGenerated?: (id: number, title: string, slug: string) => void;
  onMemorySaved: () => void;
}

const BOTTOM_THRESHOLD_PX = 80;

export function ChatWindow({
  agentId,
  agentName,
  featureId,
  conversationId,
  initialMessages,
  initialPendingRun,
  onConversationCreated,
  onTitleGenerated,
  onMemorySaved,
}: Props) {
  const [messages, setMessages] = useState<Message[]>(() => {
    const list: Message[] = initialMessages.map((m) => ({
      id: String(m.id),
      role: m.role,
      content: m.content,
      images: m.images,
      sources: m.contextSources,
      toolCalls: m.toolCalls,
      createdAt: m.created_at,
    }));
    if (initialPendingRun) {
      list.push({
        id: `run-${initialPendingRun.runId}`,
        role: 'assistant',
        content: initialPendingRun.text,
        sources: initialPendingRun.sources,
        toolCalls: initialPendingRun.toolCalls,
        runId: initialPendingRun.runId,
        createdAt: new Date().toISOString(),
      });
    }
    return list;
  });
  // Decisions on a paused reply's cards, sent once every card has one.
  const [decisions, setDecisions] = useState<Record<number, 'approve' | 'reject'>>({});
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [uploadingCount, setUploadingCount] = useState(0);
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

  // Opening a chat: jump straight to the latest message before paint, so a
  // long history doesn't animate-scroll from the top.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    prevMessageCountRef.current = messages.length;
    // Runs once per mounted chat (ChatWindow is keyed by chat).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  async function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const imageItems = Array.from(event.clipboardData.items).filter((item) =>
      item.type.startsWith('image/')
    );
    if (imageItems.length === 0) return;
    event.preventDefault();

    setUploadingCount((n) => n + imageItems.length);
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) {
        setUploadingCount((n) => n - 1);
        continue;
      }
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });
        const uploaded = await uploadChatImage(dataUrl);
        setPendingImages((prev) => [...prev, uploaded]);
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : 'Failed to upload pasted image');
      } finally {
        setUploadingCount((n) => n - 1);
      }
    }
  }

  function removePendingImage(filename: string) {
    setPendingImages((prev) => prev.filter((img) => img.filename !== filename));
  }

  async function handleSend() {
    if (!agentId || sending) return;
    if (!input.trim() && pendingImages.length === 0) return;

    const userText = input.trim();
    const imagesToSend = pendingImages;
    setInput('');
    setPendingImages([]);
    setSending(true);
    setError(null);

    const now = () => new Date().toISOString();
    const userMsgId = `user-${Date.now()}`;
    const attachInfoMsgId = `attach-${Date.now()}`;
    const assistantMsgId = `assistant-${Date.now()}`;

    // Show user message immediately.
    setMessages((prev) => [
      ...prev,
      {
        id: userMsgId,
        role: 'user',
        content: userText,
        images: imagesToSend.map((img) => ({ url: img.url, media_type: img.media_type })),
        createdAt: now(),
      },
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

    // A reply still waiting for approval is closed by the backend when a new
    // message arrives; show its cards as skipped.
    setMessages((prev) =>
      prev.map((m) =>
        m.runId
          ? {
              ...m,
              runId: null,
              toolCalls: m.toolCalls?.map((c) => (c.status === 'pending' ? { ...c, status: 'skipped' as const } : c)),
            }
          : m
      )
    );

    cleanupRef.current = sendChatMessage(
      {
        agentId,
        featureId,
        message: messageToSend,
        images: imagesToSend.map((img) => ({ filename: img.filename, media_type: img.media_type })),
        conversationId: activeConvRef.current,
      },
      streamHandler(assistantMsgId)
    );
  }

  /** Applies stream events (new message or resumed run) to one assistant message. */
  function streamHandler(assistantMsgId: string): (event: ChatSSEEvent) => void {
    const update = (fn: (m: Message) => Message) =>
      setMessages((prev) => prev.map((m) => (m.id === assistantMsgId ? fn(m) : m)));

    return (event) => {
      if (event.type === 'sources') {
        update((m) => ({ ...m, sources: event.sources }));
      } else if (event.type === 'chunk') {
        update((m) => ({ ...m, content: m.content + event.text }));
      } else if (event.type === 'retract') {
        update((m) => ({ ...m, content: m.content.slice(0, Math.max(0, m.content.length - event.chars)) }));
      } else if (event.type === 'tool') {
        update((m) => ({ ...m, toolCalls: mergeCalls(m.toolCalls, [event.call]) }));
      } else if (event.type === 'approval') {
        update((m) => ({ ...m, runId: event.runId, toolCalls: mergeCalls(m.toolCalls, event.calls) }));
      } else if (event.type === 'done') {
        activeConvRef.current = event.conversationId;
        onConversationCreated(event.conversationId, event.slug);
        update((m) => ({ ...m, isStreaming: false, runId: event.awaitingRunId }));
        setSending(false);
      } else if (event.type === 'title') {
        onTitleGenerated?.(event.conversationId, event.title, event.slug);
      } else if (event.type === 'error') {
        setError(event.error);
        update((m) => ({
          ...m,
          isStreaming: false,
          content: m.content ? `${m.content}\n\n[Error: ${event.error}]` : `[Error: ${event.error}]`,
        }));
        setSending(false);
      }
    };
  }

  /**
   * Records a decision on an action card. Once every pending card of the
   * paused reply has one, they go to the backend together and the reply
   * continues streaming into the same message.
   */
  function handleDecide(msg: Message, call: ToolCall, decision: 'approve' | 'reject') {
    if (!msg.runId || sending) return;
    const next = { ...decisions, [call.id]: decision };
    const pending = (msg.toolCalls ?? []).filter((c) => c.status === 'pending');
    if (!pending.every((c) => next[c.id])) {
      setDecisions(next);
      return;
    }
    const runDecisions = Object.fromEntries(pending.map((c) => [c.id, next[c.id]!]));
    setDecisions((prev) => {
      const rest = { ...prev };
      for (const c of pending) delete rest[c.id];
      return rest;
    });
    setSending(true);
    setError(null);
    setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, isStreaming: true, runId: null } : m)));
    cleanupRef.current = resumeRun(msg.runId, runDecisions, streamHandler(msg.id));
  }

  async function handleSaveMemory(messageContent: string, type: MemoryType): Promise<void> {
    if (!agentId || !activeConvRef.current) return;
    await saveMemory({
      conversationId: activeConvRef.current,
      agentId,
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
                    images={msg.images}
                    createdAt={msg.createdAt}
                    agentName={msg.role === 'assistant' ? (agentName ?? undefined) : undefined}
                    isStreaming={msg.isStreaming}
                    highlight={searchQuery.trim() || undefined}
                    footer={
                      (msg.toolCalls && msg.toolCalls.length > 0) || (msg.sources && msg.sources.length > 0) ? (
                        <>
                          {msg.toolCalls && msg.toolCalls.length > 0 && (
                            <ToolActivity
                              calls={msg.toolCalls}
                              onDecide={msg.runId ? (call, decision) => handleDecide(msg, call, decision) : undefined}
                              decided={decisions}
                              busy={sending}
                            />
                          )}
                          {msg.sources && msg.sources.length > 0 && (
                            <ContextSources sources={msg.sources} agentName={agentName} />
                          )}
                        </>
                      ) : undefined
                    }
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
        {(pendingImages.length > 0 || uploadingCount > 0) && (
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {pendingImages.map((img) => (
              <div key={img.filename} className="relative">
                <img
                  src={img.url}
                  alt="Pasted attachment"
                  className="h-14 w-14 object-cover rounded border border-border"
                />
                <button
                  onClick={() => removePendingImage(img.filename)}
                  className="absolute -top-1.5 -right-1.5 bg-surface-200 border border-border rounded-full
                             w-4 h-4 text-[10px] text-gray-400 hover:text-red-400 leading-none"
                  aria-label="Remove image"
                >
                  ×
                </button>
              </div>
            ))}
            {uploadingCount > 0 && (
              <span className="text-xs text-gray-500">Uploading {uploadingCount}…</span>
            )}
          </div>
        )}
        <div className="flex gap-3">
          <textarea
            className="input resize-y h-20 min-h-[3rem] max-h-[60vh] text-sm"
            placeholder={`Message ${agentName ?? 'agent'}… (paste an image to attach it)`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
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
            disabled={sending || (!input.trim() && pendingImages.length === 0)}
          >
            {sending ? '...' : 'Send'}
          </button>
        </div>
        <p className="text-xs text-gray-600 mt-1.5">Enter to send · Shift+Enter for newline · paste an image to attach · drag bottom-right corner to resize</p>
      </div>
    </div>
  );
}

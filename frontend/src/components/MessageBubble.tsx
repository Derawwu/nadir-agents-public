import { useState, type ReactNode } from 'react';
import type { MemoryType, MessageImageRef } from '../api/client';
import { formatMessageTime } from '../utils/dateFormat';
import { CopyButton } from './CopyButton';

const MEMORY_TYPES: MemoryType[] = ['decision', 'lore', 'technical', 'visual', 'flag', 'conflict'];

interface Props {
  role: 'user' | 'assistant';
  content: string;
  images?: MessageImageRef[];
  createdAt: string;
  agentName?: string;
  /** When provided, a "Save as memory" button is shown for assistant messages. */
  onSaveMemory?: (type: MemoryType, content: string) => Promise<void>;
  isStreaming?: boolean;
  /** Case-insensitive search term to highlight within the message content. */
  highlight?: string;
  /** Extra content under the message (e.g. retrieval sources). */
  footer?: ReactNode;
}

function renderHighlighted(content: string, highlight?: string) {
  if (!highlight) return content;
  const escaped = highlight.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = content.split(new RegExp(`(${escaped})`, 'gi'));
  return parts.map((part, i) =>
    part.toLowerCase() === highlight.toLowerCase() ? (
      <mark key={i} className="bg-accent/40 text-white rounded-sm">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export function MessageBubble({
  role,
  content,
  images,
  createdAt,
  agentName,
  onSaveMemory,
  isStreaming,
  highlight,
  footer,
}: Props) {
  const [memoryType, setMemoryType] = useState<MemoryType>('decision');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function handleSave() {
    if (!onSaveMemory || saving) return;
    setSaving(true);
    try {
      await onSaveMemory(memoryType, content);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  const isUser = role === 'user';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div className={`max-w-[80%] ${isUser ? 'order-2' : 'order-1'}`}>
        {!isUser && agentName && (
          <div className="text-xs text-gray-500 mb-1 ml-1">{agentName}</div>
        )}

        <div
          className={`px-4 py-3 rounded-lg text-sm whitespace-pre-wrap break-words leading-relaxed
            ${isUser
              ? 'bg-accent/20 text-gray-100 border border-accent/30'
              : 'bg-surface-200 text-gray-200 border border-border'
            }`}
        >
          {images && images.length > 0 && (
            <div className={`flex flex-wrap gap-2 ${content ? 'mb-2' : ''}`}>
              {images.map((img, i) => (
                <a key={i} href={img.url} target="_blank" rel="noreferrer">
                  <img
                    src={img.url}
                    alt="Attached image"
                    className="max-h-48 rounded border border-border/60"
                  />
                </a>
              ))}
            </div>
          )}
          {renderHighlighted(content, highlight)}
          {isStreaming && (
            <span className="inline-block w-1.5 h-4 ml-1 bg-accent animate-pulse align-middle" />
          )}
        </div>

        <div className={`flex items-center gap-2 mt-1 ${isUser ? 'justify-end mr-1' : 'ml-1'}`}>
          <span className="text-[11px] text-gray-500">{formatMessageTime(createdAt)}</span>
          {!isStreaming && <CopyButton content={content} />}
        </div>

        {footer}

        {!isUser && !isStreaming && onSaveMemory && (
          <div className="flex items-center gap-2 mt-1.5 ml-1">
            <select
              className="text-xs bg-surface-100 border border-border rounded px-1.5 py-1 text-gray-400
                         focus:outline-none focus:border-accent"
              value={memoryType}
              onChange={(e) => setMemoryType(e.target.value as MemoryType)}
            >
              {MEMORY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <button
              onClick={handleSave}
              disabled={saving}
              className={`text-xs px-2 py-1 rounded border transition-colors
                ${saved
                  ? 'border-green-500/30 text-green-400'
                  : 'border-border text-gray-500 hover:text-accent hover:border-accent/40'
                }`}
            >
              {saved ? '✓ Saved' : saving ? 'Saving...' : 'Save as memory'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

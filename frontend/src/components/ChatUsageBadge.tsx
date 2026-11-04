import { useEffect, useState } from 'react';
import { fetchChatUsage, type ChatUsage } from '../api/client';
import { formatTokens, formatUsd } from '../pages/UsagePage';

/**
 * Small header badge: total cost of this chat, plus the size and cache hit
 * rate of the last request. Refetches whenever refreshKey changes (after
 * every reply).
 */
export function ChatUsageBadge({ chatId, refreshKey }: { chatId: number | null; refreshKey: number }) {
  const [usage, setUsage] = useState<ChatUsage | null>(null);

  useEffect(() => {
    if (chatId === null) {
      setUsage(null);
      return;
    }
    let cancelled = false;
    fetchChatUsage(chatId)
      .then((u) => !cancelled && setUsage(u))
      .catch(() => !cancelled && setUsage(null));
    return () => {
      cancelled = true;
    };
  }, [chatId, refreshKey]);

  if (!usage || usage.calls === 0) return null;
  const last = usage.last;
  const detail = last
    ? `Last reply: ${formatTokens(last.inputTokens)} tokens in, ${last.cacheHitRate != null ? Math.round(last.cacheHitRate * 100) : 0}% from cache, ${formatUsd(last.cost)}${last.strategy ? ` (${last.strategy} history)` : ''}`
    : '';

  return (
    <span
      className="shrink-0 text-[11px] text-gray-500 border border-border rounded px-2 py-0.5 tabular-nums"
      title={`${usage.calls} API calls in this chat, including titles and summaries.\n${detail}`}
    >
      {formatUsd(usage.cost)}
      {last && (
        <>
          {' · '}last {formatTokens(last.inputTokens)}
          {' · '}{last.cacheHitRate != null ? Math.round(last.cacheHitRate * 100) : 0}% cached
        </>
      )}
    </span>
  );
}

/** SQLite's `datetime('now')` yields "YYYY-MM-DD HH:MM:SS" in UTC with no timezone marker. */
export function parseDbTimestamp(value: string): Date {
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(iso);
}

export function formatMessageTime(value: string): string {
  return parseDbTimestamp(value).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Returns "Today", "Yesterday", or a "21 March" / "21 March 2025" style label. */
export function formatDayLabel(value: string): string {
  const date = parseDbTimestamp(value);
  const now = new Date();

  const dateKey = date.toDateString();
  const todayKey = now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);

  if (dateKey === todayKey) return 'Today';
  if (dateKey === yesterday.toDateString()) return 'Yesterday';

  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
  });
}

export function dayKey(value: string): string {
  return parseDbTimestamp(value).toDateString();
}

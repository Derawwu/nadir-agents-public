import { useContextTray } from '../contexts/ContextTrayContext';

export function ContextTrayBar() {
  const { items, removeItem, clearTray } = useContextTray();

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-6 py-2 border-b border-border flex-wrap bg-gray-900/40">
      {items.map((item) => (
        <span
          key={`${item.type}:${item.id}`}
          className="flex items-center gap-1 bg-gray-800 text-gray-300 text-xs px-2 py-1 rounded border border-gray-700"
        >
          <span className="opacity-70">
            {item.type === 'wiki' ? '📄' : item.type === 'plane' ? '🎯' : '🕸️'}
          </span>
          <span className="max-w-[180px] truncate">{item.label}</span>
          <button
            onClick={() => removeItem(item.id, item.type)}
            className="ml-1 text-gray-500 hover:text-gray-200 transition-colors leading-none"
            aria-label={`Remove ${item.label}`}
          >
            ×
          </button>
        </span>
      ))}
      <button
        onClick={clearTray}
        className="ml-auto text-xs text-gray-600 hover:text-gray-400 transition-colors shrink-0"
      >
        Clear all
      </button>
    </div>
  );
}

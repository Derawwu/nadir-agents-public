import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { fetchDocumentContent, fetchPlaneIssueContent, fetchDiagramAgentFormat } from '../api/client';

export type TrayItemType = 'wiki' | 'plane' | 'diagram';

export interface TrayItem {
  type: TrayItemType;
  id: string;
  label: string;
}

interface ContextTrayValue {
  items: TrayItem[];
  addItem: (item: TrayItem) => void;
  removeItem: (id: string, type: TrayItemType) => void;
  clearTray: () => void;
  hasTrayItem: (id: string, type: TrayItemType) => boolean;
  augmentMessage: (text: string) => Promise<{ text: string; attachedCount: number }>;
}

const LS_TRAY_KEY = 'nadir_context_tray';

const ContextTrayContext = createContext<ContextTrayValue | null>(null);

export function ContextTrayProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<TrayItem[]>(() => {
    try {
      const stored = localStorage.getItem(LS_TRAY_KEY);
      return stored ? (JSON.parse(stored) as TrayItem[]) : [];
    } catch {
      return [];
    }
  });

  // In-memory cache — not persisted, re-fetched on refresh if needed
  const contentCacheRef = useRef(new Map<string, string>());

  useEffect(() => {
    localStorage.setItem(LS_TRAY_KEY, JSON.stringify(items));
  }, [items]);

  function addItem(item: TrayItem) {
    setItems((prev) => {
      if (prev.some((i) => i.id === item.id && i.type === item.type)) return prev;
      return [...prev, item];
    });
  }

  function removeItem(id: string, type: TrayItemType) {
    setItems((prev) => prev.filter((i) => !(i.id === id && i.type === type)));
    contentCacheRef.current.delete(`${type}:${id}`);
  }

  function clearTray() {
    setItems([]);
    contentCacheRef.current.clear();
  }

  function hasTrayItem(id: string, type: TrayItemType) {
    return items.some((i) => i.id === id && i.type === type);
  }

  async function augmentMessage(text: string): Promise<{ text: string; attachedCount: number }> {
    if (items.length === 0) return { text, attachedCount: 0 };

    const cache = contentCacheRef.current;
    const attachments: Array<{ label: string; content: string }> = [];

    await Promise.all(
      items.map(async (item) => {
        const cacheKey = `${item.type}:${item.id}`;
        const cached = cache.get(cacheKey);

        if (cached !== undefined) {
          attachments.push({ label: item.label, content: cached });
          return;
        }

        try {
          let content: string;
          if (item.type === 'wiki') {
            const doc = await fetchDocumentContent({ role: 'narrator', documentId: item.id });
            content = `${doc.title}\n\n${doc.text}`;
          } else if (item.type === 'plane') {
            const issue = await fetchPlaneIssueContent({ featureId: Number(item.id) });
            const parts: string[] = [`${issue.jira_key ?? ''} — ${issue.name}`];
            if (issue.description) parts.push(`Description: ${issue.description}`);
            if (issue.locked_decisions && issue.locked_decisions.length > 0) {
              parts.push(`Locked Decisions:\n${issue.locked_decisions.map((d) => `- ${d}`).join('\n')}`);
            }
            if (issue.jira_status) parts.push(`Status: ${issue.jira_status}`);
            content = parts.join('\n\n');
          } else {
            content = await fetchDiagramAgentFormat(item.id);
          }
          cache.set(cacheKey, content);
          attachments.push({ label: item.label, content });
        } catch {
          // Item failed — skip it but continue with others
        }
      })
    );

    if (attachments.length === 0) return { text, attachedCount: 0 };

    const contextBlock = attachments
      .map((a) => `### ${a.label}\n${a.content}`)
      .join('\n\n---\n\n');

    const augmented = `## Attached Context\n\n${contextBlock}\n\n---\n\n## User Message\n${text}`;
    return { text: augmented, attachedCount: attachments.length };
  }

  return (
    <ContextTrayContext.Provider
      value={{ items, addItem, removeItem, clearTray, hasTrayItem, augmentMessage }}
    >
      {children}
    </ContextTrayContext.Provider>
  );
}

export function useContextTray(): ContextTrayValue {
  const ctx = useContext(ContextTrayContext);
  if (!ctx) throw new Error('useContextTray must be used within ContextTrayProvider');
  return ctx;
}

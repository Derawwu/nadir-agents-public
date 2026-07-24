import { useState } from 'react';
import type { Feature, FeaturePhase } from '../api/client';
import { createFeature, syncPlane } from '../api/client';

const STATUS_COLORS: Record<string, string> = {
  backlog: 'text-gray-500',
  active: 'text-green-400',
  review: 'text-yellow-400',
  closed: 'text-gray-600',
};

const PLANE_SYNC_KEY = 'plane_last_sync';

interface Props {
  features: Feature[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onFeatureCreated: (feature: Feature) => void;
  onSynced: () => void;
}

export function FeatureSelector({ features, selectedId, onSelect, onFeatureCreated, onSynced }: Props) {
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPhase, setNewPhase] = useState<FeaturePhase>('kickoff');
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const lastSync = localStorage.getItem(PLANE_SYNC_KEY);

  async function handleCreate() {
    if (!newName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const feature = await createFeature({ name: newName.trim(), phase: newPhase });
      onFeatureCreated(feature);
      setNewName('');
      setCreating(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create feature');
    } finally {
      setSaving(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setError(null);
    try {
      await syncPlane();
      localStorage.setItem(PLANE_SYNC_KEY, new Date().toISOString());
      onSynced();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  const cycles = features.filter((f) => f.jira_type === 'cycle');
  const issues = features.filter((f) => f.jira_type === 'issue');
  const local = features.filter((f) => f.jira_key === null);

  const visibleIssues = showClosed ? issues : issues.filter((f) => f.status !== 'closed');
  const visibleCycles = showClosed ? cycles : cycles.filter((f) => f.status !== 'closed');
  const hasClosed = features.some((f) => f.status === 'closed');

  function FeatureButton({ f }: { f: Feature }) {
    return (
      <button
        key={f.id}
        onClick={() => onSelect(f.id)}
        className={`w-full text-left px-3 py-2 rounded transition-colors
          ${selectedId === f.id
            ? 'bg-surface-200 text-gray-200 border border-border'
            : 'text-gray-500 hover:bg-surface-200 hover:text-gray-300'
          }`}
      >
        <div className="text-xs font-medium truncate">
          {f.jira_key && <span className="text-gray-600 mr-1">{f.jira_key}</span>}
          {f.name}
        </div>
        <div className="flex gap-2 mt-0.5">
          <span className={`text-xs ${STATUS_COLORS[f.status] ?? 'text-gray-500'}`}>
            {f.status}
          </span>
          <span className="text-xs text-gray-600">· {f.phase}</span>
        </div>
      </button>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs text-gray-500 uppercase tracking-widest">Feature</p>
        <div className="flex gap-2">
          <button
            onClick={handleSync}
            disabled={syncing}
            className="text-xs text-blue-400 hover:text-blue-300 transition-colors disabled:opacity-40"
            title={lastSync ? `Last synced: ${new Date(lastSync).toLocaleString()}` : 'Sync Plane issues'}
          >
            {syncing ? 'Syncing…' : 'Sync Plane'}
          </button>
          <button
            onClick={() => setCreating((v) => !v)}
            className="text-xs text-accent hover:text-accent-hover transition-colors"
          >
            {creating ? 'Cancel' : '+ New'}
          </button>
        </div>
      </div>

      {creating && (
        <div className="space-y-2 p-3 bg-surface-200 rounded border border-border">
          <input
            className="input text-xs"
            placeholder="Feature name..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
          <select
            className="input text-xs"
            value={newPhase}
            onChange={(e) => setNewPhase(e.target.value as FeaturePhase)}
          >
            {(['kickoff', 'spec', 'design', 'build', 'review'] as FeaturePhase[]).map((p) => (
              <option key={p} value={p}>
                {p.charAt(0).toUpperCase() + p.slice(1)}
              </option>
            ))}
          </select>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <button
            className="btn-primary w-full text-xs py-1.5"
            onClick={handleCreate}
            disabled={saving || !newName.trim()}
          >
            {saving ? 'Creating...' : 'Create'}
          </button>
        </div>
      )}

      {error && !creating && <p className="text-xs text-red-400">{error}</p>}

      <button
        onClick={() => onSelect(null)}
        className={`w-full text-left px-3 py-2 rounded text-xs transition-colors
          ${selectedId === null
            ? 'bg-surface-200 text-gray-200 border border-border'
            : 'text-gray-500 hover:bg-surface-200 hover:text-gray-300'
          }`}
      >
        — General (no feature)
      </button>

      {visibleCycles.length > 0 && (
        <div>
          <p className="text-xs text-gray-600 uppercase tracking-widest px-1 mt-3 mb-1">Cycles</p>
          {visibleCycles.map((f) => <FeatureButton key={f.id} f={f} />)}
        </div>
      )}

      {visibleIssues.length > 0 && (
        <div>
          <p className="text-xs text-gray-600 uppercase tracking-widest px-1 mt-3 mb-1">Issues</p>
          {visibleIssues.map((f) => <FeatureButton key={f.id} f={f} />)}
        </div>
      )}

      {local.length > 0 && (
        <div>
          <p className="text-xs text-gray-600 uppercase tracking-widest px-1 mt-3 mb-1">Local</p>
          {local.map((f) => <FeatureButton key={f.id} f={f} />)}
        </div>
      )}

      {hasClosed && (
        <button
          onClick={() => setShowClosed((v) => !v)}
          className="text-xs text-gray-600 hover:text-gray-400 transition-colors w-full text-left px-1 mt-2"
        >
          {showClosed ? 'Hide closed' : 'Show closed'}
        </button>
      )}
    </div>
  );
}

/**
 * Usage tab: cost, tokens and cache effectiveness of every Claude API call,
 * read from the backend's llm_calls log.
 */

import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { agentSlug, fetchUsageSummary, type UsageKind, type UsageSummary } from '../api/client';

const AGENT_HEX: Record<string, string> = {
  Narrator: '#c084fc',
  Architect: '#60a5fa',
  'UX/UI': '#34d399',
  Analyst: '#f97316',
};
const AGENT_ORDER = ['Narrator', 'Architect', 'UX/UI', 'Analyst'];
const OTHER_HEX = '#6b7280';

const RANGES: { label: string; value: number | 'all' }[] = [
  { label: '7 days', value: 7 },
  { label: '30 days', value: 30 },
  { label: 'All', value: 'all' },
];

const KIND_LABELS: Record<UsageKind, string> = {
  chat: 'Chat replies',
  roundtable_turn: 'Roundtable turns',
  roundtable_summary: 'Roundtable summaries',
  title: 'Chat titles',
  chat_summary: 'Chat summaries',
};

export function formatUsd(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(Math.round(n));
}

function pct(n: number | null | undefined): string {
  return n == null ? '—' : `${Math.round(n * 100)}%`;
}

function Tile({ label, value, sub, children }: { label: string; value: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface-100 px-4 py-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-2xl font-medium text-gray-100 mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-[11px] mt-0.5">{sub}</div>}
      {children}
    </div>
  );
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Stacked daily cost by agent, hand-drawn SVG with a hover tooltip. */
function DailyChart({ data, days }: { data: UsageSummary; days: number | 'all' }) {
  const [hover, setHover] = useState<number | null>(null);

  const series = useMemo(() => {
    const byDay = new Map<string, Map<string, number>>();
    for (const row of data.daily) {
      const name = row.agentName && AGENT_HEX[row.agentName] ? row.agentName : 'Other';
      const m = byDay.get(row.day) ?? new Map<string, number>();
      m.set(name, (m.get(name) ?? 0) + (row.cost ?? 0));
      byDay.set(row.day, m);
    }
    // Continuous day axis so quiet days show as gaps.
    const end = new Date();
    const firstLogged = data.daily[0]?.day;
    const span = days === 'all'
      ? Math.max(1, firstLogged ? Math.ceil((end.getTime() - new Date(firstLogged).getTime()) / 86_400_000) + 1 : 7)
      : days;
    const out: { day: string; parts: { name: string; cost: number }[]; total: number }[] = [];
    for (let i = span - 1; i >= 0; i--) {
      const d = new Date(end);
      d.setDate(d.getDate() - i);
      const key = localDay(d);
      const m = byDay.get(key);
      const parts = [...AGENT_ORDER, 'Other']
        .map((name) => ({ name, cost: m?.get(name) ?? 0 }))
        .filter((p) => p.cost > 0);
      out.push({ day: key, parts, total: parts.reduce((a, p) => a + p.cost, 0) });
    }
    return out;
  }, [data, days]);

  const W = 560;
  const H = 170;
  const left = 40;
  const bottom = 22;
  const plotH = H - bottom - 8;
  const max = Math.max(...series.map((s) => s.total), 0.01);
  const niceMax = (() => {
    const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100];
    return steps.find((s) => s >= max) ?? max;
  })();
  const slot = (W - left) / series.length;
  const barW = Math.min(18, slot * 0.7);
  const y = (v: number) => 8 + plotH - (v / niceMax) * plotH;
  const markerIndex = data.windowedSince ? series.findIndex((s) => s.day === data.windowedSince) : -1;
  const hovered = hover != null ? series[hover] : null;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Daily cost stacked by agent">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={left} x2={W} y1={y(niceMax * f)} y2={y(niceMax * f)} stroke={f === 0 ? '#3a3a52' : '#242433'} />
            <text x={left - 6} y={y(niceMax * f) + 3} fill="#6b6b85" fontSize="10" textAnchor="end">
              {formatUsd(niceMax * f)}
            </text>
          </g>
        ))}
        {series.map((s, i) => {
          let acc = 0;
          const x = left + i * slot + (slot - barW) / 2;
          return (
            <g key={s.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={left + i * slot} y={8} width={slot} height={plotH} fill="transparent" />
              {s.parts.map((p) => {
                const top = y(acc + p.cost);
                const h = y(acc) - top;
                acc += p.cost;
                return (
                  <rect
                    key={p.name}
                    x={x}
                    y={top}
                    width={barW}
                    height={Math.max(h - 1, 1)}
                    rx={2}
                    fill={AGENT_HEX[p.name] ?? OTHER_HEX}
                    opacity={hover == null || hover === i ? 1 : 0.45}
                  />
                );
              })}
            </g>
          );
        })}
        {markerIndex >= 0 && (
          <g>
            <line
              x1={left + markerIndex * slot + 1}
              x2={left + markerIndex * slot + 1}
              y1={4}
              y2={8 + plotH}
              stroke="#7c6af7"
              strokeDasharray="3 3"
            />
            <text x={left + markerIndex * slot + 5} y={14} fill="#9b8df9" fontSize="10">
              windowing on
            </text>
          </g>
        )}
        <text x={left} y={H - 6} fill="#6b6b85" fontSize="10">{series[0]?.day.slice(5)}</text>
        <text x={W} y={H - 6} fill="#6b6b85" fontSize="10" textAnchor="end">{series[series.length - 1]?.day.slice(5)}</text>
      </svg>
      {hovered && (
        <div className="absolute top-0 right-0 rounded border border-border bg-surface-200 px-3 py-2 text-xs pointer-events-none">
          <div className="text-gray-300 mb-1">{hovered.day} · {formatUsd(hovered.total)}</div>
          {hovered.parts.length === 0 && <div className="text-gray-500">No calls</div>}
          {hovered.parts.map((p) => (
            <div key={p.name} className="flex items-center gap-2 text-gray-400">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: AGENT_HEX[p.name] ?? OTHER_HEX }} />
              <span>{p.name}</span>
              <span className="ml-auto tabular-nums text-gray-300">{formatUsd(p.cost)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function UsagePage() {
  const [range, setRange] = useState<number | 'all'>(30);
  const [kind, setKind] = useState<UsageKind | null>(null);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchUsageSummary(range, kind)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load usage'));
    return () => {
      cancelled = true;
    };
  }, [range, kind]);

  const t = data?.totals;
  const prevCost = data?.previous?.cost;
  const delta = t && prevCost ? (t.cost - prevCost) / prevCost : null;
  const windowed = data?.perMessage.find((p) => p.strategy === 'windowed');
  const full = data?.perMessage.find((p) => p.strategy === 'full');
  const chatReplies = (windowed?.calls ?? 0) + (full?.calls ?? 0);
  const avgPerReply = chatReplies
    ? ((windowed?.avg_cost ?? 0) * (windowed?.calls ?? 0) + (full?.avg_cost ?? 0) * (full?.calls ?? 0)) / chatReplies
    : null;
  const maxModelCost = Math.max(...(data?.byModel.map((m) => m.cost ?? 0) ?? [0]), 0.0001);
  const helperCost = data?.byKind
    .filter((k) => k.kind === 'title' || k.kind === 'chat_summary')
    .reduce((a, k) => a + (k.cost ?? 0), 0);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto px-8 py-6">
        <div className="flex items-center gap-3 mb-5">
          <h1 className="text-xl font-medium text-gray-100">Usage</h1>
          <span className="text-xs text-gray-500">Every Claude API call, with cost at the price when it ran</span>
          <div className="ml-auto flex">
            {RANGES.map((r, i) => (
              <button
                key={r.label}
                onClick={() => setRange(r.value)}
                className={`text-xs px-3 py-1.5 border border-border transition-colors ${
                  i === 0 ? 'rounded-l' : ''
                } ${i === RANGES.length - 1 ? 'rounded-r' : ''} ${i > 0 ? '-ml-px' : ''} ${
                  range === r.value ? 'bg-surface-200 text-gray-100' : 'text-gray-500 hover:text-gray-300'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <select
            value={kind ?? ''}
            onChange={(e) => setKind((e.target.value || null) as UsageKind | null)}
            className="text-xs bg-surface-100 border border-border rounded px-2 py-1.5 text-gray-300"
            aria-label="Filter by call kind"
          >
            <option value="">All calls</option>
            {(Object.keys(KIND_LABELS) as UsageKind[]).map((k) => (
              <option key={k} value={k}>{KIND_LABELS[k]}</option>
            ))}
          </select>
        </div>

        {error && <p className="text-sm text-red-400 mb-4">{error}</p>}
        {!data && !error && <p className="text-sm text-gray-600">Loading…</p>}

        {data && t && (
          <>
            {t.calls === 0 && (
              <p className="text-sm text-gray-500 mb-4">
                No calls logged in this range yet. Send a chat message and it shows up here.
              </p>
            )}

            <div className="grid grid-cols-4 gap-3 mb-3">
              <Tile
                label="Total cost"
                value={formatUsd(t.cost)}
                sub={
                  delta != null ? (
                    <span className={delta <= 0 ? 'text-emerald-400' : 'text-orange-400'}>
                      {delta <= 0 ? '' : '+'}{Math.round(delta * 100)}% vs previous {range} days
                    </span>
                  ) : (
                    <span className="text-gray-500">{t.calls} calls</span>
                  )
                }
              />
              <Tile
                label="Avg cost per chat reply"
                value={formatUsd(avgPerReply)}
                sub={
                  windowed && full ? (
                    <span className="text-gray-500">
                      windowed {formatUsd(windowed.avg_cost)} · full {formatUsd(full.avg_cost)}
                    </span>
                  ) : (
                    <span className="text-gray-500">{chatReplies} replies</span>
                  )
                }
              />
              <Tile label="Cache hit rate" value={pct(t.cacheHitRate)}>
                <div className="h-1.5 bg-surface-300 rounded mt-2">
                  <div className="h-1.5 bg-accent rounded" style={{ width: `${Math.round((t.cacheHitRate ?? 0) * 100)}%` }} />
                </div>
              </Tile>
              <Tile
                label="Tokens (in / out)"
                value={`${formatTokens(t.inputTokens)} / ${formatTokens(t.outputTokens)}`}
                sub={<span className="text-gray-500">{formatTokens(t.cacheReadTokens)} read from cache</span>}
              />
            </div>

            <div className="grid grid-cols-[1.7fr_1fr] gap-3 mb-3">
              <div className="rounded-lg border border-border bg-surface-100 px-4 py-3">
                <div className="flex items-center mb-2">
                  <span className="text-sm font-medium text-gray-200">Cost per day</span>
                  <div className="ml-auto flex gap-3 text-[11px] text-gray-500">
                    {[...AGENT_ORDER, 'Other'].map((name) => (
                      <span key={name} className="flex items-center gap-1.5">
                        <span className="inline-block w-2 h-2 rounded-sm" style={{ background: AGENT_HEX[name] ?? OTHER_HEX }} />
                        {name}
                      </span>
                    ))}
                  </div>
                </div>
                <DailyChart data={data} days={range} />
              </div>

              <div className="rounded-lg border border-border bg-surface-100 px-4 py-3">
                <div className="text-sm font-medium text-gray-200 mb-3">By model</div>
                <div className="flex flex-col gap-3 text-xs">
                  {data.byModel.length === 0 && <span className="text-gray-600">No calls</span>}
                  {data.byModel.map((m) => (
                    <div key={m.model}>
                      <div className="flex text-gray-300">
                        <span>{m.model.replace(/^claude-/, '')}</span>
                        <span className="ml-auto tabular-nums">{formatUsd(m.cost)}</span>
                      </div>
                      <div className="h-1.5 bg-surface-300 rounded mt-1">
                        <div className="h-1.5 bg-accent rounded" style={{ width: `${((m.cost ?? 0) / maxModelCost) * 100}%` }} />
                      </div>
                      <div className="text-[11px] text-gray-600 mt-0.5">{m.calls} calls</div>
                    </div>
                  ))}
                </div>
                {helperCost != null && helperCost > 0 && (
                  <div className="border-t border-border mt-3 pt-2 text-[11px] text-gray-500">
                    Titles and summaries: {formatUsd(helperCost)}
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-lg border border-border bg-surface-100 px-4 py-3">
              <div className="text-sm font-medium text-gray-200 mb-1">Most expensive chats</div>
              <table className="w-full text-xs table-fixed">
                <colgroup>
                  <col className="w-[44%]" />
                  <col className="w-[11%]" />
                  <col className="w-[17%]" />
                  <col className="w-[12%]" />
                  <col className="w-[16%]" />
                </colgroup>
                <thead>
                  <tr className="text-gray-500">
                    <th className="text-left font-normal py-1.5">Chat</th>
                    <th className="text-right font-normal">Replies</th>
                    <th className="text-right font-normal">Avg input/reply</th>
                    <th className="text-right font-normal">Cached</th>
                    <th className="text-right font-normal">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topChats.map((c) => (
                    <tr
                      key={`c${c.id}`}
                      onClick={() => navigate(`/chat/${agentSlug(c.agentName)}/${c.slug}`)}
                      className="border-t border-border text-gray-300 cursor-pointer hover:bg-surface-200"
                    >
                      <td className="py-2 truncate">
                        <span className="inline-block w-2 h-2 rounded-sm mr-2" style={{ background: AGENT_HEX[c.agentName] ?? OTHER_HEX }} />
                        {c.title}
                        <span className="text-gray-600"> · {c.agentName}</span>
                      </td>
                      <td className="text-right tabular-nums">{c.replies}</td>
                      <td className="text-right tabular-nums">{formatTokens(c.avgInput)}</td>
                      <td className="text-right tabular-nums">{pct(c.cacheRate)}</td>
                      <td className="text-right tabular-nums">{formatUsd(c.cost)}</td>
                    </tr>
                  ))}
                  {data.topRoundtables.map((r) => (
                    <tr
                      key={`r${r.id}`}
                      onClick={() => navigate('/roundtable')}
                      className="border-t border-border text-gray-300 cursor-pointer hover:bg-surface-200"
                    >
                      <td className="py-2 truncate">
                        <span className="inline-block w-2 h-2 rounded-sm mr-2" style={{ background: OTHER_HEX }} />
                        Roundtable: {r.topic}
                      </td>
                      <td className="text-right tabular-nums">{r.calls}</td>
                      <td className="text-right text-gray-600">—</td>
                      <td className="text-right tabular-nums">{pct(r.cacheRate)}</td>
                      <td className="text-right tabular-nums">{formatUsd(r.cost)}</td>
                    </tr>
                  ))}
                  {data.topChats.length === 0 && data.topRoundtables.length === 0 && (
                    <tr className="border-t border-border">
                      <td colSpan={5} className="py-3 text-gray-600">No chats in this range</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

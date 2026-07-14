import { useEffect, useState } from 'react';
import { api, type Distributions, type StatRow, type SummaryData } from './api';

const pct = (v: number | null | undefined, digits = 2) => (v == null ? '—' : `${(v * 100).toFixed(digits)}%`);
const TIER_NAMES: Record<string, string> = { peng: '碰', gang: '杠', hu: '胡了', zimo: '自摸', tianhu: '天胡' };
const TIER_ORDER = ['peng', 'gang', 'hu', 'zimo', 'tianhu'];

/** 实测 vs 理论 RTP 折线（纯 SVG，无图表库） */
function RtpChart({ rows, theoretical }: { rows: StatRow[]; theoretical: number | null }) {
  const pts = rows.filter((r) => r.rtp != null);
  if (pts.length === 0) return <p className="empty">该维度还没有可绘制的 RTP 数据。</p>;
  const W = 640, H = 200, PL = 50, PR = 14, PT = 14, PB = 26;
  const values = pts.map((r) => r.rtp as number).concat(theoretical != null ? [theoretical] : []);
  let min = Math.min(...values), max = Math.max(...values);
  const pad = Math.max((max - min) * 0.15, 0.02);
  min -= pad; max += pad;
  const x = (i: number) => (pts.length === 1 ? PL + (W - PL - PR) / 2 : PL + (i * (W - PL - PR)) / (pts.length - 1));
  const y = (v: number) => PT + (H - PT - PB) * (1 - (v - min) / (max - min));
  const line = pts.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(r.rtp as number).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="RTP 曲线">
      {[min, (min + max) / 2, max].map((v, i) => (
        <g key={i}>
          <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} stroke="#E4DECB" strokeWidth="1" />
          <text x={PL - 6} y={y(v) + 4} textAnchor="end" fontSize="10" fill="#8A867C">{pct(v, 1)}</text>
        </g>
      ))}
      {theoretical != null && (
        <g>
          <line x1={PL} x2={W - PR} y1={y(theoretical)} y2={y(theoretical)} stroke="#C9A45C" strokeDasharray="5 4" strokeWidth="1.5" />
          <text x={W - PR} y={y(theoretical) - 5} textAnchor="end" fontSize="10" fill="#9A7B3F">理论 {pct(theoretical, 1)}</text>
        </g>
      )}
      <path d={line} fill="none" stroke="#26523F" strokeWidth="2" />
      {pts.map((r, i) => (
        <g key={r.key}>
          <circle cx={x(i)} cy={y(r.rtp as number)} r="3.5" fill="#1B3B2F" />
          <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill="#8A867C">
            {r.key.length > 5 ? r.key.slice(5) : r.key}
          </text>
        </g>
      ))}
    </svg>
  );
}

function BarList({ items }: { items: Array<{ label: string; count: number; extra?: string }> }) {
  if (items.length === 0) return <p className="empty">暂无数据。</p>;
  const max = Math.max(...items.map((i) => i.count));
  return (
    <div className="bars">
      {items.map((it) => (
        <div className="bar-row" key={it.label}>
          <span className="bar-label">{it.label}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${max ? (it.count / max) * 100 : 0}%` }} /></div>
          <span className="bar-count">{it.count.toLocaleString()}{it.extra ? ` · ${it.extra}` : ''}</span>
        </div>
      ))}
    </div>
  );
}

export function DashboardPage() {
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [rows, setRows] = useState<StatRow[] | null>(null);
  const [dist, setDist] = useState<Distributions | null>(null);
  const [groupBy, setGroupBy] = useState<'day' | 'configVersion'>('day');
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const [s, d] = await Promise.all([
          api<SummaryData>('/api/admin/stats/summary'),
          api<Distributions>('/api/admin/stats/distributions'),
        ]);
        setSummary(s);
        setDist(d);
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);

  useEffect(() => {
    setRows(null);
    void api<{ rows: StatRow[] }>(`/api/admin/stats?groupBy=${groupBy}`)
      .then((d) => setRows([...d.rows].reverse()))   // 服务端倒序 → 图表要正序
      .catch((e) => setError((e as Error).message));
  }, [groupBy]);

  const noData = summary !== null && summary.today.spins === 0 && (rows?.length ?? 0) === 0;

  return (
    <div>
      <h2>数据看板 <span className="hint">全部数字可与 spins 表逐条对账</span></h2>
      {error && <p className="error-line">⚠ {error}</p>}

      {summary && (
        <div className="cards">
          <div className="card">
            <div className="num">{summary.today.spins.toLocaleString()}</div>
            <div className="sub">今日 Spin · 下注 {summary.today.totalBet.toLocaleString()} 文</div>
          </div>
          <div className="card">
            <div className={`num ${summary.today.rtp != null && summary.today.rtp > 1 ? 'bad' : ''}`}>{pct(summary.today.rtp)}</div>
            <div className="sub">今日实测 RTP · 理论 {pct(summary.theoreticalRtp)}（v{summary.publishedVersion}）</div>
          </div>
          <div className="card">
            <div className="num">{summary.today.uniquePlayers}</div>
            <div className="sub">今日活跃玩家 · 累计 {summary.totalPlayers}</div>
          </div>
          <div className="card">
            <div className="num">{summary.today.bigWins}</div>
            <div className="sub">今日大奖（≥50×）</div>
          </div>
        </div>
      )}

      {noData ? (
        <p className="empty">还没有任何 spin 数据——去游戏端转两把，看板马上有内容。</p>
      ) : (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>实测 vs 理论 RTP</h3>
              <div className="tabs">
                <button className={groupBy === 'day' ? 'primary' : ''} onClick={() => setGroupBy('day')}>按日</button>
                <button className={groupBy === 'configVersion' ? 'primary' : ''} onClick={() => setGroupBy('configVersion')}>按配置版本</button>
              </div>
            </div>
            {rows === null ? <p>加载中…</p> : <RtpChart rows={rows} theoretical={summary?.theoreticalRtp ?? null} />}
          </div>

          {dist && (
            <div className="panel-grid">
              <div className="panel">
                <h3>五档赢奖分布</h3>
                <BarList items={TIER_ORDER
                  .map((t) => ({ t, row: dist.winTiers.find((w) => w.tier === t) }))
                  .filter((x) => x.row)
                  .map(({ t, row }) => ({ label: TIER_NAMES[t]!, count: row!.count, extra: `${row!.totalWin.toLocaleString()} 文` }))} />
              </div>
              <div className="panel">
                <h3>注档分布</h3>
                <BarList items={dist.betLevels.map((b) => ({ label: `${b.bet} 文`, count: b.count }))} />
              </div>
              <div className="panel">
                <h3>连锁深度分布</h3>
                <BarList items={dist.cascadeDepth.map((c) => ({ label: `${c.depth} 连`, count: c.count }))} />
              </div>
              <div className="panel">
                <h3>免费旋转</h3>
                <p className="big-stat">{dist.fsTriggerRate > 0 ? `1 / ${Math.round(1 / dist.fsTriggerRate)}` : '未触发'}</p>
                <p className="sub">基础局触发率（目标 ~1/200）</p>
              </div>
            </div>
          )}

          {rows !== null && rows.length > 0 && (
            <div className="panel">
              <h3>明细（{groupBy === 'day' ? '按日' : '按配置版本'}）</h3>
              <table>
                <thead>
                  <tr><th>{groupBy === 'day' ? '日期' : '版本'}</th><th>Spin 数</th><th>总下注</th><th>总赢奖</th><th>实测 RTP</th><th>命中率</th><th>免费旋转触发</th><th>玩家数</th></tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((r) => (
                    <tr key={r.key}>
                      <td>{r.key}</td>
                      <td>{r.spins}</td>
                      <td>{r.totalBet?.toLocaleString()}</td>
                      <td>{r.totalWin?.toLocaleString()}</td>
                      <td className={r.rtp != null && r.rtp > 1 ? 'bad' : ''}>{pct(r.rtp)}</td>
                      <td>{pct(r.hitRate)}</td>
                      <td>{r.fsTriggers}</td>
                      <td>{r.uniquePlayers}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

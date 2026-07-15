import { useCallback, useEffect, useState } from 'react';
import { api, type CascadeStep, type SpinDetail, type SpinRow } from './api';
import { useHashRoute } from './router';

const PAGE_SIZE = 20;
const TIER_NAMES: Record<string, string> = { peng: '碰', gang: '杠', hu: '胡了', zimo: '自摸', tianhu: '天胡' };
// 牌面字与用色（对齐 CT-4：朱砂=中/萬，竹绿=發/條，墨=其余）
const SYMBOLS: Record<string, { text: string; cls: string }> = {
  zhong: { text: '中', cls: 'red' }, fa: { text: '發', cls: 'green' },
  east: { text: '東', cls: 'ink' }, south: { text: '南', cls: 'ink' },
  west: { text: '西', cls: 'ink' }, north: { text: '北', cls: 'ink' },
  wan: { text: '萬', cls: 'red' }, tong: { text: '筒', cls: 'ink' }, tiao: { text: '條', cls: 'green' },
  wild: { text: '白', cls: 'wild' }, scatter: { text: '骰', cls: 'scatter' }, gold: { text: '金', cls: 'gold' },
};

function Board({ step }: { step: CascadeStep }) {
  const grid = step.gridBefore;
  const removed = new Set(step.removedPositions.map((p) => `${p.col},${p.row}`));
  const rows = grid[0]?.length ?? 0;
  return (
    <div className="board" style={{ gridTemplateColumns: `repeat(${grid.length}, 1fr)` }}>
      {Array.from({ length: rows }, (_, row) =>
        grid.map((col, c) => {
          const cell = col[row]!;
          const s = SYMBOLS[cell.symbol] ?? { text: '?', cls: 'ink' };
          return (
            <div key={`${c},${row}`} className={`tile ${s.cls} ${removed.has(`${c},${row}`) ? 'hl' : ''}`}>
              {s.text}
              {cell.goldMultiplier ? <small>×{cell.goldMultiplier}</small> : null}
            </div>
          );
        }),
      )}
    </div>
  );
}

function DetailView({ id, onClose }: { id: number; onClose: () => void }) {
  const [detail, setDetail] = useState<SpinDetail | null>(null);
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    setDetail(null); setStep(0);
    void api<SpinDetail>(`/api/admin/spins/${id}`).then(setDetail).catch((e) => setError((e as Error).message));
  }, [id]);

  if (error) return <p className="error-line">⚠ {error}</p>;
  if (!detail) return <p>加载中…</p>;
  const { spin, result, replayCheck } = detail;
  const cur = result.cascades[step]!;
  return (
    <div className="panel detail">
      <div className="panel-head">
        <h3>
          Spin #{spin.id}
          <span className={`badge ${replayCheck.match ? 'published' : 'mismatch'}`}>
            {replayCheck.match ? '✓ 回放与落库一致' : '✗ 回放不一致——数据可能被篡改'}
          </span>
        </h3>
        <button onClick={onClose}>关闭</button>
      </div>
      <p className="sub">
        玩家 #{spin.playerId} · v{spin.configVersion} · {spin.mode === 'free' ? '免费旋转' : '基础局'} ·
        注 {spin.bet} · 扣款 {spin.totalCost} · 赢 {spin.totalWin}（{spin.winX.toFixed(2)}×）
        {result.winTier ? ` · ${TIER_NAMES[result.winTier] ?? result.winTier}` : ''} ·
        骰子 {result.scatterCount} · seed <code>{spin.seed}</code>
      </p>
      <div className="replay-row">
        <Board step={cur} />
        <div className="replay-side">
          <p className="big-stat">×{cur.chainMultiplier}</p>
          <p className="sub">连锁 {step + 1} / {result.cascades.length}</p>
          <p>本步赢 <b>{cur.stepWin.toLocaleString()}</b> 文</p>
          {cur.wins.length > 0 ? (
            <ul className="win-list">
              {cur.wins.map((w, i) => (
                <li key={i}>{SYMBOLS[w.symbol]?.text ?? w.symbol} ×{w.count} → {w.basePayout.toLocaleString()} 文</li>
              ))}
            </ul>
          ) : <p className="sub">无中奖（终局盘面）</p>}
          <div className="tabs">
            <button disabled={step === 0} onClick={() => setStep(step - 1)}>← 上一步</button>
            <button disabled={step >= result.cascades.length - 1} onClick={() => setStep(step + 1)}>下一步 →</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AuditPage() {
  const route = useHashRoute();
  const [playerId, setPlayerId] = useState(route.params.get('playerId') ?? '');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [minWinX, setMinWinX] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ spins: SpinRow[]; total: number } | null>(null);
  // #/audit?spinId=N 直达单局回放（玩家流水的 ref_spin 跳转用）
  const [detailId, setDetailId] = useState<number | null>(
    route.params.get('spinId') ? Number(route.params.get('spinId')) : null,
  );
  const [error, setError] = useState('');

  const load = useCallback(async (goPage: number) => {
    const q = new URLSearchParams();
    if (playerId.trim()) q.set('playerId', playerId.trim());
    if (from) q.set('from', from);
    if (to) {
      const next = new Date(`${to}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      q.set('to', next.toISOString().slice(0, 10));
    }
    if (minWinX.trim()) q.set('minWinX', minWinX.trim());
    q.set('page', String(goPage));
    try {
      setData(await api<{ spins: SpinRow[]; total: number }>(`/api/admin/spins?${q}`));
      setPage(goPage);
      setError('');
    } catch (e) { setError((e as Error).message); }
  }, [playerId, from, to, minWinX]);

  useEffect(() => { void load(1); /* 初次与筛选变化都从第 1 页起 */ }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  return (
    <div>
      <h2>审计回放 <span className="hint">任意一局都可用 engine 重放核验</span></h2>
      {error && <p className="error-line">⚠ {error}</p>}

      <div className="actions-row filters">
        <input placeholder="玩家 ID" value={playerId} onChange={(e) => setPlayerId(e.target.value)} style={{ width: 90 }} />
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        <span className="sub">至</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <input placeholder="最小倍数（如 5）" value={minWinX} onChange={(e) => setMinWinX(e.target.value)} style={{ width: 130 }} />
        <button className="primary" onClick={() => void load(1)}>查询</button>
      </div>

      {detailId !== null && <DetailView id={detailId} onClose={() => setDetailId(null)} />}

      {data === null ? <p>加载中…</p> : data.spins.length === 0 ? (
        <p className="empty">没有符合条件的 spin 记录。</p>
      ) : (
        <>
          <table>
            <thead>
              <tr><th>ID</th><th>玩家</th><th>时间</th><th>模式</th><th>配置</th><th>注</th><th>赢奖</th><th>倍数</th><th>档位</th><th>连锁</th><th></th></tr>
            </thead>
            <tbody>
              {data.spins.map((s) => (
                <tr key={s.id} className={detailId === s.id ? 'row-active' : ''}>
                  <td>#{s.id}</td>
                  <td>#{s.playerId}</td>
                  <td>{s.createdAt.slice(5, 19).replace('T', ' ')}</td>
                  <td>{s.mode === 'free' ? '免费' : '基础'}</td>
                  <td>v{s.configVersion}</td>
                  <td>{s.bet}</td>
                  <td>{s.totalWin.toLocaleString()}</td>
                  <td className={s.winX >= 50 ? 'bad' : ''}>{s.winX.toFixed(2)}×</td>
                  <td>{s.winTier ? TIER_NAMES[s.winTier] ?? s.winTier : '—'}</td>
                  <td>{s.cascades}</td>
                  <td className="td-ops"><button onClick={() => setDetailId(s.id)}>回放</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <button disabled={page <= 1} onClick={() => void load(page - 1)}>← 上一页</button>
            <span className="sub">{page} / {pages} 页 · 共 {data.total} 条</span>
            <button disabled={page >= pages} onClick={() => void load(page + 1)}>下一页 →</button>
          </div>
        </>
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

interface StatRow {
  key: string; spins: number; totalBet: number; totalWin: number;
  rtp: number | null; hitRate: number; fsTriggers: number; uniquePlayers: number;
}

export function DashboardPage() {
  const [rows, setRows] = useState<StatRow[] | null>(null);
  const load = useCallback(async () => {
    const data = await api<{ rows: StatRow[] }>('/api/admin/stats');
    setRows(data.rows);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);
  return (
    <div>
      <h2>数据看板 <span className="hint">按日聚合</span></h2>
      {rows === null ? <p>加载中…</p> : rows.length === 0 ? (
        <p className="empty">还没有任何 spin 数据——去游戏端转两把再回来。</p>
      ) : (
        <table>
          <thead>
            <tr><th>日期</th><th>Spin 数</th><th>总下注</th><th>总赢奖</th><th>实测 RTP</th><th>命中率</th><th>免费旋转触发</th><th>玩家数</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
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
      )}
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { api, type PlayerAdminRow } from './api';
import { navigate } from './router';

const PAGE_SIZE = 20;
/** 测试用一键补币额度：按最大注 500 算够打 2000 局，不用反复回后台 */
const QUICK_TOPUP = 1_000_000;
const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);

export function PlayersPage() {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ players: PlayerAdminRow[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (goPage: number, q = query) => {
    const qs = new URLSearchParams({ page: String(goPage) });
    if (q.trim()) qs.set('query', q.trim());
    try {
      setData(await api<{ players: PlayerAdminRow[]; total: number }>(`/api/admin/players?${qs}`));
      setPage(goPage);
      setError('');
    } catch (e) { setError((e as Error).message); }
  }, [query]);

  useEffect(() => { void load(1); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try { await fn(); await load(page); } catch (e) { setError(`${label}失败：${(e as Error).message}`); } finally { setBusy(false); }
  };

  const credit = (p: PlayerAdminRow) => {
    const input = window.prompt(`给玩家 #${p.id} 补币，输入金额（文，正整数）：`);
    if (input == null) return;
    const amount = Number(input);
    if (!Number.isInteger(amount) || amount <= 0) { setError('金额须为正整数'); return; }
    const note = window.prompt('备注（可空）：') ?? undefined;
    void act('补币', () => api(`/api/admin/players/${p.id}/credit`, { method: 'POST', body: { amount, note } }));
  };

  /** 测试时余额打空了，一次点击就能接着玩——不必手输金额与备注 */
  const quickCredit = (p: PlayerAdminRow) => {
    if (!window.confirm(`给玩家 #${p.id} 补 100 万文（1,000,000）？测试用，走 admin_credit 流水，不计入赢奖。`)) return;
    void act('补币', () => api(`/api/admin/players/${p.id}/credit`, {
      method: 'POST',
      body: { amount: QUICK_TOPUP, note: '测试补币' },
    }));
  };

  const reset = (p: PlayerAdminRow) => {
    if (!window.confirm(`重置玩家 #${p.id}？余额回 10,000，免费旋转与保底进度清零。`)) return;
    void act('重置', () => api(`/api/admin/players/${p.id}/reset`, { method: 'POST' }));
  };

  const toggleBan = (p: PlayerAdminRow) => {
    const action = p.status === 'banned' ? 'unban' : 'ban';
    const label = action === 'ban' ? '封禁' : '解封';
    if (!window.confirm(`${label}玩家 #${p.id}？${action === 'ban' ? '封禁后其 spin 请求将被拒绝。' : ''}`)) return;
    void act(label, () => api(`/api/admin/players/${p.id}/${action}`, { method: 'POST' }));
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  return (
    <div>
      <h2>玩家管理 <span className="hint">「补 100 万」是测试用一键补币；补币/重置全走流水，封禁进操作日志</span></h2>
      {error && <p className="error-line">⚠ {error}</p>}

      <div className="actions-row filters">
        <input placeholder="玩家 ID 或 token 前缀" value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void load(1)} style={{ width: 220 }} />
        <button className="primary" onClick={() => void load(1)}>搜索</button>
      </div>

      {data === null ? <p>加载中…</p> : data.players.length === 0 ? (
        <p className="empty">没有找到玩家。</p>
      ) : (
        <>
          <table>
            <thead>
              <tr><th>ID</th><th>状态</th><th>余额</th><th>Spin 数</th><th>总投入</th><th>总赢奖</th><th>实测 RTP</th><th>最后活跃</th><th>操作</th></tr>
            </thead>
            <tbody>
              {data.players.map((p) => (
                <tr key={p.id}>
                  <td>#{p.id}</td>
                  <td><span className={`badge ${p.status === 'banned' ? 'mismatch' : 'published'}`}>{p.status === 'banned' ? '已封禁' : '正常'}</span></td>
                  <td>{p.balance.toLocaleString()}</td>
                  <td>{p.spins}</td>
                  <td>{p.totalBet.toLocaleString()}</td>
                  <td>{p.totalWin.toLocaleString()}</td>
                  <td>{pct(p.totalBet > 0 ? p.totalWin / p.totalBet : null)}</td>
                  <td>{p.lastSeenAt ? p.lastSeenAt.slice(5, 16).replace('T', ' ') : '—'}</td>
                  <td className="td-ops">
                    <button disabled={busy} className="primary" onClick={() => quickCredit(p)}>补 100 万</button>
                    <button disabled={busy} onClick={() => credit(p)}>补币…</button>
                    <button disabled={busy} onClick={() => reset(p)}>重置</button>
                    <button disabled={busy} className={p.status === 'banned' ? '' : 'danger'} onClick={() => toggleBan(p)}>
                      {p.status === 'banned' ? '解封' : '封禁'}
                    </button>
                    <button onClick={() => navigate('audit', { playerId: String(p.id) })}>查 spin</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pager">
            <button disabled={page <= 1} onClick={() => void load(page - 1)}>← 上一页</button>
            <span className="sub">{page} / {pages} 页 · 共 {data.total} 人</span>
            <button disabled={page >= pages} onClick={() => void load(page + 1)}>下一页 →</button>
          </div>
        </>
      )}
    </div>
  );
}

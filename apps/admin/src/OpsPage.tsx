import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

interface AdminOpRow { id: number; action: string; detail: string | null; createdAt: string }

const PAGE_SIZE = 50;
const ACTION_NAMES: Record<string, string> = {
  login: '登录', config_publish: '发布配置', config_rollback: '回滚配置',
  player_credit: '补币', player_reset: '重置玩家', player_ban: '封禁', player_unban: '解封',
  economy_update: '改经济参数', health_check: '对账自检',
};

function DetailCell({ detail }: { detail: string | null }) {
  if (!detail || detail === '{}') return <span className="sub">—</span>;
  try {
    const obj = JSON.parse(detail) as Record<string, unknown>;
    return (
      <span className="op-detail">
        {Object.entries(obj).map(([k, v]) => (
          <span key={k}><b>{k}</b>={typeof v === 'object' ? JSON.stringify(v) : String(v)} </span>
        ))}
      </span>
    );
  } catch {
    return <span>{detail}</span>;
  }
}

export function OpsPage() {
  const [type, setType] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ ops: AdminOpRow[]; total: number } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async (goPage: number, t = type) => {
    const qs = new URLSearchParams({ page: String(goPage) });
    if (t) qs.set('type', t);
    try {
      setData(await api<{ ops: AdminOpRow[]; total: number }>(`/api/admin/ops?${qs}`));
      setPage(goPage);
      setError('');
    } catch (e) { setError((e as Error).message); }
  }, [type]);

  useEffect(() => { void load(1); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;
  return (
    <div>
      <h2>操作日志 <span className="hint">只读 · 所有管理动作自动留痕</span></h2>
      {error && <p className="error-line">⚠ {error}</p>}

      <div className="actions-row">
        <select value={type} onChange={(e) => { setType(e.target.value); void load(1, e.target.value); }}>
          <option value="">全部动作</option>
          {Object.entries(ACTION_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {data === null ? <p>加载中…</p> : data.ops.length === 0 ? (
        <p className="empty">暂无记录。</p>
      ) : (
        <>
          <table className="ops-table">
            <thead>
              <tr><th>#</th><th>时间</th><th>动作</th><th>详情</th></tr>
            </thead>
            <tbody>
              {data.ops.map((o) => (
                <tr key={o.id}>
                  <td>{o.id}</td>
                  <td>{o.createdAt.slice(0, 19).replace('T', ' ')}</td>
                  <td className="td-left">{ACTION_NAMES[o.action] ?? o.action}</td>
                  <td className="td-left"><DetailCell detail={o.detail} /></td>
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

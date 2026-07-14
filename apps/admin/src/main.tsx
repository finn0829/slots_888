import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

interface StatRow {
  key: string; spins: number; totalBet: number; totalWin: number;
  rtp: number | null; hitRate: number; fsTriggers: number; uniquePlayers: number;
}

const TOKEN_KEY = 'slots888_admin_token';

function Login({ onLogin }: { onLogin: (token: string) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) { setError('密码错误'); return; }
    const { adminToken } = await res.json();
    sessionStorage.setItem(TOKEN_KEY, adminToken);
    onLogin(adminToken);
  };
  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>雀胡 · 管理后台</h1>
        <input
          type="password" placeholder="管理员密码" value={password}
          onChange={(e) => setPassword(e.target.value)} autoFocus
        />
        <button type="submit">登 录</button>
        {error && <p className="error">{error}</p>}
      </form>
    </div>
  );
}

function Dashboard({ token, onExpired }: { token: string; onExpired: () => void }) {
  const [rows, setRows] = useState<StatRow[] | null>(null);
  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/admin/stats', { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 401) { sessionStorage.removeItem(TOKEN_KEY); onExpired(); return; }
      const data = await res.json();
      setRows(data.rows);
    })();
  }, [token, onExpired]);

  const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);
  return (
    <div className="layout">
      <aside>
        <div className="brand">雀 · 胡</div>
        <nav>
          <a className="active">📊 数据看板</a>
          <a className="todo">⚙️ 配置管理（M5）</a>
          <a className="todo">👥 玩家管理（M5）</a>
          <a className="todo">🔍 审计回放（M5）</a>
        </nav>
      </aside>
      <main>
        <h2>数据看板 <span className="hint">按日聚合 · 理论 RTP 95.58%（配置 v1）</span></h2>
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
      </main>
    </div>
  );
}

function App() {
  const [token, setToken] = useState<string | null>(sessionStorage.getItem(TOKEN_KEY));
  if (!token) return <Login onLogin={setToken} />;
  return <Dashboard token={token} onExpired={() => setToken(null)} />;
}

createRoot(document.getElementById('root')!).render(<App />);

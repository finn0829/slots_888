import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { TOKEN_KEY } from './api';
import { useHashRoute, navigate } from './router';
import { DashboardPage } from './DashboardPage';
import { ConfigsPage } from './ConfigsPage';
import { AuditPage } from './AuditPage';
import { PlayersPage } from './PlayersPage';
import { HealthPage } from './HealthPage';
import { EconomyPage } from './EconomyPage';
import { OpsPage } from './OpsPage';
import './style.css';

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

// 加页面 = 在这里加一行（ADM-6 骨架约定）
const NAV: Array<{ page: string; label: string; component: () => React.ReactElement }> = [
  { page: 'dashboard', label: '📊 数据看板', component: DashboardPage },
  { page: 'configs', label: '⚙️ 配置管理', component: ConfigsPage },
  { page: 'audit', label: '🔍 审计回放', component: AuditPage },
  { page: 'players', label: '👥 玩家管理', component: PlayersPage },
  { page: 'health', label: '🧾 对账自检', component: HealthPage },
  { page: 'economy', label: '💰 经济参数', component: EconomyPage },
  { page: 'ops', label: '📋 操作日志', component: OpsPage },
];

function App() {
  const [token, setToken] = useState<string | null>(sessionStorage.getItem(TOKEN_KEY));
  const route = useHashRoute();
  if (!token) return <Login onLogin={setToken} />;
  const active = NAV.find((n) => n.page === route.page) ?? NAV[0]!;
  const Page = active.component;
  return (
    <div className="layout">
      <aside>
        <div className="brand">雀 · 胡</div>
        <nav>
          {NAV.map((n) => (
            <a key={n.page} className={active.page === n.page ? 'active' : ''} onClick={() => navigate(n.page)}>
              {n.label}
            </a>
          ))}
        </nav>
      </aside>
      <main>
        <Page />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

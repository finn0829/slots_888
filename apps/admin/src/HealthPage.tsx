import { useState } from 'react';
import { api, type HealthReport } from './api';
import { navigate } from './router';

const pct = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);

function StatusBadge({ ok }: { ok: boolean }) {
  return <span className={`badge ${ok ? 'published' : 'mismatch'}`}>{ok ? '✓ 通过' : '✗ 发现问题'}</span>;
}

/** 对账自检（ADM-9）：一键跑全局健康检查，把"可审计"闭环 */
export function HealthPage() {
  const [report, setReport] = useState<HealthReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const { report } = await api<{ report: HealthReport }>('/api/admin/health-check', { method: 'POST', body: {} });
      setReport(report);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const allOk = report != null && report.invariant.ok && report.chain.ok && report.replay.ok;
  return (
    <div>
      <h2>对账自检 <span className="hint">不变量校验 + 流水链 + 抽样回放 + RTP 对照，每次运行记入操作日志</span></h2>
      {error && <p className="error-line">⚠ {error}</p>}

      <div className="actions-row">
        <button className="primary" disabled={busy} onClick={() => void run()}>{busy ? '检查中…' : '运行自检'}</button>
        {report && <span className="sub">运行于 {report.ranAt.slice(0, 19).replace('T', ' ')}（UTC）</span>}
        {allOk && <span className="badge published">✓ 全部账目一致</span>}
      </div>

      {report === null ? (
        !busy && <p className="empty">点击「运行自检」开始全局健康检查。</p>
      ) : (
        <>
          <div className="panel">
            <h3>A · 余额不变量 <StatusBadge ok={report.invariant.ok} /></h3>
            <p className="sub">校验 {report.invariant.checked} 个玩家：余额 == 初始 10,000 + Σ流水金额</p>
            {!report.invariant.ok && (
              <table>
                <thead><tr><th>玩家</th><th>实际余额</th><th>按流水应为</th><th>差额</th></tr></thead>
                <tbody>
                  {report.invariant.violations.map((v) => (
                    <tr key={v.playerId}>
                      <td>#{v.playerId}</td>
                      <td className="bad">{v.balance.toLocaleString()}</td>
                      <td>{v.expected.toLocaleString()}</td>
                      <td className="bad">{(v.balance - v.expected).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h3>B · 流水链衔接 <StatusBadge ok={report.chain.ok} /></h3>
            <p className="sub">校验 {report.chain.checked.toLocaleString()} 笔流水：每笔 balance_after == 上一笔 + amount（能定位断点在哪一笔）</p>
            {!report.chain.ok && (
              <table>
                <thead><tr><th>玩家</th><th>断点流水号</th><th>应为</th><th>实际</th></tr></thead>
                <tbody>
                  {report.chain.violations.map((v) => (
                    <tr key={v.txId}>
                      <td>#{v.playerId}</td>
                      <td>#{v.txId}</td>
                      <td>{v.expected.toLocaleString()}</td>
                      <td className="bad">{v.actual.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h3>C · 抽样回放 <StatusBadge ok={report.replay.ok} /></h3>
            <p className="sub">抽样 {report.replay.sampled} 局（最近 25 + 随机 25），engine 重放后与落库结果逐字节比对</p>
            {!report.replay.ok && (
              <p>
                不一致的 spin：{report.replay.mismatches.map((id) => (
                  <button key={id} className="danger" style={{ marginRight: 6 }}
                    onClick={() => navigate('audit', { spinId: String(id) })}>
                    #{id} 去回放
                  </button>
                ))}
              </p>
            )}
          </div>

          <div className="panel">
            <h3>D · 实测 RTP vs 估算（按配置版本）</h3>
            <table>
              <thead><tr><th>版本</th><th>样本（局）</th><th>实测 RTP</th><th>估算 RTP</th><th>偏差</th></tr></thead>
              <tbody>
                {report.rtp.map((r) => (
                  <tr key={r.version}>
                    <td>v{r.version}</td>
                    <td>{r.spins.toLocaleString()}</td>
                    <td>{pct(r.measured)}</td>
                    <td>{pct(r.estimated)}</td>
                    <td>{r.measured != null && r.estimated != null ? `${((r.measured - r.estimated) * 100).toFixed(2)}pp` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="sub">RTP 直测噪声随样本量变化很大（几千局内 ±几个百分点属正常），偏差判读见看板告警的自适应阈值。</p>
          </div>
        </>
      )}
    </div>
  );
}

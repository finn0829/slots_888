import { useCallback, useEffect, useState } from 'react';
import { api, type ConfigMeta, type EditableConfig, type SimResult } from './api';

const SYMBOL_NAMES: Record<string, string> = {
  zhong: '中', fa: '發', east: '東', south: '南', west: '西', north: '北',
  wan: '萬', tong: '筒', tiao: '條',
};
const PRESETS = [
  { id: 'rtp92', label: 'RTP 92%（狠）' },
  { id: 'rtp945', label: 'RTP 94.5%' },
  { id: 'rtp965', label: 'RTP 96.5%（默认）' },
  { id: 'rtp975', label: 'RTP 97.5%（松）' },
];

const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(2)}%`);

export function ConfigsPage() {
  const [configs, setConfigs] = useState<ConfigMeta[] | null>(null);
  const [preset, setPreset] = useState('rtp965');
  const [editing, setEditing] = useState<{ meta: ConfigMeta; config: EditableConfig } | null>(null);
  const [sim, setSim] = useState<SimResult | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const data = await api<{ configs: ConfigMeta[] }>('/api/admin/configs');
    setConfigs(data.configs);
  }, []);
  useEffect(() => { void load().catch((e) => setError(String(e))); }, [load]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };

  const createDraft = () => run('create', async () => {
    const { meta } = await api<{ meta: ConfigMeta }>('/api/admin/configs', {
      method: 'POST',
      body: { preset, label: `${PRESETS.find((p) => p.id === preset)?.label ?? preset} 草稿` },
    });
    await load();
    await openEditor(meta.version);
  });

  const openEditor = async (version: number) => {
    const data = await api<{ meta: ConfigMeta; config: EditableConfig }>(`/api/admin/configs/${version}`);
    setSim(null);
    setEditing(data);
  };

  const save = () => editing && run('save', async () => {
    await api(`/api/admin/configs/${editing.meta.version}`, { method: 'PUT', body: { config: editing.config } });
    await load();
  });

  const estimate = () => editing && run('sim', async () => {
    await api(`/api/admin/configs/${editing.meta.version}`, { method: 'PUT', body: { config: editing.config } });
    const s = await api<SimResult>('/api/admin/simulate', {
      method: 'POST', body: { version: editing.meta.version, spins: 100_000 },
    });
    setSim(s);
    await load();
  });

  const publish = (version: number) => {
    if (!window.confirm(`发布 v${version}？发布后所有新 spin 立即使用该配置。`)) return;
    void run('publish', async () => {
      await api(`/api/admin/configs/${version}/publish`, { method: 'POST' });
      setEditing(null);
      await load();
    });
  };

  const rollback = (version: number) => {
    if (!window.confirm(`回滚到 v${version}？将复制为新版本并立即发布。`)) return;
    void run('rollback', async () => {
      await api(`/api/admin/configs/${version}/rollback`, { method: 'POST' });
      await load();
    });
  };

  const setSymbol = (key: string, field: 'weight' | 0 | 1 | 2, value: number) => {
    if (!editing) return;
    const config = structuredClone(editing.config);
    if (field === 'weight') config.symbols[key]!.weight = value;
    else config.symbols[key]!.pay[field] = value;
    setEditing({ ...editing, config });
  };
  const setField = (field: 'wildWeight' | 'scatterWeight' | 'goldWeight' | 'payoutScale', value: number) => {
    if (!editing) return;
    setEditing({ ...editing, config: { ...editing.config, [field]: value } });
  };
  const setBonusBuyEnabled = (enabled: boolean) => {
    if (!editing) return;
    const prev = editing.config.bonusBuy ?? { enabled: true, costMultiplier: 0 };
    setEditing({ ...editing, config: { ...editing.config, bonusBuy: { ...prev, enabled } } });
  };

  return (
    <div>
      <h2>配置管理 <span className="hint">RTP 由权重×赔付表决定——改完先估算再发布</span></h2>
      {error && <p className="error-line">⚠ {error}</p>}

      <div className="actions-row">
        <select value={preset} onChange={(e) => setPreset(e.target.value)}>
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.id}（{p.label}）</option>)}
        </select>
        <button onClick={createDraft} disabled={busy !== ''}>＋ 从预设新建草稿</button>
      </div>

      {configs === null ? <p>加载中…</p> : (
        <table>
          <thead>
            <tr><th>版本</th><th>标签</th><th>状态</th><th>预估 RTP</th><th>发布时间</th><th>操作</th></tr>
          </thead>
          <tbody>
            {configs.map((c) => (
              <tr key={c.version} className={editing?.meta.version === c.version ? 'row-active' : ''}>
                <td>v{c.version}</td>
                <td className="td-left">{c.label}</td>
                <td><span className={`badge ${c.status}`}>{{ draft: '草稿', published: '● 生效中', retired: '已退役' }[c.status]}</span></td>
                <td>{pct(c.estimatedRtp)}</td>
                <td>{c.publishedAt ? c.publishedAt.slice(0, 16).replace('T', ' ') : '—'}</td>
                <td className="td-ops">
                  {c.status === 'draft' && <>
                    <button onClick={() => void openEditor(c.version)}>编辑</button>
                    <button className="primary" onClick={() => publish(c.version)} disabled={busy !== ''}>发布</button>
                  </>}
                  {c.status === 'retired' && <button onClick={() => rollback(c.version)} disabled={busy !== ''}>回滚到此</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing && (
        <div className="editor">
          <h3>编辑 v{editing.meta.version} <small>{editing.meta.label}</small></h3>
          <div className="editor-grid">
            <div className="editor-card">
              <h4>符号权重与赔付（×注）</h4>
              <div className="sym-row sym-head"><b></b><span>权重</span><span>8+</span><span>10+</span><span>12+</span></div>
              {Object.keys(SYMBOL_NAMES).map((key) => (
                <div className="sym-row" key={key}>
                  <b>{SYMBOL_NAMES[key]}</b>
                  <input type="number" step="1" value={editing.config.symbols[key]?.weight ?? 0}
                    onChange={(e) => setSymbol(key, 'weight', Number(e.target.value))} />
                  {([0, 1, 2] as const).map((i) => (
                    <input key={i} type="number" step="0.1" value={editing.config.symbols[key]?.pay[i] ?? 0}
                      onChange={(e) => setSymbol(key, i, Number(e.target.value))} />
                  ))}
                </div>
              ))}
            </div>
            <div className="editor-card">
              <h4>特殊牌与总旋钮</h4>
              {([
                ['wildWeight', '白板权重'], ['scatterWeight', '骰子权重'],
                ['goldWeight', '金牌权重（免费局）'], ['payoutScale', '赔付缩放 payoutScale'],
              ] as const).map(([field, label]) => (
                <label className="field-row" key={field}>
                  <span>{label}</span>
                  <input type="number" step={field === 'payoutScale' ? 0.005 : 0.5}
                    value={editing.config[field]}
                    onChange={(e) => setField(field, Number(e.target.value))} />
                </label>
              ))}
              <label className="field-row" title="关闭后前端隐藏买入按钮、服务端拒绝买入">
                <span>Bonus Buy 买入免费旋转</span>
                <span>
                  <input type="checkbox"
                    checked={editing.config.bonusBuy?.enabled ?? true}
                    onChange={(e) => setBonusBuyEnabled(e.target.checked)} />
                  {' '}买入价 {(editing.config.bonusBuy?.costMultiplier ?? 0).toFixed(1)}×（改权重后须重标）
                </span>
              </label>
              {sim && (
                <div className="sim-result">
                  <h4>估算结果（{(sim.spins / 10000).toFixed(0)} 万次 · {sim.elapsedMs}ms）</h4>
                  <p><b className={sim.rtp > 1 ? 'bad' : ''}>RTP {pct(sim.rtp)}</b> · 命中率 {pct(sim.hitRate)}</p>
                  <p>免费旋转 1/{Math.round(1 / Math.max(sim.fsTriggerRate, 1e-9))} · 波动 {sim.stdevX.toFixed(1)} · 最大 {sim.maxWinX.toFixed(0)}×</p>
                  <p>免费旋转赢奖占比 {pct(sim.featureWinShare)}</p>
                </div>
              )}
            </div>
          </div>
          <div className="editor-ops">
            <button onClick={save} disabled={busy !== ''}>保存草稿</button>
            <button onClick={estimate} disabled={busy !== ''}>{busy === 'sim' ? '模拟中…' : '保存并估算（10 万次）'}</button>
            <button className="primary" onClick={() => publish(editing.meta.version)} disabled={busy !== ''}>发布</button>
            <button onClick={() => setEditing(null)}>关闭</button>
          </div>
        </div>
      )}
    </div>
  );
}

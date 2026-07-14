import { useEffect, useState } from 'react';
import { api } from './api';

interface EconomyParams {
  dailyBonus: number;
  reliefAmount: number;
  reliefCooldownHours: number;
}

const FIELDS: Array<{ key: keyof EconomyParams; label: string; hint: string }> = [
  { key: 'dailyBonus', label: '每日签到额（文）', hint: '默认 1000，UTC 日界每日一次' },
  { key: 'reliefAmount', label: '破产补币额（文）', hint: '默认 2000，余额低于最低注时可领' },
  { key: 'reliefCooldownHours', label: '补币冷却（小时）', hint: '默认 4，上限 168' },
];

export function EconomyPage() {
  const [params, setParams] = useState<EconomyParams | null>(null);
  const [draft, setDraft] = useState<Record<keyof EconomyParams, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void api<{ params: EconomyParams }>('/api/admin/economy')
      .then(({ params }) => {
        setParams(params);
        setDraft({ dailyBonus: String(params.dailyBonus), reliefAmount: String(params.reliefAmount), reliefCooldownHours: String(params.reliefCooldownHours) });
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const validate = (): EconomyParams | string => {
    if (!draft) return '未加载';
    const out = {} as EconomyParams;
    for (const f of FIELDS) {
      const v = Number(draft[f.key]);
      if (!Number.isInteger(v) || v <= 0) return `「${f.label}」须为正整数`;
      out[f.key] = v;
    }
    if (out.reliefCooldownHours > 168) return '补币冷却不能超过 168 小时';
    return out;
  };
  const check = validate();
  const invalid = typeof check === 'string' ? check : '';
  const dirty = params && typeof check !== 'string' &&
    FIELDS.some((f) => check[f.key] !== params[f.key]);

  const save = async () => {
    if (typeof check === 'string') return;
    if (!window.confirm('确认修改经济参数？保存后立即对所有玩家生效，并记入操作日志。')) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const { params: next } = await api<{ params: EconomyParams }>('/api/admin/economy', { method: 'PUT', body: { params: check } });
      setParams(next);
      setSaved(true);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (error && !draft) return <p className="error-line">⚠ {error}</p>;
  if (!draft || !params) return <p>加载中…</p>;
  return (
    <div>
      <h2>经济参数 <span className="hint">改动即时生效 · 全部留痕到操作日志</span></h2>
      {error && <p className="error-line">⚠ {error}</p>}

      <div className="panel economy-form">
        {FIELDS.map((f) => (
          <label className="field-row" key={f.key}>
            <span>
              {f.label}
              <small className="sub">{f.hint}</small>
            </span>
            <input
              value={draft[f.key]}
              onChange={(e) => { setSaved(false); setDraft({ ...draft, [f.key]: e.target.value }); }}
            />
          </label>
        ))}
        {invalid && <p className="error-line">⚠ {invalid}</p>}
        <div className="editor-ops">
          <button className="primary" disabled={busy || !dirty || !!invalid} onClick={() => void save()}>
            {busy ? '保存中…' : '保存修改'}
          </button>
          {saved && <span className="badge published">✓ 已生效</span>}
        </div>
      </div>

      <p className="sub note">
        保底（满 100 骰子 → 10 次免费旋转）与初始余额是数学模型的一部分，不在此调整——改它们会破坏 RTP 口径，需走配置版本流程。
      </p>
    </div>
  );
}

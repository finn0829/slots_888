import type { Grid, SpinResult, WinTier } from '@slots/engine';

const TOKEN_KEY = 'slots888_token';

export interface PlayerState {
  playerId: number;
  balance: number;
  freeSpinsRemaining: number;
  freeSpinBet: number;
  accumulatedMultiplier: number;
  diceProgress: number;
  status: 'active' | 'banned';
  canClaimDaily: boolean;
  canClaimRelief: boolean;
}

export interface PublicConfig {
  version: number;
  betLevels: number[];
  /** 公示 RTP：服务端按当前生效配置下发（改配置就跟着变），前端不得写死 */
  rtp: number;
  maxWinX: number;
  pity: { target: number; award: number };
  freeSpins: { trigger: number; base: number; perExtra: number };
  /** 各符号三档赔付（×bet 倍数，已含 payoutScale） */
  paytable: Record<string, number[]>;
  /** Ante Bet：成本倍数与真实触发率（服务端解析计算，随配置同步） */
  anteRule: {
    costMultiplier: number;
    triggerRate: number;
    anteTriggerRate: number;
    speedup: number;
  };
  /** Bonus Buy：开关 + 买入价倍数（服务端下发，前端不得写死） */
  bonusBuy: {
    enabled: boolean;
    costMultiplier: number;
  };
}

let token = localStorage.getItem(TOKEN_KEY) ?? undefined;

async function post<T>(url: string, body: unknown, auth = false): Promise<T> {
  const hasBody = body !== undefined;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      // 无 body 时不声明 content-type：Fastify 会因空 body 报 400
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err?.error?.message ?? `HTTP ${res.status}`), { status: res.status });
  }
  return res.json() as Promise<T>;
}

export async function ensureSession(): Promise<PlayerState> {
  const data = await post<{ token: string; state: PlayerState }>('/api/session', { token });
  token = data.token;
  localStorage.setItem(TOKEN_KEY, token);
  return data.state;
}

export async function fetchConfig(): Promise<PublicConfig> {
  const res = await fetch('/api/config');
  return res.json() as Promise<PublicConfig>;
}

export async function requestSpin(bet: number, anteEnabled = false): Promise<{ spin: SpinResult; state: PlayerState }> {
  return post('/api/spin', { bet, anteEnabled }, true);
}

/** Bonus Buy：花钱直接买 N 次免费旋转（服务端权威扣款并置免费旋转状态） */
export async function requestBonusBuy(bet: number): Promise<{ cost: number; freeSpinsAwarded: number; state: PlayerState }> {
  return post('/api/bonus-buy', { bet }, true);
}

export async function claimDaily(): Promise<{ amount: number; state: PlayerState }> {
  return post('/api/claim-daily', undefined, true);
}

export async function claimRelief(): Promise<{ amount: number; state: PlayerState }> {
  return post('/api/claim-relief', undefined, true);
}

/** 断线重连：最后一局的 SpinResult（用来恢复盘面，不产生任何判定） */
export async function fetchLastSpin(): Promise<SpinResult | null> {
  const res = await fetch('/api/last-spin', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) return null;
  return (await res.json()).spin as SpinResult | null;
}

export interface PlayerStats {
  totalSpins: number;
  totalBet: number;
  totalWin: number;
  net: number;
  rtp: number | null;
  hitRate: number | null;
  biggestWin: number;
  biggestWinX: number;
  freeSpinsPlayed: number;
  bonusBuySpent: number;
  bonusReceived: number;
}

export async function fetchStats(): Promise<PlayerStats> {
  const res = await fetch('/api/stats', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PlayerStats>;
}

/** 一条赢奖历史（WEB-14）：含终盘盘面，展开时直接上盘 */
export interface HistoryRow {
  spinId: number;
  createdAt: string;
  mode: 'base' | 'free';
  isFree: boolean;
  bet: number;
  totalCost: number;
  totalWin: number;
  winX: number;
  winTier: WinTier | null;
  finalGrid: Grid;
}

/** 赢奖历史：游标分页，before = 上一页最后一条 spinId（加载更早） */
export async function fetchHistory(before?: number, limit = 20): Promise<{ history: HistoryRow[]; nextCursor: number | null }> {
  const qs = new URLSearchParams();
  if (before) qs.set('before', String(before));
  qs.set('limit', String(limit));
  const res = await fetch(`/api/history?${qs.toString()}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ history: HistoryRow[]; nextCursor: number | null }>;
}

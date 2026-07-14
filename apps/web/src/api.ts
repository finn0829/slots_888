import type { SpinResult } from '@slots/engine';

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
  maxWinX: number;
  pity: { target: number; award: number };
  freeSpins: { trigger: number; base: number; perExtra: number };
  /** 各符号三档赔付（×bet 倍数，已含 payoutScale） */
  paytable: Record<string, number[]>;
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

export async function requestSpin(bet: number): Promise<{ spin: SpinResult; state: PlayerState }> {
  return post('/api/spin', { bet, anteEnabled: false }, true);
}

export async function claimDaily(): Promise<{ amount: number; state: PlayerState }> {
  return post('/api/claim-daily', undefined, true);
}

export async function claimRelief(): Promise<{ amount: number; state: PlayerState }> {
  return post('/api/claim-relief', undefined, true);
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
  bonusReceived: number;
}

export async function fetchStats(): Promise<PlayerStats> {
  const res = await fetch('/api/stats', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<PlayerStats>;
}

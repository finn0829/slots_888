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
}

export interface PublicConfig {
  version: number;
  betLevels: number[];
  maxWinX: number;
  pity: { target: number; award: number };
  freeSpins: { trigger: number; base: number; perExtra: number };
}

let token = localStorage.getItem(TOKEN_KEY) ?? undefined;

async function post<T>(url: string, body: unknown, auth = false): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(auth && token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
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

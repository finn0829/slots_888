export const TOKEN_KEY = 'slots888_admin_token';

export function adminToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export async function api<T>(url: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: {
      // 无 body 时不能声明 content-type：Fastify 会因空 body 解析失败返回 400
      ...(hasBody ? { 'content-type': 'application/json' } : {}),
      authorization: `Bearer ${adminToken() ?? ''}`,
    },
    body: hasBody ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    window.location.reload();
    throw new Error('登录已过期');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface ConfigMeta {
  version: number; label: string;
  status: 'draft' | 'published' | 'retired';
  estimatedRtp: number | null;
  createdAt: string; publishedAt: string | null;
}

export interface SimResult {
  rtp: number; hitRate: number; fsTriggerRate: number;
  maxWinX: number; stdevX: number; featureWinShare: number;
  spins: number; elapsedMs: number;
}

// ── 看板（ADM-3 / SRV-5）──

export interface StatRow {
  key: string; spins: number; totalBet: number; totalWin: number;
  rtp: number | null; hitRate: number; fsTriggers: number; uniquePlayers: number;
}

export interface SummaryData {
  today: { spins: number; totalBet: number; totalWin: number; rtp: number | null; uniquePlayers: number; bigWins: number };
  publishedVersion: number;
  theoreticalRtp: number | null;
  totalPlayers: number;
}

export interface Distributions {
  winTiers: Array<{ tier: string; count: number; totalWin: number }>;
  betLevels: Array<{ bet: number; count: number }>;
  cascadeDepth: Array<{ depth: number; count: number }>;
  fsTriggerRate: number;
}

// ── 玩家管理（ADM-5 / SRV-6a）──

export interface PlayerAdminRow {
  id: number; balance: number; status: 'active' | 'banned';
  createdAt: string; lastSeenAt: string | null;
  spins: number; totalBet: number; totalWin: number;
}

// ── 审计回放（ADM-4 / SRV-6b）──

export interface SpinRow {
  id: number; playerId: number; configVersion: number;
  mode: 'base' | 'free'; bet: number; totalCost: number;
  totalWin: number; winX: number; winTier: string | null;
  cascades: number; createdAt: string; seed?: string;
}

export interface SpinCell { symbol: string; goldMultiplier?: number }

export interface CascadeStep {
  gridBefore: SpinCell[][];
  wins: Array<{ symbol: string; count: number; basePayout: number }>;
  removedPositions: Array<{ col: number; row: number }>;
  chainMultiplier: number;
  stepWin: number;
  gridAfter: SpinCell[][];
}

export interface SpinDetail {
  spin: SpinRow;
  result: {
    cascades: CascadeStep[]; totalWin: number; scatterCount: number;
    freeSpinsAwarded: number; goldMultipliers: number[]; winTier: string | null;
  };
  replayCheck: { match: boolean };
}

/** engine GameConfig 的后台可编辑视图（其余字段原样透传） */
export interface EditableConfig {
  presetId: string;
  symbols: Record<string, { weight: number; pay: [number, number, number] }>;
  wildWeight: number;
  scatterWeight: number;
  goldWeight: number;
  payoutScale: number;
  [key: string]: unknown;
}

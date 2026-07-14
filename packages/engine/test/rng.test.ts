import { describe, it, expect } from 'vitest';
import { createRng } from '../src/rng';

describe('createRng（可注入 seed 的确定性 RNG）', () => {
  it('同一 seed 产生完全相同的序列', () => {
    const a = createRng('spin-0001');
    const b = createRng('spin-0001');
    const seqA = Array.from({ length: 100 }, () => a.nextInt(1000));
    const seqB = Array.from({ length: 100 }, () => b.nextInt(1000));
    expect(seqA).toEqual(seqB);
  });

  it('不同 seed 产生不同序列', () => {
    const a = createRng('spin-0001');
    const b = createRng('spin-0002');
    const seqA = Array.from({ length: 20 }, () => a.nextInt(1_000_000));
    const seqB = Array.from({ length: 20 }, () => b.nextInt(1_000_000));
    expect(seqA).not.toEqual(seqB);
  });

  it('nextInt(n) 始终落在 [0, n)', () => {
    const rng = createRng('range-check');
    for (let i = 0; i < 10_000; i++) {
      const v = rng.nextInt(7);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(7);
    }
  });

  it('分布大致均匀（卡方粗检，非严格统计）', () => {
    const rng = createRng('uniformity');
    const buckets = new Array(10).fill(0);
    const N = 100_000;
    for (let i = 0; i < N; i++) buckets[rng.nextInt(10)]++;
    for (const c of buckets) {
      expect(c).toBeGreaterThan(N / 10 * 0.9);
      expect(c).toBeLessThan(N / 10 * 1.1);
    }
  });
});

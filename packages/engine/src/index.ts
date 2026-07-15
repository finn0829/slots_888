// @slots/engine — 唯一数学真相源（见 docs/contracts/CT-1-spin-result.md）
export const ENGINE_VERSION = '0.1.0';

export * from './types';
export { spin, winTierFor, ladderValue } from './spin';
export { findWins, removeAndDrop, NORMAL_SYMBOLS } from './grid';
export { createRng, type Rng } from './rng';
export { defaultPreset, getPreset, PRESET_IDS, type PresetId } from './config';
export { simulate, type SimulateOptions, type SimulateStats } from './simulate';
export { analyze, featureSegmentValueX, type AnalyzeOptions, type AnalyzeResult, type SegmentValueResult } from './analyze';
export { freeSpinTriggerRate, anteSpeedup } from './trigger';

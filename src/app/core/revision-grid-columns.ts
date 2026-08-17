import type { RevisionGridColumns } from './models';

export type GridColId = 'graph' | 'message' | 'author' | 'date' | 'sha';

export const GRID_COL_IDS: GridColId[] = ['graph', 'message', 'author', 'date', 'sha'];

export const COL_MIN: Record<GridColId, number> = {
  graph: 56,
  message: 140,
  author: 72,
  date: 92,
  sha: 56,
};

export const COL_MAX: Record<GridColId, number> = {
  graph: 400,
  message: 640,
  author: 200,
  date: 140,
  sha: 88,
};

export const COL_DEFAULT: RevisionGridColumns = {
  author: 108,
  date: 108,
  sha: 68,
};

export const COL_PAD = 20;
export const GRID_COL_SAMPLE = 64;

export type SplitKind = 'main' | 'nested' | 'commitFiles' | 'commitComposer';

export const SPLIT_MAIN_DEFAULT = [16, 84];
export const SPLIT_NESTED_DEFAULT = [62, 38];
export const SPLIT_COMMIT_FILES_DEFAULT = [34, 66];
export const SPLIT_COMMIT_COMPOSER_DEFAULT = [68, 32];

export function clampColWidth(col: GridColId, width: number): number {
  const min = COL_MIN[col];
  const max = COL_MAX[col];
  if (!Number.isFinite(width)) return min;
  return Math.round(Math.min(max, Math.max(min, width)));
}

export function normalizeRevisionGridColumns(raw: unknown): RevisionGridColumns {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const optional = (value: unknown, col: GridColId): number | undefined => {
    if (value == null || value === 0) return undefined;
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return clampColWidth(col, n);
  };
  return {
    graph: optional(o['graph'], 'graph'),
    message: optional(o['message'], 'message'),
    author: clampColWidth('author', numOr(o['author'], COL_DEFAULT.author)),
    date: clampColWidth('date', numOr(o['date'], COL_DEFAULT.date)),
    sha: clampColWidth('sha', numOr(o['sha'], COL_DEFAULT.sha)),
  };
}

export function normalizeSplitSizes(kind: SplitKind, sizes: number[]): number[] {
  const fallback =
    kind === 'main'
      ? SPLIT_MAIN_DEFAULT
      : kind === 'nested'
        ? SPLIT_NESTED_DEFAULT
        : kind === 'commitFiles'
          ? SPLIT_COMMIT_FILES_DEFAULT
          : SPLIT_COMMIT_COMPOSER_DEFAULT;
  const a = Number(sizes[0]);
  const b = Number(sizes[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a + b <= 0) return [...fallback];
  let left = (a / (a + b)) * 100;
  if (kind === 'main') left = Math.min(30, Math.max(12, left));
  else if (kind === 'nested') left = Math.min(78, Math.max(45, left));
  else if (kind === 'commitFiles') left = Math.min(52, Math.max(18, left));
  else left = Math.min(80, Math.max(42, left));
  const rounded = Math.round(left * 10) / 10;
  return [rounded, Math.round((100 - rounded) * 10) / 10];
}

export function sampleStride<T>(items: readonly T[], cap: number): T[] {
  const n = items.length;
  if (n <= cap) return items.slice();
  const out: T[] = [];
  const step = n / cap;
  for (let i = 0; i < cap; i++) {
    out.push(items[Math.min(n - 1, Math.floor(i * step))]!);
  }
  return out;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;

export function measureTextWidth(text: string, font: string): number {
  if (!text) return 0;
  if (measureCtx === undefined) {
    measureCtx = document.createElement('canvas').getContext('2d');
  }
  if (!measureCtx) return text.length * 7;
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

function numOr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

import {
  COL_DEFAULT,
  COL_MAX,
  COL_MIN,
  clampColWidth,
  normalizeRevisionGridColumns,
  normalizeSplitSizes,
  sampleStride,
} from './revision-grid-columns';

describe('revision grid columns', () => {
  it('keeps SHA and date in a compact content range', () => {
    expect(COL_DEFAULT.sha).toBeLessThanOrEqual(72);
    expect(COL_MAX.sha).toBeLessThanOrEqual(88);
    expect(COL_MIN.sha).toBeGreaterThanOrEqual(52);
    expect(COL_DEFAULT.date).toBe(108);
    expect(COL_MAX.date).toBeLessThanOrEqual(140);
    expect(COL_MAX.author).toBeLessThanOrEqual(200);
    expect(COL_MAX.graph).toBe(96);
  });

  it('clamps oversized saved widths from older sessions', () => {
    const next = normalizeRevisionGridColumns({
      graph: 800,
      message: 2000,
      author: 600,
      date: 400,
      sha: 280,
    });
    expect(next.graph).toBe(COL_MAX.graph);
    expect(next.message).toBe(COL_MAX.message);
    expect(next.author).toBe(COL_MAX.author);
    expect(next.date).toBe(COL_MAX.date);
    expect(next.sha).toBe(COL_MAX.sha);
  });

  it('leaves an unset graph width unset so the lane fit can run', () => {
    const next = normalizeRevisionGridColumns({
      author: 120,
      date: 128,
      sha: 80,
    });
    expect(next.graph).toBeUndefined();
    expect(next.message).toBeUndefined();
    expect(next.author).toBe(120);
    expect(next.sha).toBe(80);
  });

  it('clamps a dragged width without using the raw value', () => {
    expect(clampColWidth('sha', 12)).toBe(COL_MIN.sha);
    expect(clampColWidth('sha', 400)).toBe(COL_MAX.sha);
    expect(clampColWidth('graph', 900)).toBe(COL_MAX.graph);
  });

  it('keeps split panes in a professional range', () => {
    expect(normalizeSplitSizes('main', [16, 84])).toEqual([16, 84]);
    expect(normalizeSplitSizes('main', [80, 20])[0]).toBe(72);
    expect(normalizeSplitSizes('main', [4, 96])[0]).toBe(12);
    expect(normalizeSplitSizes('nested', [90, 10])[0]).toBe(78);
    expect(normalizeSplitSizes('nested', [20, 80])[0]).toBe(45);
    expect(normalizeSplitSizes('commitFiles', [34, 66])).toEqual([34, 66]);
    expect(normalizeSplitSizes('commitFiles', [8, 92])[0]).toBe(18);
    expect(normalizeSplitSizes('commitFiles', [90, 10])[0]).toBe(52);
    expect(normalizeSplitSizes('commitComposer', [68, 32])).toEqual([68, 32]);
    expect(normalizeSplitSizes('commitComposer', [20, 80])[0]).toBe(42);
    expect(normalizeSplitSizes('commitComposer', [95, 5])[0]).toBe(80);
  });

  it('samples a stride instead of walking every item', () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const sample = sampleStride(items, 64);
    expect(sample.length).toBe(64);
    expect(sample[0]).toBe(0);
    expect(sample[sample.length - 1]).toBeGreaterThan(900);
  });
});

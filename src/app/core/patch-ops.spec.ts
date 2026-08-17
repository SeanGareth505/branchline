import { parseUnifiedDiff } from './patch-ops';

describe('parseUnifiedDiff line numbers', () => {
  it('numbers old and new sides from each hunk header', () => {
    const parsed = parseUnifiedDiff(
      [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,5 +1,3 @@',
        '-import x from "./x";',
        ' import { y } from "./y";',
        '-import z from "./z";',
        ' ',
        ' export const presets = {',
        '@@ -286,3 +284,3 @@',
        '-  url: "old"',
        '+  url: "new"',
        ' };',
      ].join('\n'),
    );

    const numbered = parsed.lines.filter((line) => line.oldNo != null || line.newNo != null);
    expect(numbered.map((line) => [line.kind, line.oldNo, line.newNo])).toEqual([
      ['del', 1, null],
      ['ctx', 2, 1],
      ['del', 3, null],
      ['ctx', 4, 2],
      ['ctx', 5, 3],
      ['del', 286, null],
      ['add', null, 284],
      ['ctx', 287, 285],
    ]);
  });

  it('does not consume line numbers for hunk headers or no-newline markers', () => {
    const parsed = parseUnifiedDiff(
      [
        '@@ -1,2 +1,2 @@',
        ' keep',
        '+added',
        '\\ No newline at end of file',
      ].join('\n'),
    );
    const added = parsed.lines.find((line) => line.kind === 'add');
    const marker = parsed.lines.find((line) => line.text.startsWith('\\'));
    expect(added?.newNo).toBe(2);
    expect(marker?.kind).toBe('meta');
    expect(marker?.oldNo).toBeNull();
    expect(marker?.newNo).toBeNull();
  });
});

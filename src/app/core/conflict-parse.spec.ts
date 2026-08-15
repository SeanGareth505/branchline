import {
  acceptAllChoices,
  alignConflictLines,
  buildConflictResult,
  contentForChoice,
  parseConflictMarkers,
  reconstructMarkers,
  remainingConflictIds,
  sliceContext,
  wordDiff,
} from './conflict-parse';

describe('parseConflictMarkers', () => {
  it('parses two-way markers and keeps surrounding file context', () => {
    const parsed = parseConflictMarkers(
      ['keep', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> branch', 'after', ''].join('\n'),
    );
    expect(parsed.hasMarkers).toBeTrue();
    expect(parsed.conflicts.length).toBe(1);
    expect(parsed.conflicts[0]?.ours).toBe('ours\n');
    expect(parsed.conflicts[0]?.theirs).toBe('theirs\n');
    expect(parsed.conflicts[0]?.hasBase).toBeFalse();
    expect(parsed.segments[0]).toEqual({ kind: 'text', text: 'keep\n' });
    expect(parsed.segments[2]).toEqual({ kind: 'text', text: 'after\n' });
  });

  it('does not treat ordinary lines as diff3 base markers', () => {
    const parsed = parseConflictMarkers(
      ['<<<<<<< HEAD', 'pipe | value', '=======', 'other', '>>>>>>> branch'].join('\n'),
    );
    expect(parsed.conflicts[0]?.ours).toBe('pipe | value\n');
    expect(parsed.conflicts[0]?.hasBase).toBeFalse();
  });

  it('parses diff3 base between ours and theirs', () => {
    const parsed = parseConflictMarkers(
      [
        '<<<<<<< HEAD',
        'ours',
        '||||||| base',
        'old',
        '=======',
        'theirs',
        '>>>>>>> branch',
        '',
      ].join('\n'),
    );
    expect(parsed.conflicts[0]?.hasBase).toBeTrue();
    expect(parsed.conflicts[0]?.base).toBe('old\n');
    expect(parsed.conflicts[0]?.ours).toBe('ours\n');
    expect(parsed.conflicts[0]?.theirs).toBe('theirs\n');
  });
});

describe('reconstructMarkers', () => {
  it('writes ours, then base, then theirs — git diff3 order', () => {
    const parsed = parseConflictMarkers(
      [
        '<<<<<<< HEAD',
        'ours',
        '||||||| base',
        'old',
        '=======',
        'theirs',
        '>>>>>>> branch',
        '',
      ].join('\n'),
    );
    const rebuilt = reconstructMarkers(parsed.conflicts[0]!);
    expect(rebuilt).toBe(
      ['<<<<<<< HEAD', 'ours', '||||||| base', 'old', '=======', 'theirs', '>>>>>>> branch', ''].join(
        '\n',
      ),
    );
    expect(parseConflictMarkers(rebuilt).conflicts[0]?.ours).toBe('ours\n');
  });
});

describe('buildConflictResult', () => {
  const parsed = parseConflictMarkers(
    ['before', '<<<<<<< HEAD', 'A', '=======', 'B', '>>>>>>> other', 'after', ''].join('\n'),
  );

  it('keeps markers until a choice is made', () => {
    const result = buildConflictResult(parsed, new Map());
    expect(result).toContain('<<<<<<< HEAD');
    expect(result.startsWith('before\n')).toBeTrue();
    expect(result.endsWith('after\n')).toBeTrue();
  });

  it('concatenates both in either order', () => {
    expect(contentForChoice(parsed.conflicts[0]!, 'both')).toBe('A\nB\n');
    expect(contentForChoice(parsed.conflicts[0]!, 'bothReverse')).toBe('B\nA\n');
  });

  it('uses custom hunk text', () => {
    const result = buildConflictResult(
      parsed,
      new Map([['c1', 'custom']]),
      new Map([['c1', 'merged\n']]),
    );
    expect(result).toBe('before\nmerged\nafter\n');
  });
});

describe('remainingConflictIds', () => {
  const parsed = parseConflictMarkers(
    ['<<<<<<< HEAD', 'A', '=======', 'B', '>>>>>>> other', ''].join('\n'),
  );

  it('treats custom without text as unresolved', () => {
    expect(remainingConflictIds(parsed.conflicts, new Map([['c1', 'custom']]))).toEqual(['c1']);
    expect(
      remainingConflictIds(parsed.conflicts, new Map([['c1', 'custom']]), new Map([['c1', 'x\n']])),
    ).toEqual([]);
  });

  it('accepts all incoming', () => {
    const map = acceptAllChoices(parsed.conflicts, 'theirs');
    expect(map.get('c1')).toBe('theirs');
  });
});

describe('wordDiff', () => {
  it('highlights the changed token on each side', () => {
    const diff = wordDiff('foo bar baz', 'foo qux baz');
    expect(diff.left.map((s) => s.kind)).toContain('delete');
    expect(diff.right.map((s) => s.kind)).toContain('insert');
    expect(diff.left.find((s) => s.kind === 'delete')?.text).toBe('bar');
    expect(diff.right.find((s) => s.kind === 'insert')?.text).toBe('qux');
  });
});

describe('alignConflictLines', () => {
  it('pairs a changed line and keeps equal lines aligned', () => {
    const rows = alignConflictLines('same\nold\n', 'same\nnew\n');
    expect(rows[0]?.kind).toBe('equal');
    expect(rows[1]?.kind).toBe('change');
    expect(rows[1]?.left).toBe('old');
    expect(rows[1]?.right).toBe('new');
  });
});

describe('sliceContext', () => {
  it('collapses long unchanged regions', () => {
    const text = Array.from({ length: 40 }, (_, i) => `L${i}`).join('\n') + '\n';
    const collapsed = sliceContext(text, false, 4, 3);
    expect(collapsed.hidden).toBe(33);
    expect(collapsed.head).toEqual(['L0', 'L1', 'L2', 'L3']);
    expect(collapsed.tail).toEqual(['L37', 'L38', 'L39']);
    expect(sliceContext(text, true, 4, 3).hidden).toBe(0);
  });
});

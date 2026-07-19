export type DiffLineKind = 'meta' | 'hunk' | 'ctx' | 'add' | 'del';

export interface DiffLine {
  index: number;
  text: string;
  kind: DiffLineKind;
  selectable: boolean;
  hunkId: string | null;
}

export interface DiffHunk {
  id: string;
  header: string;
  headerIndex: number;
  oldStart: number;
  newStart: number;
  lineIndexes: number[];
}

export interface ParsedDiff {
  lines: DiffLine[];
  hunks: DiffHunk[];
  preambleIndexes: number[];
  hasHunks: boolean;
}

const HUNK_RE = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s@@/;

export function parseUnifiedDiff(raw: string): ParsedDiff {
  let normalized = raw.replace(/\r\n/g, '\n');
  if (normalized.endsWith('\n')) normalized = normalized.slice(0, -1);
  const texts = normalized.length ? normalized.split('\n') : [];
  const lines: DiffLine[] = [];
  const hunks: DiffHunk[] = [];
  const preambleIndexes: number[] = [];
  let current: DiffHunk | null = null;
  let hunkSeq = 0;

  texts.forEach((text, index) => {
    let kind: DiffLineKind = 'ctx';
    if (text.startsWith('@@')) kind = 'hunk';
    else if (text.startsWith('+') && !text.startsWith('+++')) kind = 'add';
    else if (text.startsWith('-') && !text.startsWith('---')) kind = 'del';
    else if (
      text.startsWith('diff ') ||
      text.startsWith('index ') ||
      text.startsWith('---') ||
      text.startsWith('+++') ||
      text.startsWith('new file') ||
      text.startsWith('deleted file') ||
      text.startsWith('similarity ') ||
      text.startsWith('rename ') ||
      text.startsWith('copy ') ||
      text.startsWith('Binary ')
    ) {
      kind = 'meta';
    }

    if (kind === 'hunk') {
      const match = text.match(HUNK_RE);
      hunkSeq += 1;
      current = {
        id: `h${hunkSeq}`,
        header: text,
        headerIndex: index,
        oldStart: match ? Number(match[1]) : 1,
        newStart: match ? Number(match[2]) : 1,
        lineIndexes: [],
      };
      hunks.push(current);
      lines.push({
        index,
        text: text || ' ',
        kind,
        selectable: false,
        hunkId: current.id,
      });
      return;
    }

    if (kind === 'meta' && !current) {
      preambleIndexes.push(index);
      lines.push({ index, text: text || ' ', kind, selectable: false, hunkId: null });
      return;
    }

    if (current && (kind === 'add' || kind === 'del' || kind === 'ctx' || kind === 'meta')) {
      if (kind === 'add' || kind === 'del' || kind === 'ctx') {
        current.lineIndexes.push(index);
      }
      lines.push({
        index,
        text: text || ' ',
        kind: kind === 'meta' ? 'ctx' : kind,
        selectable: kind === 'add' || kind === 'del',
        hunkId: current.id,
      });
      return;
    }

    lines.push({
      index,
      text: text || ' ',
      kind,
      selectable: false,
      hunkId: current?.id ?? null,
    });
  });

  return { lines, hunks, preambleIndexes, hasHunks: hunks.length > 0 };
}

export function buildPartialPatch(
  parsed: ParsedDiff,
  selectedIndexes: ReadonlySet<number>,
): string | null {
  if (!parsed.hunks.length || selectedIndexes.size === 0) return null;

  const preamble = parsed.preambleIndexes
    .map((i) => parsed.lines[i]?.text ?? '')
    .filter((t) => t.length > 0);
  const hunkParts: string[] = [];

  for (const hunk of parsed.hunks) {
    const body: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    let changed = false;

    for (const lineIndex of hunk.lineIndexes) {
      const line = parsed.lines[lineIndex];
      if (!line) continue;
      const selected = selectedIndexes.has(lineIndex);

      if (line.kind === 'ctx') {
        body.push(line.text.startsWith(' ') ? line.text : ` ${line.text}`);
        oldCount += 1;
        newCount += 1;
        continue;
      }

      if (line.kind === 'del') {
        if (selected) {
          body.push(line.text.startsWith('-') ? line.text : `-${line.text}`);
          oldCount += 1;
          changed = true;
        } else {
          const content = line.text.startsWith('-') ? line.text.slice(1) : line.text;
          body.push(` ${content}`);
          oldCount += 1;
          newCount += 1;
        }
        continue;
      }

      if (line.kind === 'add') {
        if (selected) {
          body.push(line.text.startsWith('+') ? line.text : `+${line.text}`);
          newCount += 1;
          changed = true;
        }
      }
    }

    if (!changed) continue;

    const suffix = hunk.header.includes('@@', 2)
      ? hunk.header.slice(hunk.header.indexOf('@@', 2) + 2)
      : '';
    hunkParts.push(
      `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${suffix}`,
      ...body,
    );
  }

  if (!hunkParts.length) return null;

  const out = [...preamble, ...hunkParts].join('\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}

export function selectableIndexesForHunk(parsed: ParsedDiff, hunkId: string): number[] {
  const hunk = parsed.hunks.find((h) => h.id === hunkId);
  if (!hunk) return [];
  return hunk.lineIndexes.filter((i) => parsed.lines[i]?.selectable);
}

export interface SideBySideCell {
  line: DiffLine | null;
}

export interface SideBySideRow {
  left: SideBySideCell;
  right: SideBySideCell;
}

export function buildSideBySideRows(parsed: ParsedDiff): SideBySideRow[] {
  return parsed.lines.map((line) => {
    if (line.kind === 'del') {
      return { left: { line }, right: { line: null } };
    }
    if (line.kind === 'add') {
      return { left: { line: null }, right: { line } };
    }
    return { left: { line }, right: { line } };
  });
}

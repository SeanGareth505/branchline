export type ConflictChoice = 'ours' | 'theirs' | 'both' | 'bothReverse' | 'base' | 'custom';

export interface ConflictRegion {
  id: string;
  index: number;
  oursLabel: string;
  theirsLabel: string;
  base: string;
  ours: string;
  theirs: string;
  hasBase: boolean;
  startLine: number;
}

export type ConflictSegment =
  | { kind: 'text'; text: string }
  | { kind: 'conflict'; conflict: ConflictRegion };

export interface ParsedConflicts {
  segments: ConflictSegment[];
  conflicts: ConflictRegion[];
  hasMarkers: boolean;
}

export type DiffSpanKind = 'equal' | 'insert' | 'delete';

export interface DiffSpan {
  kind: DiffSpanKind;
  text: string;
}

export interface AlignedLine {
  left: string | null;
  right: string | null;
  kind: 'equal' | 'change' | 'insert' | 'delete';
  leftSpans: DiffSpan[];
  rightSpans: DiffSpan[];
}

export interface ContextSlice {
  head: string[];
  tail: string[];
  hidden: number;
  total: number;
}

const START = /^<<<<<<< ?(.*)$/;
const BASE = /^\|{7} ?(.*)$/;
const MID = /^=======\s*$/;
const END = /^>>>>>>> ?(.*)$/;
const TOKEN_RE = /(\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_])/g;
const MAX_DIFF_TOKENS = 240;
const MAX_DIFF_LINES = 200;

export function parseConflictMarkers(raw: string): ParsedConflicts {
  const normalized = raw.replace(/\r\n/g, '\n');
  const trailingNewline = normalized.endsWith('\n');
  const body = trailingNewline ? normalized.slice(0, -1) : normalized;
  const lines = body.length ? body.split('\n') : [];
  const segments: ConflictSegment[] = [];
  const conflicts: ConflictRegion[] = [];
  let textBuf: string[] = [];
  let i = 0;
  let conflictSeq = 0;

  const flushText = (final = false): void => {
    if (!textBuf.length) return;
    const joined = textBuf.join('\n');
    const suffix = final && !trailingNewline ? '' : '\n';
    segments.push({ kind: 'text', text: joined + suffix });
    textBuf = [];
  };

  while (i < lines.length) {
    const startMatch = lines[i]?.match(START);
    if (!startMatch) {
      textBuf.push(lines[i] ?? '');
      i += 1;
      continue;
    }

    flushText();
    const oursLabel = (startMatch[1] ?? 'HEAD').trim() || 'HEAD';
    const startLine = i + 1;
    i += 1;

    const oursLines: string[] = [];
    let baseLines: string[] = [];
    let inBase = false;

    while (i < lines.length && !MID.test(lines[i] ?? '') && !END.test(lines[i] ?? '')) {
      const baseMatch = lines[i]?.match(BASE);
      if (baseMatch) {
        inBase = true;
        i += 1;
        continue;
      }
      if (inBase) baseLines.push(lines[i] ?? '');
      else oursLines.push(lines[i] ?? '');
      i += 1;
    }

    if (i < lines.length && MID.test(lines[i] ?? '')) {
      i += 1;
    }

    const theirsLines: string[] = [];
    while (i < lines.length && !END.test(lines[i] ?? '')) {
      theirsLines.push(lines[i] ?? '');
      i += 1;
    }

    let theirsLabel = 'theirs';
    if (i < lines.length) {
      const endMatch = lines[i]?.match(END);
      theirsLabel = (endMatch?.[1] ?? 'theirs').trim() || 'theirs';
      i += 1;
    }

    conflictSeq += 1;
    const conflict: ConflictRegion = {
      id: `c${conflictSeq}`,
      index: conflictSeq - 1,
      oursLabel,
      theirsLabel,
      base: joinBlock(baseLines),
      ours: joinBlock(oursLines),
      theirs: joinBlock(theirsLines),
      hasBase: baseLines.length > 0 || inBase,
      startLine,
    };
    conflicts.push(conflict);
    segments.push({ kind: 'conflict', conflict });
  }

  flushText(true);

  return {
    segments,
    conflicts,
    hasMarkers: conflicts.length > 0,
  };
}

export function buildConflictResult(
  parsed: ParsedConflicts,
  choices: ReadonlyMap<string, ConflictChoice>,
  custom?: ReadonlyMap<string, string>,
): string {
  const parts: string[] = [];
  for (const segment of parsed.segments) {
    if (segment.kind === 'text') {
      parts.push(segment.text);
      continue;
    }
    const choice = choices.get(segment.conflict.id);
    if (!choice) {
      parts.push(reconstructMarkers(segment.conflict));
      continue;
    }
    if (choice === 'custom') {
      parts.push(normalizeBlock(custom?.get(segment.conflict.id) ?? ''));
      continue;
    }
    parts.push(contentForChoice(segment.conflict, choice));
  }
  return joinParts(parts);
}

export function contentForChoice(conflict: ConflictRegion, choice: ConflictChoice): string {
  switch (choice) {
    case 'ours':
      return conflict.ours;
    case 'theirs':
      return conflict.theirs;
    case 'both':
      return concatBlocks(conflict.ours, conflict.theirs);
    case 'bothReverse':
      return concatBlocks(conflict.theirs, conflict.ours);
    case 'base':
      return conflict.base;
    case 'custom':
      return '';
  }
}

export function reconstructMarkers(conflict: ConflictRegion): string {
  const lines = [`<<<<<<< ${conflict.oursLabel}`];
  if (conflict.ours) lines.push(...splitBlock(conflict.ours));
  if (conflict.hasBase) {
    lines.push('||||||| base');
    if (conflict.base) lines.push(...splitBlock(conflict.base));
  }
  lines.push('=======');
  if (conflict.theirs) lines.push(...splitBlock(conflict.theirs));
  lines.push(`>>>>>>> ${conflict.theirsLabel}`);
  return lines.join('\n') + '\n';
}

export function remainingConflictIds(
  conflicts: readonly ConflictRegion[],
  choices: ReadonlyMap<string, ConflictChoice>,
  custom?: ReadonlyMap<string, string>,
): string[] {
  return conflicts
    .filter((c) => {
      const choice = choices.get(c.id);
      if (!choice) return true;
      if (choice === 'custom') return !custom?.has(c.id);
      return false;
    })
    .map((c) => c.id);
}

export function draftHasConflictMarkers(draft: string): boolean {
  return /^<<<<<<< /m.test(draft) || /^>>>>>>> /m.test(draft);
}

export function acceptAllChoices(
  conflicts: readonly ConflictRegion[],
  side: ConflictChoice,
): Map<string, ConflictChoice> {
  const map = new Map<string, ConflictChoice>();
  for (const c of conflicts) {
    if (side === 'base' && !c.hasBase) continue;
    if (side === 'custom') continue;
    map.set(c.id, side);
  }
  return map;
}

export function sliceContext(text: string, expanded: boolean, head = 10, tail = 8): ContextSlice {
  const lines = splitBlock(text);
  if (expanded || lines.length <= head + tail + 4) {
    return { head: lines, tail: [], hidden: 0, total: lines.length };
  }
  return {
    head: lines.slice(0, head),
    tail: lines.slice(lines.length - tail),
    hidden: lines.length - head - tail,
    total: lines.length,
  };
}

export function alignConflictLines(ours: string, theirs: string): AlignedLine[] {
  const left = splitBlock(ours);
  const right = splitBlock(theirs);
  if (left.length > MAX_DIFF_LINES || right.length > MAX_DIFF_LINES) {
    return fallbackAligned(left, right);
  }
  const ops = tokenOps(left, right);
  const rows: AlignedLine[] = [];
  for (const op of ops) {
    if (op.kind === 'equal') {
      for (const line of op.tokens) {
        rows.push({
          left: line,
          right: line,
          kind: 'equal',
          leftSpans: [{ kind: 'equal', text: line }],
          rightSpans: [{ kind: 'equal', text: line }],
        });
      }
      continue;
    }
    if (op.kind === 'delete') {
      for (const line of op.tokens) {
        rows.push({
          left: line,
          right: null,
          kind: 'delete',
          leftSpans: [{ kind: 'delete', text: line }],
          rightSpans: [],
        });
      }
      continue;
    }
    for (const line of op.tokens) {
      rows.push({
        left: null,
        right: line,
        kind: 'insert',
        leftSpans: [],
        rightSpans: [{ kind: 'insert', text: line }],
      });
    }
  }
  return mergeChangeRows(rows);
}

export function wordDiff(a: string, b: string): { left: DiffSpan[]; right: DiffSpan[] } {
  if (a === b) {
    return {
      left: a ? [{ kind: 'equal', text: a }] : [],
      right: b ? [{ kind: 'equal', text: b }] : [],
    };
  }
  const leftTokens = tokenize(a);
  const rightTokens = tokenize(b);
  if (leftTokens.length > MAX_DIFF_TOKENS || rightTokens.length > MAX_DIFF_TOKENS) {
    return {
      left: a ? [{ kind: 'delete', text: a }] : [],
      right: b ? [{ kind: 'insert', text: b }] : [],
    };
  }
  const ops = tokenOps(leftTokens, rightTokens);
  const left: DiffSpan[] = [];
  const right: DiffSpan[] = [];
  for (const op of ops) {
    const text = op.tokens.join('');
    if (!text) continue;
    if (op.kind === 'equal') {
      left.push({ kind: 'equal', text });
      right.push({ kind: 'equal', text });
    } else if (op.kind === 'delete') {
      left.push({ kind: 'delete', text });
    } else {
      right.push({ kind: 'insert', text });
    }
  }
  return { left: coalesceSpans(left), right: coalesceSpans(right) };
}

function mergeChangeRows(rows: AlignedLine[]): AlignedLine[] {
  const out: AlignedLine[] = [];
  let i = 0;
  while (i < rows.length) {
    const row = rows[i];
    if (!row) {
      i += 1;
      continue;
    }
    if (row.kind === 'delete' && rows[i + 1]?.kind === 'insert') {
      const next = rows[i + 1]!;
      const leftText = row.left ?? '';
      const rightText = next.right ?? '';
      const spans = wordDiff(leftText, rightText);
      out.push({
        left: leftText,
        right: rightText,
        kind: 'change',
        leftSpans: spans.left,
        rightSpans: spans.right,
      });
      i += 2;
      continue;
    }
    out.push(row);
    i += 1;
  }
  return out;
}

function fallbackAligned(left: string[], right: string[]): AlignedLine[] {
  const max = Math.max(left.length, right.length);
  const rows: AlignedLine[] = [];
  for (let i = 0; i < max; i += 1) {
    const l = left[i] ?? null;
    const r = right[i] ?? null;
    if (l === r && l !== null) {
      rows.push({
        left: l,
        right: r,
        kind: 'equal',
        leftSpans: [{ kind: 'equal', text: l }],
        rightSpans: [{ kind: 'equal', text: r }],
      });
    } else if (l !== null && r !== null) {
      const spans = wordDiff(l, r);
      rows.push({
        left: l,
        right: r,
        kind: 'change',
        leftSpans: spans.left,
        rightSpans: spans.right,
      });
    } else if (l !== null) {
      rows.push({
        left: l,
        right: null,
        kind: 'delete',
        leftSpans: [{ kind: 'delete', text: l }],
        rightSpans: [],
      });
    } else if (r !== null) {
      rows.push({
        left: null,
        right: r,
        kind: 'insert',
        leftSpans: [],
        rightSpans: [{ kind: 'insert', text: r }],
      });
    }
  }
  return rows;
}

function tokenize(text: string): string[] {
  if (!text) return [];
  return text.match(TOKEN_RE) ?? [text];
}

function tokenOps(
  a: string[],
  b: string[],
): Array<{ kind: 'equal' | 'insert' | 'delete'; tokens: string[] }> {
  const n = a.length;
  const m = b.length;
  const prev = new Array<number>(m + 1).fill(0);
  const curr = new Array<number>(m + 1).fill(0);
  const table: number[][] = [prev.slice()];
  for (let i = 1; i <= n; i += 1) {
    curr[0] = 0;
    for (let j = 1; j <= m; j += 1) {
      curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, curr[j - 1]!);
    }
    table.push(curr.slice());
    for (let j = 0; j <= m; j += 1) prev[j] = curr[j]!;
  }

  const ops: Array<{ kind: 'equal' | 'insert' | 'delete'; tokens: string[] }> = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      pushOp(ops, 'equal', a[i - 1]!);
      i -= 1;
      j -= 1;
    } else if (j > 0 && (i === 0 || (table[i]?.[j - 1] ?? 0) >= (table[i - 1]?.[j] ?? 0))) {
      pushOp(ops, 'insert', b[j - 1]!);
      j -= 1;
    } else if (i > 0) {
      pushOp(ops, 'delete', a[i - 1]!);
      i -= 1;
    } else {
      break;
    }
  }
  ops.reverse();
  for (const op of ops) op.tokens.reverse();
  return ops;
}

function pushOp(
  ops: Array<{ kind: 'equal' | 'insert' | 'delete'; tokens: string[] }>,
  kind: 'equal' | 'insert' | 'delete',
  token: string,
): void {
  const last = ops[ops.length - 1];
  if (last?.kind === kind) {
    last.tokens.push(token);
    return;
  }
  ops.push({ kind, tokens: [token] });
}

function coalesceSpans(spans: DiffSpan[]): DiffSpan[] {
  const out: DiffSpan[] = [];
  for (const span of spans) {
    const last = out[out.length - 1];
    if (last?.kind === span.kind) {
      last.text += span.text;
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

function joinBlock(lines: string[]): string {
  if (!lines.length) return '';
  return lines.join('\n') + '\n';
}

function splitBlock(block: string): string[] {
  if (!block) return [];
  const trimmed = block.endsWith('\n') ? block.slice(0, -1) : block;
  return trimmed.length ? trimmed.split('\n') : [];
}

function concatBlocks(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  const left = a.endsWith('\n') ? a : `${a}\n`;
  return left + b;
}

function normalizeBlock(block: string): string {
  if (!block) return '';
  return block.endsWith('\n') ? block : `${block}\n`;
}

function joinParts(parts: string[]): string {
  return parts.join('');
}

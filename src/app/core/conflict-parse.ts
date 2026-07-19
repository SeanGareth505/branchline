export type ConflictChoice = 'ours' | 'theirs' | 'both' | 'base';

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

const START = /^<<<<<<< ?(.*)$/;
const BASE = /^||||||| ?(.*)$/;
const MID = /^=======\s*$/;
const END = /^>>>>>>> ?(.*)$/;

export function parseConflictMarkers(raw: string): ParsedConflicts {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.length ? normalized.split('\n') : [];
  const segments: ConflictSegment[] = [];
  const conflicts: ConflictRegion[] = [];
  let textBuf: string[] = [];
  let i = 0;
  let conflictSeq = 0;

  const flushText = (): void => {
    if (!textBuf.length) return;
    segments.push({ kind: 'text', text: textBuf.join('\n') + (textBuf.length ? '\n' : '') });
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

  flushText();

  if (segments.length === 1 && segments[0]?.kind === 'text') {
    const only = segments[0].text;
    if (only.endsWith('\n') && !normalized.endsWith('\n')) {
      segments[0] = { kind: 'text', text: only.slice(0, -1) };
    }
  }

  return {
    segments,
    conflicts,
    hasMarkers: conflicts.length > 0,
  };
}

export function buildConflictResult(
  parsed: ParsedConflicts,
  choices: ReadonlyMap<string, ConflictChoice>,
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
    case 'base':
      return conflict.base;
  }
}

export function reconstructMarkers(conflict: ConflictRegion): string {
  const lines = [`<<<<<<< ${conflict.oursLabel}`];
  if (conflict.hasBase) {
    lines.push('||||||| base');
    if (conflict.base) lines.push(...splitBlock(conflict.base));
  }
  if (conflict.ours) lines.push(...splitBlock(conflict.ours));
  lines.push('=======');
  if (conflict.theirs) lines.push(...splitBlock(conflict.theirs));
  lines.push(`>>>>>>> ${conflict.theirsLabel}`);
  return lines.join('\n') + '\n';
}

export function remainingConflictIds(
  conflicts: readonly ConflictRegion[],
  choices: ReadonlyMap<string, ConflictChoice>,
): string[] {
  return conflicts.filter((c) => !choices.has(c.id)).map((c) => c.id);
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
    map.set(c.id, side);
  }
  return map;
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

function joinParts(parts: string[]): string {
  if (!parts.length) return '';
  return parts.join('');
}

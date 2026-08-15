import type { ArtificialCommit, CommitInfo } from '../../core/models';

export interface GraphLink {
  from: number;
  to: number;
  colorIndex: number;
  mergeParent?: boolean;
}

export interface GraphNode {
  id: string;
  kind: 'artificial' | 'commit';
  commit?: CommitInfo;
  artificial?: ArtificialCommit;
  lane: number;
  colorIndex: number;
  isMerge: boolean;
  isRoot: boolean;
  topLinks: GraphLink[];
  bottomLinks: GraphLink[];
}

export interface GraphLayout {
  nodes: GraphNode[];
  laneCount: number;
}

const LANE_COLORS = 8;

interface LaneSlot {
  sha: string;
  colorIndex: number;
}

function resolveParentSha(
  raw: string,
  shaSet: Set<string>,
  shortToFull: Map<string, string>,
): string | null {
  if (!raw) return null;
  if (shaSet.has(raw)) return raw;
  if (shortToFull.has(raw)) return shortToFull.get(raw)!;
  const short = raw.slice(0, 7);
  if (shortToFull.has(short)) return shortToFull.get(short)!;
  return null;
}

function pushUniqueLink(links: GraphLink[], link: GraphLink): void {
  if (links.some((l) => l.from === link.from && l.to === link.to && l.colorIndex === link.colorIndex)) {
    return;
  }
  links.push(link);
}

export function buildGraphLayout(
  artificial: ArtificialCommit[],
  commits: CommitInfo[],
): GraphLayout {
  const nodes: GraphNode[] = [];
  const shaSet = new Set(commits.map((c) => c.sha));
  const shortToFull = new Map<string, string>();
  commits.forEach((c) => {
    shortToFull.set(c.shortSha, c.sha);
    shortToFull.set(c.sha.slice(0, 7), c.sha);
  });

  artificial.forEach((a, i) => {
    const colorIndex = 0;
    nodes.push({
      id: a.id,
      kind: 'artificial',
      artificial: a,
      lane: 0,
      colorIndex,
      isMerge: false,
      isRoot: false,
      topLinks: i > 0 ? [{ from: 0, to: 0, colorIndex }] : [],
      bottomLinks: [{ from: 0, to: 0, colorIndex }],
    });
  });

  if (!commits.length) {
    return { nodes, laneCount: 1 };
  }

  const lanes: (LaneSlot | null)[] = [];
  const laneBySha = new Map<string, number>();
  let nextColor = 0;

  const nextColorIndex = (): number => {
    const c = nextColor % LANE_COLORS;
    nextColor += 1;
    return c;
  };

  const firstFree = (): number => {
    const i = lanes.findIndex((s) => s === null);
    return i === -1 ? lanes.length : i;
  };

  const ensureLane = (index: number): void => {
    while (lanes.length <= index) lanes.push(null);
  };

  const occupy = (index: number, slot: LaneSlot): void => {
    ensureLane(index);
    const prev = lanes[index];
    if (prev && laneBySha.get(prev.sha) === index) laneBySha.delete(prev.sha);
    lanes[index] = slot;
    laneBySha.set(slot.sha, index);
  };

  const clearLane = (index: number): void => {
    const prev = lanes[index];
    if (prev && laneBySha.get(prev.sha) === index) laneBySha.delete(prev.sha);
    lanes[index] = null;
  };

  if (artificial.length) {
    occupy(0, { sha: commits[0].sha, colorIndex: 0 });
    nextColor = 1;
  }

  commits.forEach((commit) => {
    const incoming: { col: number; sha: string; colorIndex: number }[] = [];
    for (let k = 0; k < lanes.length; k++) {
      const slot = lanes[k];
      if (slot) incoming.push({ col: k, sha: slot.sha, colorIndex: slot.colorIndex });
    }

    let col = laneBySha.get(commit.sha) ?? -1;
    let colorIndex: number;

    if (col < 0) {
      col = firstFree();
      colorIndex = nextColorIndex();
      ensureLane(col);
    } else {
      colorIndex = lanes[col]?.colorIndex ?? 0;
    }

    for (let k = 0; k < lanes.length; k++) {
      if (lanes[k]?.sha === commit.sha) clearLane(k);
    }

    const parents = commit.parents
      .map((raw) => ({
        raw,
        resolved: resolveParentSha(raw, shaSet, shortToFull),
      }))
      .filter((p) => p.raw.length > 0);

    const parentCols: { col: number; colorIndex: number; mergeParent: boolean }[] = [];

    parents.forEach((parent, index) => {
      const targetSha = parent.resolved ?? parent.raw;
      const mergeParent = index > 0;

      if (index === 0) {
        occupy(col, { sha: targetSha, colorIndex });
        parentCols.push({ col, colorIndex, mergeParent });
        return;
      }

      const existing = laneBySha.get(targetSha) ?? -1;
      if (existing >= 0) {
        parentCols.push({
          col: existing,
          colorIndex: lanes[existing]!.colorIndex,
          mergeParent,
        });
        return;
      }

      const pc = firstFree();
      const branchColor = nextColorIndex();
      occupy(pc, { sha: targetSha, colorIndex: branchColor });
      parentCols.push({ col: pc, colorIndex: branchColor, mergeParent });
    });

    if (!parents.length) {
      clearLane(col);
    }

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    const topLinks: GraphLink[] = [];
    for (const lane of incoming) {
      pushUniqueLink(topLinks, {
        from: lane.col,
        to: lane.sha === commit.sha ? col : lane.col,
        colorIndex: lane.colorIndex,
      });
    }

    const bottomLinks: GraphLink[] = [];
    for (const lane of incoming) {
      if (lane.sha !== commit.sha) {
        pushUniqueLink(bottomLinks, {
          from: lane.col,
          to: lane.col,
          colorIndex: lane.colorIndex,
        });
      }
    }
    for (const parent of parentCols) {
      pushUniqueLink(bottomLinks, {
        from: col,
        to: parent.col,
        colorIndex: parent.colorIndex,
        mergeParent: parent.mergeParent,
      });
    }

    nodes.push({
      id: commit.sha,
      kind: 'commit',
      commit,
      lane: col,
      colorIndex,
      isMerge: parents.length > 1,
      isRoot: parents.length === 0,
      topLinks,
      bottomLinks,
    });
  });

  let laneCount = 1;
  for (const node of nodes) {
    laneCount = Math.max(laneCount, node.lane + 1);
    for (const link of node.topLinks) {
      laneCount = Math.max(laneCount, link.from + 1, link.to + 1);
    }
    for (const link of node.bottomLinks) {
      laneCount = Math.max(laneCount, link.from + 1, link.to + 1);
    }
  }

  return { nodes, laneCount };
}

export function laneColor(index: number, styles?: CSSStyleDeclaration | null): string {
  const fallback = [
    '#3ecfff',
    '#6b9fff',
    '#e8b84a',
    '#ff7b72',
    '#5eead4',
    '#34d399',
    '#fb923c',
    '#94a3b8',
  ];
  const i = ((index % LANE_COLORS) + LANE_COLORS) % LANE_COLORS;
  if (styles) {
    const key = `--lane-${i + 1}`;
    const v = styles.getPropertyValue(key).trim();
    if (v) return v;
  }
  return fallback[i];
}

export function lanePitch(laneCount: number): number {
  const count = Math.max(1, laneCount);
  const natural = GRAPH_PAD * 2 + count * LANE_WIDTH;
  if (natural <= MAX_GRAPH_WIDTH) return LANE_WIDTH;
  return Math.max(MIN_LANE_WIDTH, (MAX_GRAPH_WIDTH - GRAPH_PAD * 2) / count);
}

export function graphWidthForLanes(laneCount: number, pitch = lanePitch(laneCount)): number {
  return Math.max(MIN_GRAPH_WIDTH, GRAPH_PAD * 2 + Math.max(1, laneCount) * pitch);
}

export function laneX(lane: number, pitch = LANE_WIDTH): number {
  return GRAPH_PAD + lane * pitch + pitch / 2;
}

export function nodeRadiusForPitch(pitch: number): number {
  return Math.min(NODE_RADIUS, Math.max(4.75, pitch * 0.36));
}

export function linkPath(
  from: number,
  to: number,
  half: 'top' | 'bottom',
  height = ROW_HEIGHT,
  pitch = LANE_WIDTH,
): string {
  const x0 = laneX(from, pitch);
  const x1 = laneX(to, pitch);
  const mid = height / 2;

  if (from === to) {
    return half === 'top' ? `M ${x0} 0 L ${x1} ${mid}` : `M ${x0} ${mid} L ${x1} ${height}`;
  }

  if (half === 'top') {
    return `M ${x0} 0 C ${x0} ${mid * 0.35}, ${x1} ${mid * 0.65}, ${x1} ${mid}`;
  }

  return `M ${x0} ${mid} C ${x0} ${mid + (height - mid) * 0.35}, ${x1} ${mid + (height - mid) * 0.65}, ${x1} ${height}`;
}

export function assertGraphContinuity(layout: GraphLayout): string[] {
  const problems: string[] = [];
  for (let i = 0; i < layout.nodes.length - 1; i++) {
    const a = layout.nodes[i];
    const b = layout.nodes[i + 1];
    const bottomLanes = new Set(a.bottomLinks.map((l) => l.to));
    const topLanes = new Set(b.topLinks.map((l) => l.from));

    for (const lane of bottomLanes) {
      if (!topLanes.has(lane)) {
        problems.push(`row ${i}→${i + 1}: bottom ends on lane ${lane} but next row has no top from that lane`);
      }
    }
    for (const lane of topLanes) {
      if (!bottomLanes.has(lane)) {
        problems.push(`row ${i}→${i + 1}: top starts on lane ${lane} but previous row has no bottom to that lane`);
      }
    }
  }
  return problems;
}

export const ROW_HEIGHT = 30;
export const LANE_WIDTH = 14;
export const MIN_LANE_WIDTH = 12;
export const GRAPH_PAD = 10;
export const NODE_RADIUS = 5;
export const NODE_RADIUS_SELECTED = 6.5;
export const MIN_GRAPH_WIDTH = 48;
export const MAX_GRAPH_WIDTH = 260;

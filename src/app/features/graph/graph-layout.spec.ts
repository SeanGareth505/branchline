import {
  GRAPH_PAD,
  LANE_WIDTH,
  MAX_GRAPH_WIDTH,
  MIN_GRAPH_WIDTH,
  MIN_LANE_WIDTH,
  NODE_RADIUS,
  buildGraphLayout,
  graphContentWidthForLanes,
  graphWidthForLanes,
  lanePitch,
  laneX,
  linkPath,
  nodeRadiusForPitch,
} from './graph-layout';

describe('graph lane metrics', () => {
  it('keeps full spacing when the graph is not crowded', () => {
    expect(lanePitch(1)).toBe(16);
    expect(lanePitch(2)).toBe(16);
    expect(lanePitch(5)).toBe(14);
    expect(graphWidthForLanes(5)).toBe(GRAPH_PAD * 2 + 5 * 14);
    expect(graphWidthForLanes(5)).toBeLessThan(MAX_GRAPH_WIDTH);
  });

  it('hugs a simple history and grows a little for a few branches', () => {
    expect(graphWidthForLanes(1)).toBe(GRAPH_PAD * 2 + 16);
    expect(graphWidthForLanes(1)).toBeLessThan(graphWidthForLanes(4));
    expect(graphWidthForLanes(2)).toBeGreaterThan(graphWidthForLanes(1));
    expect(graphWidthForLanes(5)).toBeLessThanOrEqual(MAX_GRAPH_WIDTH);
  });

  it('clamps a busy graph instead of widening into a flow diagram', () => {
    expect(graphWidthForLanes(1)).toBeGreaterThanOrEqual(MIN_GRAPH_WIDTH);
    expect(graphWidthForLanes(8)).toBe(MAX_GRAPH_WIDTH);
    expect(graphWidthForLanes(20)).toBe(MAX_GRAPH_WIDTH);
    const pitch = lanePitch(20);
    expect(pitch).toBeLessThan(LANE_WIDTH);
    expect(pitch).toBeGreaterThanOrEqual(MIN_LANE_WIDTH);
    expect(graphWidthForLanes(40)).toBe(MAX_GRAPH_WIDTH);
    expect(graphContentWidthForLanes(40, lanePitch(40))).toBeGreaterThan(MAX_GRAPH_WIDTH);
  });

  it('places lane centers from the tighter pitch', () => {
    expect(laneX(0)).toBe(GRAPH_PAD + LANE_WIDTH / 2);
    expect(laneX(2, 10)).toBe(GRAPH_PAD + 25);
  });

  it('keeps commit dots readable', () => {
    expect(nodeRadiusForPitch(LANE_WIDTH)).toBe(NODE_RADIUS);
    expect(nodeRadiusForPitch(10)).toBeGreaterThanOrEqual(4.5);
  });

  it('draws a vertical segment when a link stays in the same lane', () => {
    expect(linkPath(0, 0, 'top', 30, 10)).toBe(`M ${laneX(0, 10)} 0 L ${laneX(0, 10)} 15`);
  });
});

describe('buildGraphLayout', () => {
  it('lays out a long linear history without dropping commits', () => {
    const commits = Array.from({ length: 300 }, (_, i) => {
      const sha = shaFor(i);
      return {
        sha,
        shortSha: sha.slice(0, 7),
        message: `c${i}`,
        subject: `c${i}`,
        author: 'a',
        email: 'a@b.c',
        timestamp: 1_700_000_000 - i,
        parents: i < 299 ? [shaFor(i + 1)] : [],
        refs: i === 0 ? ['HEAD'] : [],
        laneHint: 0,
        isRelativeToHead: true,
      };
    });
    const first = buildGraphLayout([], commits.slice(0, 80));
    expect(first.nodes.length).toBe(80);
    const full = buildGraphLayout([], commits);
    expect(full.nodes.length).toBe(300);
    expect(full.laneCount).toBe(1);
  });
});

function shaFor(i: number): string {
  return i.toString(16).padStart(40, '0');
}

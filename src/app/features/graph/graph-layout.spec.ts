import {
  GRAPH_PAD,
  LANE_WIDTH,
  MAX_GRAPH_WIDTH,
  MIN_LANE_WIDTH,
  NODE_RADIUS,
  graphWidthForLanes,
  lanePitch,
  laneX,
  linkPath,
  nodeRadiusForPitch,
} from './graph-layout';

describe('graph lane metrics', () => {
  it('keeps full spacing when the graph is not crowded', () => {
    expect(lanePitch(1)).toBe(LANE_WIDTH);
    expect(lanePitch(8)).toBe(LANE_WIDTH);
    expect(graphWidthForLanes(8)).toBe(GRAPH_PAD * 2 + 8 * LANE_WIDTH);
    expect(graphWidthForLanes(8)).toBeLessThan(MAX_GRAPH_WIDTH);
  });

  it('compresses lanes only when history is extremely wide', () => {
    const pitch = lanePitch(24);
    expect(pitch).toBeLessThan(LANE_WIDTH);
    expect(pitch).toBeGreaterThanOrEqual(MIN_LANE_WIDTH);
    expect(graphWidthForLanes(8)).toBeLessThan(graphWidthForLanes(24, pitch));
  });

  it('places lane centers from the tighter pitch', () => {
    expect(laneX(0)).toBe(GRAPH_PAD + LANE_WIDTH / 2);
    expect(laneX(2, 10)).toBe(GRAPH_PAD + 25);
  });

  it('keeps commit dots readable', () => {
    expect(nodeRadiusForPitch(LANE_WIDTH)).toBe(NODE_RADIUS);
    expect(nodeRadiusForPitch(12)).toBeGreaterThanOrEqual(4.75);
  });

  it('draws a vertical segment when a link stays in the same lane', () => {
    expect(linkPath(0, 0, 'top', 30, 10)).toBe(`M ${laneX(0, 10)} 0 L ${laneX(0, 10)} 15`);
  });
});

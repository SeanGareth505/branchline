import {
  GRAPH_PAD,
  LANE_WIDTH,
  MAX_GRAPH_WIDTH,
  MIN_LANE_WIDTH,
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

  it('compresses lanes so a busy graph stays within the max column width', () => {
    const pitch = lanePitch(16);
    expect(pitch).toBeLessThan(LANE_WIDTH);
    expect(pitch).toBeGreaterThanOrEqual(MIN_LANE_WIDTH);
    expect(graphWidthForLanes(16, pitch)).toBeLessThanOrEqual(MAX_GRAPH_WIDTH);
  });

  it('places lane centers from the tighter pitch', () => {
    expect(laneX(0)).toBe(GRAPH_PAD + LANE_WIDTH / 2);
    expect(laneX(2, 10)).toBe(GRAPH_PAD + 25);
  });

  it('shrinks nodes when lanes get packed', () => {
    expect(nodeRadiusForPitch(LANE_WIDTH)).toBe(4);
    expect(nodeRadiusForPitch(6)).toBeLessThan(4);
  });

  it('draws a vertical segment when a link stays in the same lane', () => {
    expect(linkPath(0, 0, 'top', 30, 10)).toBe(`M ${laneX(0, 10)} 0 L ${laneX(0, 10)} 15`);
  });
});

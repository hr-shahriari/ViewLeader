import { describe, expect, it } from 'vitest';
import { EDGE_MARGIN, LabelPlacer, type LabelSector } from '../src/labelPlacer.js';

// Frame centred well inside an 800×600 viewport so nothing clamps against a viewport edge.
const boundary = { min: { x: 300, y: 250 }, max: { x: 500, y: 350 } };
const viewport = { x: 800, y: 600 };

describe('v1 LabelPlacer — labels railed OUTSIDE the frame', () => {
  it('places a left-sector label fully left of the frame and a right-sector label fully right', () => {
    const dims = new Map([
      ['l', { width: 100, height: 20 }],
      ['r', { width: 100, height: 20 }],
    ]);
    const results = new LabelPlacer().computePlacements(
      [
        { id: 'l', screenPos: { x: 320, y: 270 } }, // left of centre (400,300)
        { id: 'r', screenPos: { x: 480, y: 330 } }, // right of centre
      ],
      boundary,
      viewport,
      dims,
    );
    const left = results.find((r) => r.annotationId === 'l')!;
    const right = results.find((r) => r.annotationId === 'r')!;
    // Left label's RIGHT edge is still left of the frame; right label's LEFT edge is right of it.
    expect(left.position.x + 100).toBeLessThanOrEqual(boundary.min.x);
    expect(right.position.x).toBeGreaterThanOrEqual(boundary.max.x);
    expect(left.sector.endsWith('left')).toBe(true);
    expect(right.sector.endsWith('right')).toBe(true);
  });

  it('shares one column X across both labels on the same side', () => {
    const results = new LabelPlacer().computePlacements(
      [
        { id: 'a', screenPos: { x: 330, y: 270 } }, // top-left
        { id: 'b', screenPos: { x: 340, y: 330 } }, // bottom-left
      ],
      boundary,
      viewport,
    );
    const a = results.find((r) => r.annotationId === 'a')!;
    const b = results.find((r) => r.annotationId === 'b')!;
    expect(a.position.x).toBe(b.position.x);
    // Column right edge sits EDGE_MARGIN left of the frame (default label width 100).
    expect(a.position.x + 100).toBeCloseTo(boundary.min.x - EDGE_MARGIN, 5);
  });

  it('overflows labels past the frame corner with an elbow when a side is full', () => {
    // halfHeight = 50; each slot needs ~28px, so a fourth top-left label cannot fit → overflow.
    const anchors = [0, 1, 2, 3].map((i) => ({ id: `n${i}`, screenPos: { x: 320, y: 255 + i } }));
    const results = new LabelPlacer().computePlacements(anchors, boundary, viewport);
    const overflow = results.filter((r) => r.overflow);
    expect(overflow.length).toBeGreaterThan(0);
    for (const o of overflow) expect(o.overflowElbow).toBeDefined();
  });

  it('keeps a labels sector across frames via hysteresis when the anchor barely crosses centre', () => {
    const placer = new LabelPlacer();
    const first = placer.computePlacements([{ id: 'h', screenPos: { x: 390, y: 300 } }], boundary, viewport);
    const prev = new Map<string, LabelSector>(first.map((r) => [r.annotationId, r.sector]));
    expect(first[0]!.sector.endsWith('left')).toBe(true);

    // Anchor now sits 10px RIGHT of centre — within the 24px dead-band, so it must stay left.
    const sticky = placer.computePlacements(
      [{ id: 'h', screenPos: { x: 410, y: 300 } }], boundary, viewport, undefined, undefined, prev,
    );
    expect(sticky[0]!.sector.endsWith('left')).toBe(true);

    // Without the previous sector, the same anchor flips to the right side.
    const flipped = new LabelPlacer().computePlacements(
      [{ id: 'h', screenPos: { x: 410, y: 300 } }], boundary, viewport,
    );
    expect(flipped[0]!.sector.endsWith('right')).toBe(true);
  });
});

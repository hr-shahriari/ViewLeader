import { describe, expect, it } from 'vitest';
import { EDGE_MARGIN, LabelPlacer } from '../src/labelPlacer.js';

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
    expect(first[0]!.sector.endsWith('left')).toBe(true);

    // Anchor now sits 10px RIGHT of centre — within the 24px dead-band, so it must stay left.
    const sticky = placer.computePlacements([{ id: 'h', screenPos: { x: 410, y: 300 } }], boundary, viewport);
    expect(sticky[0]!.sector.endsWith('left')).toBe(true);

    // Without the previous sector, the same anchor flips to the right side.
    const flipped = new LabelPlacer().computePlacements(
      [{ id: 'h', screenPos: { x: 410, y: 300 } }], boundary, viewport,
    );
    expect(flipped[0]!.sector.endsWith('right')).toBe(true);
  });

  it('retains feasible primary and overflow membership across a subpixel depth-order crossover', () => {
    const placer = new LabelPlacer();
    const capacityFrame = { min: { x: 300, y: 200 }, max: { x: 500, y: 400 } };
    const dims = new Map(['a', 'b', 'c'].map((id) => [id, { width: 96, height: 70 }]));
    const place = (xs: readonly number[]) => Object.fromEntries(placer.computePlacements(
      ['a', 'b', 'c'].map((id, index) => ({ id, screenPos: { x: xs[index]!, y: 220 + index * 4 } })),
      capacityFrame,
      viewport,
      dims,
      undefined,
      'auto',
    ).map(({ annotationId, position, overflow }) => [annotationId, { position, overflow }]));

    const before = place([310, 310.01, 310.02]);
    const nearTie = place([310.03, 310.01, 310]);
    expect(nearTie).toEqual(before);
    expect(place([313, 310.01, 310])).toMatchObject({
      a: { overflow: true },
      c: { overflow: false },
    });
  });

  it('breaks initial exact depth ties by stable id and rechecks capacity against a changed frame', () => {
    const tied = ['c', 'a', 'b'].map((id, index) => ({ id, screenPos: { x: 310, y: 220 + index * 4 } }));
    const dims = new Map(tied.map(({ id }) => [id, { width: 96, height: 70 }]));
    const forward = new LabelPlacer().computePlacements(tied, { min: { x: 300, y: 200 }, max: { x: 500, y: 400 } }, viewport, dims);
    const reversed = new LabelPlacer().computePlacements([...tied].reverse(), { min: { x: 300, y: 200 }, max: { x: 500, y: 400 } }, viewport, dims);
    expect(reversed).toEqual(forward);
    expect(forward.map(({ annotationId }) => annotationId)).toEqual(['a', 'b', 'c']);

    const narrow = new LabelPlacer();
    narrow.computePlacements(tied, { min: { x: 300, y: 200 }, max: { x: 500, y: 400 } }, viewport, dims);
    const replanned = narrow.computePlacements(tied, { min: { x: 300, y: 250 }, max: { x: 500, y: 350 } }, viewport, dims);
    expect(replanned.filter(({ overflow }) => !overflow)).toHaveLength(1);
  });

  it('restores capacity membership after temporary absence and releases it when forgotten', () => {
    const placer = new LabelPlacer();
    const capacityFrame = { min: { x: 300, y: 200 }, max: { x: 500, y: 400 } };
    const dims = new Map(['a', 'b', 'c'].map((id) => [id, { width: 96, height: 70 }]));
    const anchors = (xs: readonly number[]) => ['a', 'b', 'c'].map((id, index) => ({
      id,
      screenPos: { x: xs[index]!, y: 220 + index * 4 },
    }));
    const initial = placer.computePlacements(anchors([310, 310.01, 310.02]), capacityFrame, viewport, dims, undefined, 'auto');
    placer.computePlacements([], capacityFrame, viewport, dims, undefined, 'auto');
    expect(placer.computePlacements(anchors([310.03, 310.01, 310]), capacityFrame, viewport, dims, undefined, 'auto')).toEqual(initial);
    placer.computePlacements(anchors([310, 310.01, 310.02]).slice(1), capacityFrame, viewport, dims, undefined, 'auto');
    expect(placer.computePlacements(anchors([310.03, 310.01, 310]), capacityFrame, viewport, dims, undefined, 'auto')).toEqual(initial);

    placer.forget(new Set(['b', 'c']));
    placer.computePlacements(anchors([310.03, 310.01, 310]).slice(1), capacityFrame, viewport, dims, undefined, 'auto');
    const returnedAsNew = placer.computePlacements(anchors([313, 310.01, 310]), capacityFrame, viewport, dims, undefined, 'auto');
    expect(returnedAsNew.find(({ annotationId }) => annotationId === 'a')!.overflow).toBe(true);
  });

  it('keeps absent labels through an all-offscreen frame and forgets deleted labels explicitly', () => {
    const placer = new LabelPlacer();
    const visible = { id: 'visible', screenPos: { x: 480, y: 300 } };
    const returning = { id: 'returning', screenPos: { x: 390, y: 300 } };
    placer.computePlacements([returning, visible], boundary, viewport);

    // `returning` leaves the arrangement while another automatic label remains. Its side still
    // matters when it comes back within the dead-band.
    placer.computePlacements([visible], boundary, viewport);
    expect(placer.computePlacements([
      { ...returning, screenPos: { x: 410, y: 300 } },
      visible,
    ], boundary, viewport).find((result) => result.annotationId === returning.id)!.sector.endsWith('left')).toBe(true);

    placer.forget(new Set([visible.id]));
    const afterForget = placer.computePlacements([
      { ...returning, screenPos: { x: 410, y: 300 } },
      { ...visible, screenPos: { x: 390, y: 300 } },
    ], boundary, viewport);
    expect(afterForget.find((result) => result.annotationId === returning.id)!.sector.endsWith('right')).toBe(true);
    expect(afterForget.find((result) => result.annotationId === visible.id)!.sector.endsWith('right')).toBe(true);

    const cleared = new LabelPlacer();
    cleared.computePlacements([returning], boundary, viewport);
    cleared.computePlacements([], boundary, viewport);
    expect(cleared.computePlacements([
      { ...returning, screenPos: { x: 410, y: 300 } },
    ], boundary, viewport)[0]!.sector.endsWith('left')).toBe(true);
    cleared.forget(new Set());
    expect(cleared.computePlacements([
      { ...returning, screenPos: { x: 410, y: 300 } },
    ], boundary, viewport)[0]!.sector.endsWith('right')).toBe(true);
  });

  it('remembers the final sector after uncrossing a row', () => {
    const placer = new LabelPlacer();
    const dims = new Map([
      ['0', { width: 72, height: 16 }],
      ['1', { width: 43, height: 66 }],
      ['2', { width: 60, height: 15 }],
      ['3', { width: 52, height: 73 }],
      ['4', { width: 90, height: 77 }],
      ['5', { width: 59, height: 66 }],
      ['6', { width: 112, height: 43 }],
      ['7', { width: 105, height: 67 }],
    ]);

    // Seed the remembered sectors through the production method, one id per frame so a seeding
    // frame cannot itself swap two sectors. Absent ids deliberately stay remembered.
    for (const anchor of [
      { id: '0', screenPos: { x: 450, y: 260 } }, // top-right
      { id: '1', screenPos: { x: 350, y: 260 } }, // top-left
      { id: '2', screenPos: { x: 450, y: 340 } }, // bottom-right
      { id: '3', screenPos: { x: 460, y: 220 } }, // top-right
      { id: '4', screenPos: { x: 340, y: 220 } }, // top-left
      { id: '5', screenPos: { x: 470, y: 280 } }, // top-right
      { id: '6', screenPos: { x: 460, y: 380 } }, // bottom-right
      { id: '7', screenPos: { x: 360, y: 280 } }, // top-left
    ]) placer.computePlacements([anchor], boundary, viewport, dims, undefined, 'auto');

    const settled = placer.computePlacements([
      { id: '0', screenPos: { x: 590.4560505412519, y: 299.3066341849044 } },
      { id: '1', screenPos: { x: 391.9607372954488, y: 123.23957548942417 } },
      { id: '2', screenPos: { x: 366.9106242246926, y: 507.02365844044834 } },
      { id: '3', screenPos: { x: 607.7194884419441, y: 485.94967562239617 } },
      { id: '4', screenPos: { x: 402.2192264907062, y: 216.34602204430848 } },
      { id: '5', screenPos: { x: 376.4527468010783, y: 425.0082071637735 } },
      { id: '6', screenPos: { x: 284.8759197629988, y: 326.65357443038374 } },
      { id: '7', screenPos: { x: 590.8152651041746, y: 67.32359162997454 } },
    ], boundary, viewport, dims, undefined, 'auto');
    expect(settled.find((result) => result.annotationId === '2')!.sector).toBe('bottom-right');
    expect(settled.find((result) => result.annotationId === '5')!.sector).toBe('bottom-left');

    // This is inside both hysteresis bands. A pre-uncross record would leave id 2 bottom-left;
    // observing it alone means this frame cannot perform a second swap and hide that regression.
    expect(placer.computePlacements([
      { id: '2', screenPos: { x: 410, y: 310 } },
    ], boundary, viewport, dims, undefined, 'auto')[0]!.sector).toBe('bottom-right');
  });
});

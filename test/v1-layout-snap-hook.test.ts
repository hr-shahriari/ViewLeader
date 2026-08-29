/** @vitest-environment jsdom */
// Ticket 06: `strategies.snap` — one hook, consulted at both automatic-placement call sites
// (`#placeAroundFrame`, the one placement path since phase 2.3) and at the ticket-01 label drag's
// preview, so a host with building gridlines can make labels obey them.
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type LayoutStrategies,
  type NormalizedPointerInput,
} from '../src/index.js';
import type { Vec2 } from '../src/types.js';

const VIEWPORT = { width: 800, height: 600 };
// World → screen: (400 + x*10, 300 - y*10). Origin projects to the viewport centre, (400, 300).
const ORIGIN = { x: 0, y: 0, z: 0 };
const FRAME = { x: 350, y: 250, width: 100, height: 100 };

function adapters(overrides: Partial<HostAdapterBundle> = {}): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
      project: (point) => ({
        point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
        depth: point.z,
        visible: true,
      }),
    },
    ...overrides,
  };
}

function note(id: string, position?: Vec2, anchor: Vec2 & { z: number } = ORIGIN): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: anchor },
    content: { kind: 'plain-note', text: id },
    ...(position === undefined ? {} : { placement: { kind: 'manual' as const, position } }),
  };
}

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function makeLeader(strategies?: LayoutStrategies): ViewLeader {
  return new ViewLeader({
    boundary: boundary(),
    adapters: adapters(),
    ...(strategies === undefined ? {} : { strategies }),
  });
}

function at(x: number, y: number): NormalizedPointerInput {
  return {
    x: x / VIEWPORT.width,
    y: y / VIEWPORT.height,
    button: 0,
    buttons: 1,
    pointerType: 'mouse',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };
}

describe('strategies.snap — no hook configured', () => {
  it('is byte-identical to an identity snap: the hook changes nothing when absent', () => {
    const plain = makeLeader();
    plain.annotations.create(note('a1'));
    plain.update();
    const plainLabel = plain.geometry.of('a1')!.label;
    const plainLegs = plain.geometry.of('a1')!.legs;
    plain.dispose();

    const identity = makeLeader({ snap: (proposed) => ({ x: proposed.x, y: proposed.y }) });
    identity.annotations.create(note('a1'));
    identity.update();
    expect(identity.geometry.of('a1')!.label).toEqual(plainLabel);
    expect(identity.geometry.of('a1')!.legs).toEqual(plainLegs);
    identity.dispose();
  });
});

describe('strategies.snap — automatic placement, no drawn layout frame', () => {
  it('puts every automatically-placed label at a fixed point', () => {
    const leader = makeLeader({ snap: () => ({ x: 999, y: 111 }) });
    leader.annotations.create(note('a1'));
    leader.annotations.create(note('a2', undefined, { x: 5, y: 0, z: 0 }));
    leader.update();
    expect(leader.geometry.of('a1')!.label).toMatchObject({ x: 999, y: 111 });
    expect(leader.geometry.of('a2')!.label).toMatchObject({ x: 999, y: 111 });
    leader.dispose();
  });

  it('leaves an existing manual placement untouched — only automatic labels are offered to snap', () => {
    const leader = makeLeader({ snap: () => ({ x: 999, y: 111 }) });
    leader.annotations.create(note('auto'));
    leader.annotations.create(note('manual', { x: 40, y: 60 }));
    leader.update();
    expect(leader.geometry.of('auto')!.label).toMatchObject({ x: 999, y: 111 });
    expect(leader.geometry.of('manual')!.label).toMatchObject({ x: 40, y: 60 });
    leader.dispose();
  });

  it('passes the annotation id, its label size, and its screen anchor — nothing else', () => {
    let seenCtx: unknown;
    const leader = makeLeader({
      snap: (proposed, ctx) => {
        seenCtx = ctx;
        return proposed;
      },
    });
    leader.annotations.create(note('a1'));
    leader.update();
    const label = leader.geometry.of('a1')!.label;
    expect(seenCtx).toMatchObject({
      id: 'a1',
      labelSize: { width: label.width, height: label.height },
      anchor: { x: 400, y: 300 },
    });
    expect(Object.keys(seenCtx as object).sort()).toEqual(['anchor', 'id', 'labelSize']);
    leader.dispose();
  });

  it('hands out frozen copies: writing to `proposed` or `ctx` cannot move layout', () => {
    let attempted = 0;
    const leader = makeLeader({
      snap: (proposed, ctx) => {
        attempted += 1;
        expect(Object.isFrozen(proposed)).toBe(true);
        expect(Object.isFrozen(ctx)).toBe(true);
        expect(Object.isFrozen(ctx.anchor)).toBe(true);
        expect(Object.isFrozen(ctx.labelSize)).toBe(true);
        expect(() => { (proposed as { x: number }).x = 12345; }).toThrow();
        expect(() => { (ctx.anchor as { x: number }).x = 12345; }).toThrow();
        return { x: proposed.x, y: proposed.y };
      },
    });
    leader.annotations.create(note('a1'));
    leader.update();
    expect(attempted).toBeGreaterThan(0);
    leader.dispose();
  });
});

describe('strategies.snap — automatic placement, with a layout frame (#placeAroundFrame)', () => {
  it('puts every automatically-placed label at a fixed point on the LabelPlacer path too', () => {
    const leader = makeLeader({ snap: () => ({ x: 999, y: 111 }) });
    leader.setLayoutFrame({ rect: FRAME, unit: 'pixels' });
    leader.annotations.create(note('left', undefined, { x: -3, y: 0, z: 0 }));
    leader.annotations.create(note('right', undefined, { x: 3, y: 0, z: 0 }));
    leader.update();
    expect(leader.geometry.of('left')!.label).toMatchObject({ x: 999, y: 111 });
    expect(leader.geometry.of('right')!.label).toMatchObject({ x: 999, y: 111 });
    leader.dispose();
  });
});

describe('strategies.snap — host code is untrusted', () => {
  it('a throwing snap is isolated: a diagnostic, and layout falls back to the unsnapped proposal', () => {
    const unsnappedLeader = makeLeader();
    unsnappedLeader.annotations.create(note('a1'));
    unsnappedLeader.update();
    const unsnapped = unsnappedLeader.geometry.of('a1')!.label;
    unsnappedLeader.dispose();

    const leader = makeLeader({
      snap: () => { throw new Error('gridline lookup failed'); },
    });
    leader.annotations.create(note('a1'));
    leader.update();
    expect(leader.geometry.of('a1')!.label).toEqual(unsnapped);
    const diagnostics = leader.diagnostics.getSnapshot();
    expect(diagnostics).toContainEqual(expect.objectContaining({
      code: 'SNAP_STRATEGY_FAILED',
      severity: 'warning',
      annotationId: 'a1',
    }));
    leader.dispose();
  });

  it('a non-finite result is rejected the same way', () => {
    const leader = makeLeader({ snap: () => ({ x: Number.NaN, y: 5 }) });
    leader.annotations.create(note('a1'));
    leader.update();
    const label = leader.geometry.of('a1')!.label;
    expect(Number.isFinite(label.x)).toBe(true);
    expect(Number.isFinite(label.y)).toBe(true);
    expect(leader.diagnostics.getSnapshot()).toContainEqual(expect.objectContaining({
      code: 'SNAP_STRATEGY_FAILED',
      severity: 'warning',
      annotationId: 'a1',
    }));
    leader.dispose();
  });

  it('a malformed (non-Vec2) result is rejected the same way', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const leader = makeLeader({ snap: () => ('not a point' as any) });
    leader.annotations.create(note('a1'));
    expect(() => leader.update()).not.toThrow();
    expect(leader.diagnostics.getSnapshot()).toContainEqual(expect.objectContaining({
      code: 'SNAP_STRATEGY_FAILED',
    }));
    leader.dispose();
  });

  it('one throwing annotation does not blank the rest of the overlay', () => {
    const leader = makeLeader({
      snap: (proposed, ctx) => {
        if (ctx.id === 'boom') throw new Error('boom');
        return { x: 999, y: 111 };
      },
    });
    leader.annotations.create(note('boom'));
    leader.annotations.create(note('fine', undefined, { x: 5, y: 0, z: 0 }));
    leader.update();
    expect(leader.geometry.of('boom')).not.toBeUndefined();
    expect(leader.geometry.of('fine')!.label).toMatchObject({ x: 999, y: 111 });
    leader.dispose();
  });
});

describe('strategies.snap — hysteresis (no placement jitter)', () => {
  it('repeated updates with nothing changed keep the exact same snapped position (no frame)', () => {
    const leader = makeLeader({
      snap: (p) => ({ x: Math.round(p.x / 50) * 50, y: Math.round(p.y / 50) * 50 }),
    });
    leader.annotations.create(note('a1'));
    leader.update();
    const first = leader.geometry.of('a1')!.label;
    leader.update();
    const second = leader.geometry.of('a1')!.label;
    leader.update();
    const third = leader.geometry.of('a1')!.label;
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    leader.dispose();
  });

  it('repeated updates with nothing changed keep the exact same snapped position (with a frame)', () => {
    const leader = makeLeader({
      snap: (p) => ({ x: Math.round(p.x / 50) * 50, y: Math.round(p.y / 50) * 50 }),
    });
    leader.setLayoutFrame({ rect: FRAME, unit: 'pixels' });
    leader.annotations.create(note('left', undefined, { x: -3, y: 0, z: 0 }));
    leader.update();
    const first = leader.geometry.of('left')!.label;
    leader.update();
    const second = leader.geometry.of('left')!.label;
    expect(second).toEqual(first);
    leader.dispose();
  });
});

describe('strategies.snap — the ticket-01 label drag', () => {
  // What this pins is a drop-time equality: the point the preview drew and the point the commit
  // stored are the same snapped point. It is only a drop-time claim now that a drag stores its
  // anchor — on any later frame the label is re-measured against that anchor and drifts off the
  // host's grid as the camera moves, which `#applyLayoutSnap` documents as deliberate.
  it('the drag preview and the committed position are the same snapped point at drop', () => {
    const leader = makeLeader({
      snap: (p) => ({ x: Math.round(p.x / 50) * 50, y: Math.round(p.y / 50) * 50 }),
    });
    leader.annotations.create(note('a1', { x: 512, y: 383 }));
    leader.update();
    leader.editing.pointerDown(at(512, 383));
    leader.editing.pointerMove(at(561, 417));
    leader.update();

    const previewed = leader.geometry.of('a1')!.label;
    expect(previewed).toMatchObject({ x: 550, y: 400 });

    leader.editing.pointerUp(at(561, 417));
    const committed = leader.annotations.get('a1')!.placement;
    expect(committed).toEqual({
      kind: 'manual',
      position: { x: previewed.x, y: previewed.y },
      anchor: { x: 400, y: 300 },
    });
    leader.dispose();
  });

  it('a throwing snap during a drag falls back to the unsnapped preview, and the drag still completes', () => {
    const leader = makeLeader({ snap: () => { throw new Error('boom'); } });
    leader.annotations.create(note('a1', { x: 500, y: 380 }));
    leader.update();
    leader.editing.pointerDown(at(510, 390));
    leader.editing.pointerMove(at(560, 420));
    leader.update();
    expect(leader.geometry.of('a1')!.label).toMatchObject({ x: 550, y: 410 });
    leader.editing.pointerUp(at(560, 420));
    expect(leader.annotations.get('a1')!.placement).toEqual({
      kind: 'manual',
      position: { x: 550, y: 410 },
      anchor: { x: 400, y: 300 },
    });
    expect(leader.diagnostics.getSnapshot()).toContainEqual(expect.objectContaining({
      code: 'SNAP_STRATEGY_FAILED',
    }));
    leader.dispose();
  });
});

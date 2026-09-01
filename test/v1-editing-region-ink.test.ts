/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  validateInk,
  validateRegionAnchor,
  type AnnotationDraft,
  type HostAdapterBundle,
  type NormalizedPointerInput,
  type RegionAnchor,
  type SurfacePickResult,
} from '../src/index.js';
import { regionAnchorFromCore, type InkAnnotation } from '../src/markup.js';
import type { Vec2, Vec3 } from '../src/types.js';

const VIEWPORT = { width: 800, height: 600 };

/** Orthographic: world x,y → screen, z dropped. Local plane units are 10 px each on a flat plane. */
function projectionAt(offset = 0): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
      project: (point: Vec3) => ({
        point: { x: 400 + offset + point.x * 10, y: 300 - point.y * 10 },
        depth: point.z,
        visible: true,
      }),
    },
  };
}

/** The world XY plane, seen face on: local (u,v) → screen (400 + 10u, 300 − 10v). */
const FLAT = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xAxis: { x: 1, y: 0, z: 0 },
};

/**
 * A plane tilted 60° away from the camera. Its y axis is (0, cos60, sin60), so the orthographic
 * projection above squashes one plane unit of v into 5 screen pixels instead of 10 — a screen drag
 * read as a plane delta is off by a factor of two unless it is actually projected back.
 */
const OBLIQUE = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: -Math.sin(Math.PI / 3), z: Math.cos(Math.PI / 3) },
  xAxis: { x: 1, y: 0, z: 0 },
};

function regionNote(
  id: string,
  plane: typeof FLAT,
  shape: RegionAnchor['shape'],
  vertices: readonly Vec2[],
): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'region', plane, vertices, shape, fallbackPoint: { x: 0, y: 0, z: 0 } },
    content: { kind: 'plain-note', text: 'Area' },
    placement: { kind: 'manual', position: { x: 640, y: 480 } },
  };
}

/** A 20 × 10 rectangle centred on the plane origin. */
const RECTANGLE: readonly Vec2[] = [
  { x: -10, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: -10, y: 5 },
];

/** A 20 × 20 square, authored as a polygon so its vertices are editable. */
const SQUARE: readonly Vec2[] = [
  { x: -10, y: -10 }, { x: 10, y: -10 }, { x: 10, y: 10 }, { x: -10, y: 10 },
];

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

function makeLeader(options: {
  handles?: 'core' | 'none';
  surfacePicking?: SurfacePickResult | null;
} = {}): { leader: ViewLeader; root: HTMLElement } {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const adapters: HostAdapterBundle = options.surfacePicking === undefined
    ? projectionAt()
    : {
      ...projectionAt(),
      surfacePicking: { pickSurface: async () => options.surfacePicking ?? null },
    };
  const leader = new ViewLeader({
    boundary: root,
    adapters,
    ...(options.handles === undefined ? {} : { editing: { handles: options.handles } }),
  });
  return { leader, root };
}

/** The stored region anchor, back in its own plane coordinates. */
function region(leader: ViewLeader, id: string, legIndex = 0): ReturnType<typeof regionAnchorFromCore> {
  const anchor = leader.annotations.get(id)!.anchors[legIndex]!.anchor;
  if (anchor.kind !== 'region') throw new Error('leg is not a region');
  return regionAnchorFromCore(anchor);
}

function vertices(leader: ViewLeader, id: string): readonly Vec2[] {
  const geometry = region(leader, id).geometry;
  if (geometry.kind !== 'polygon' && geometry.kind !== 'revision-cloud') {
    throw new Error('geometry has no vertices');
  }
  return geometry.vertices;
}

function drag(leader: ViewLeader, from: Vec2, to: Vec2): void {
  leader.editing.pointerDown(at(from.x, from.y));
  leader.editing.pointerMove(at(to.x, to.y));
  leader.update();
  leader.editing.pointerUp(at(to.x, to.y));
  leader.update();
}

/** Drags region handle `index` from its published position to `to`. */
function dragRegionHandle(leader: ViewLeader, id: string, index: number, to: Vec2): void {
  const handle = leader.geometry.of(id)!.regionHandles[index]!;
  leader.editing.beginRegionHandleDrag(id, index, at(handle.at.x, handle.at.y));
  leader.editing.pointerMove(at(to.x, to.y));
  leader.update();
  leader.editing.pointerUp(at(to.x, to.y));
  leader.update();
}

/** Commits an ink stroke through the public markup tool, which is the only way to create one. */
function createInk(leader: ViewLeader, id: string, points: readonly Vec2[]): InkAnnotation {
  const markup = leader.authoring.markup;
  // Ink carries a full `DrawingPlane`; a region anchor carries the core three-field form instead.
  void markup.start({ kind: 'ink', commit: { id }, plane: { ...FLAT, yAxis: { x: 0, y: 1, z: 0 } } });
  for (const point of points) markup.appendInkPoint(point);
  markup.complete();
  return markup.getInk(id)!;
}

describe('region grips: what is published', () => {
  it('publishes four corners and four sides for a rectangle, on its drawn outline', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'rectangle', RECTANGLE));
    leader.update();
    const handles = leader.geometry.of('a1')!.regionHandles;
    expect(handles).toHaveLength(8);
    expect(handles.every((handle) => handle.kind === 'extent')).toBe(true);

    // Local (10, 5) projects to (500, 250); its grab is the +x +y corner.
    const corner = handles.find((handle) =>
      handle.kind === 'extent' && handle.grab.x === 1 && handle.grab.y === 1)!;
    expect(corner.at).toMatchObject({ x: 500, y: 250 });
    const side = handles.find((handle) =>
      handle.kind === 'extent' && handle.grab.x === 1 && handle.grab.y === 0)!;
    expect(side.at).toMatchObject({ x: 500, y: 300 });
    leader.dispose();
  });

  it('publishes a vertex and a midpoint per polygon vertex, and no extent grips', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'polygon', SQUARE));
    leader.update();
    const handles = leader.geometry.of('a1')!.regionHandles;
    expect(handles.filter(({ kind }) => kind === 'vertex')).toHaveLength(4);
    expect(handles.filter(({ kind }) => kind === 'midpoint')).toHaveLength(4);
    expect(handles.filter(({ kind }) => kind === 'extent')).toHaveLength(0);
    // Vertex grip i sits on the projection of plane vertex i.
    const first = handles.find((handle) => handle.kind === 'vertex' && handle.index === 0)!;
    expect(first.at).toMatchObject({ x: 300, y: 400 });
    leader.dispose();
  });

  it('draws a filled circle for an extent grip, on the published point', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'rectangle', RECTANGLE));
    leader.annotations.select(['a1']);
    leader.update();
    const drawn = [...root.querySelectorAll('circle[data-region-handle="extent"]')];
    expect(drawn).toHaveLength(8);
    const published = leader.geometry.of('a1')!.regionHandles;
    for (const grip of drawn) {
      const centre = { x: Number(grip.getAttribute('cx')), y: Number(grip.getAttribute('cy')) };
      expect(published.some((handle) =>
        Math.abs(handle.at.x - centre.x) < 5e-4 && Math.abs(handle.at.y - centre.y) < 5e-4)).toBe(true);
      expect(grip.getAttribute('fill')).not.toBe('none');
    }
    leader.dispose();
  });

  it('hides region grips until selected, and draws none when the host opts out', () => {
    const { leader, root } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'polygon', SQUARE));
    leader.update();
    expect((root.querySelector('[data-region-handles]') as SVGElement).style.display).toBe('none');
    leader.annotations.select(['a1']);
    expect((root.querySelector('[data-region-handles]') as SVGElement).style.display).toBe('');
    leader.dispose();

    const opted = makeLeader({ handles: 'none' });
    opted.leader.annotations.create(regionNote('a1', FLAT, 'polygon', SQUARE));
    opted.leader.annotations.select(['a1']);
    opted.leader.update();
    expect(opted.root.querySelectorAll('[data-region-handle]')).toHaveLength(0);
    // Published either way, so a host that opted out can draw and drive its own.
    expect(opted.leader.geometry.of('a1')!.regionHandles.length).toBeGreaterThan(0);
    opted.leader.dispose();
  });
});

describe('region grips: resizing', () => {
  it('a corner drag resizes the region and pins the opposite corner', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'rectangle', RECTANGLE));
    leader.annotations.select(['a1']);
    leader.update();
    const index = leader.geometry.of('a1')!.regionHandles.findIndex((handle) =>
      handle.kind === 'extent' && handle.grab.x === 1 && handle.grab.y === 1);

    // Screen (500, 250) → (550, 200): +5, +5 in plane units, so the corner lands on (15, 10).
    dragRegionHandle(leader, 'a1', index, { x: 550, y: 200 });

    const geometry = region(leader, 'a1').geometry;
    expect(geometry.kind).toBe('rectangle');
    expect(geometry).toMatchObject({ width: 25, height: 15 });
    expect((geometry as { center: Vec2 }).center.x).toBeCloseTo(2.5, 6);
    expect((geometry as { center: Vec2 }).center.y).toBeCloseTo(2.5, 6);
    leader.dispose();
  });

  it('leaves the region coplanar with the drawing plane it started on', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', OBLIQUE, 'rectangle', RECTANGLE));
    leader.annotations.select(['a1']);
    leader.update();
    const before = region(leader, 'a1').plane;
    const index = leader.geometry.of('a1')!.regionHandles.findIndex((handle) =>
      handle.kind === 'extent' && handle.grab.x === 1 && handle.grab.y === 1);

    dragRegionHandle(leader, 'a1', index, { x: 560, y: 210 });

    expect(region(leader, 'a1').plane).toEqual(before);
    validateRegionAnchor(region(leader, 'a1'));
    leader.dispose();
  });

  it('a side drag changes one extent and leaves the other alone', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'rectangle', RECTANGLE));
    leader.annotations.select(['a1']);
    leader.update();
    const index = leader.geometry.of('a1')!.regionHandles.findIndex((handle) =>
      handle.kind === 'extent' && handle.grab.x === 1 && handle.grab.y === 0);

    // Pulling the +x side out by 50 px is 5 plane units: width 20 → 25, height untouched.
    dragRegionHandle(leader, 'a1', index, { x: 550, y: 300 });

    expect(region(leader, 'a1').geometry).toMatchObject({ width: 25, height: 10 });
    leader.dispose();
  });

  it('refuses a degenerate resize through the existing validation rather than persisting it', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'rectangle', RECTANGLE));
    leader.annotations.select(['a1']);
    leader.update();
    const before = leader.annotations.get('a1')!;
    const undoCount = leader.history.getSnapshot().undoCount;
    const index = leader.geometry.of('a1')!.regionHandles.findIndex((handle) =>
      handle.kind === 'extent' && handle.grab.x === 1 && handle.grab.y === 0);

    // Dragging the +x side onto the pinned −x side is exactly zero width.
    dragRegionHandle(leader, 'a1', index, { x: 300, y: 300 });

    expect(leader.annotations.get('a1')).toEqual(before);
    expect(leader.history.getSnapshot().undoCount).toBe(undoCount);
    expect(leader.diagnostics.getSnapshot().map(({ code }) => code)).toContain('EDITING_EDIT_FAILED');
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });
});

describe('region grips: moving on its own plane', () => {
  it('moves a region along the plane, not across the screen, when the plane is oblique', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', OBLIQUE, 'rectangle', RECTANGLE));
    leader.update();

    // The outline's top edge is at screen y = 275 on this plane; grab it away from any grip.
    drag(leader, { x: 380, y: 275 }, { x: 410, y: 225 });

    const geometry = region(leader, 'a1').geometry as { center: Vec2; width: number; height: number };
    // +30 px of x is +3 plane units; −50 px of y is +10 plane units, because v is foreshortened by
    // cos 60° = 0.5. Reading the screen delta as a plane delta would have given +5.
    expect(geometry.center.x).toBeCloseTo(3, 6);
    expect(geometry.center.y).toBeCloseTo(10, 6);
    // A rectangle stays a rectangle: only the centre moved.
    expect(geometry.width).toBeCloseTo(20, 9);
    expect(geometry.height).toBeCloseTo(10, 9);
    leader.dispose();
  });

  it('is one undo step, and reopens identically from a saved document', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', OBLIQUE, 'rectangle', RECTANGLE));
    leader.update();
    const undoCount = leader.history.getSnapshot().undoCount;

    drag(leader, { x: 380, y: 275 }, { x: 410, y: 225 });

    expect(leader.history.getSnapshot().undoCount).toBe(undoCount + 1);
    expect(leader.history.getSnapshot().undoLabel).toBe('Edit region');
    const moved = leader.annotations.get('a1')!;
    const serialized = leader.documents.serialize();
    leader.history.undo();
    expect(region(leader, 'a1').geometry).toMatchObject({ center: { x: 0, y: 0 } });
    leader.dispose();

    const reopened = makeLeader();
    reopened.leader.documents.replace(serialized);
    expect(reopened.leader.annotations.get('a1')).toEqual(moved);
    reopened.leader.dispose();
  });

  it('previews without touching the document, and cancel restores the drawn outline', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'rectangle', RECTANGLE));
    leader.update();
    const before = leader.annotations.get('a1')!;

    leader.editing.pointerDown(at(400, 250));
    leader.editing.pointerMove(at(500, 250));
    leader.update();
    expect(leader.geometry.of('a1')!.regionHandles[0]!.at.x).toBeCloseTo(400, 3);
    expect(leader.annotations.get('a1')).toEqual(before);

    leader.editing.cancel('escape');
    leader.update();
    expect(leader.geometry.of('a1')!.regionHandles[0]!.at.x).toBeCloseTo(300, 3);
    expect(leader.annotations.get('a1')).toEqual(before);
    leader.dispose();
  });

  it('survives camera orbit, because the region is stored in plane coordinates', () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    let offset = 0;
    const leader = new ViewLeader({
      boundary: root,
      adapters: {
        projection: {
          getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
          project: (point: Vec3) => ({
            point: { x: 400 + offset + point.x * 10, y: 300 - point.y * 10 },
            depth: point.z,
            visible: true,
          }),
        },
      },
    });
    leader.annotations.create(regionNote('a1', FLAT, 'rectangle', RECTANGLE));
    leader.update();
    drag(leader, { x: 400, y: 250 }, { x: 450, y: 250 });
    expect(region(leader, 'a1').geometry).toMatchObject({ center: { x: 5, y: 0 } });

    offset = 100;
    leader.update();
    const corner = leader.geometry.of('a1')!.regionHandles.find((handle) =>
      handle.kind === 'extent' && handle.grab.x === 1 && handle.grab.y === 1)!;
    expect(corner.at).toMatchObject({ x: 650, y: 250 });
    leader.dispose();
  });
});

describe('region grips: polygon vertices', () => {
  it('a vertex drag moves that vertex and no other', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'polygon', SQUARE));
    leader.annotations.select(['a1']);
    leader.update();
    const index = leader.geometry.of('a1')!.regionHandles.findIndex((handle) =>
      handle.kind === 'vertex' && handle.index === 0);

    // Vertex 0 draws at (300, 400); +20, −20 px is +2, +2 plane units.
    dragRegionHandle(leader, 'a1', index, { x: 320, y: 380 });

    const result = vertices(leader, 'a1');
    expect(result).toHaveLength(4);
    expect(result[0]!.x).toBeCloseTo(-8, 6);
    expect(result[0]!.y).toBeCloseTo(-8, 6);
    expect(result.slice(1)).toEqual(SQUARE.slice(1));
    leader.dispose();
  });

  it('a segment midpoint drag adds exactly one vertex, and the polygon stays valid', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'polygon', SQUARE));
    leader.annotations.select(['a1']);
    leader.update();
    const index = leader.geometry.of('a1')!.regionHandles.findIndex((handle) =>
      handle.kind === 'midpoint' && handle.index === 1);

    // Midpoint 1 lies between vertices 0 and 1, at screen (400, 400).
    dragRegionHandle(leader, 'a1', index, { x: 400, y: 370 });

    const result = vertices(leader, 'a1');
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual(SQUARE[0]);
    expect(result[1]!.x).toBeCloseTo(0, 6);
    expect(result[1]!.y).toBeCloseTo(-7, 6);
    expect(result[2]).toEqual(SQUARE[1]);
    expect(() => validateRegionAnchor(region(leader, 'a1'))).not.toThrow();
    leader.dispose();
  });

  it('inserts once, however many pointer moves the drag takes', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'polygon', SQUARE));
    leader.annotations.select(['a1']);
    leader.update();
    const index = leader.geometry.of('a1')!.regionHandles.findIndex((handle) =>
      handle.kind === 'midpoint' && handle.index === 1);
    const handle = leader.geometry.of('a1')!.regionHandles[index]!;

    leader.editing.beginRegionHandleDrag('a1', index, at(handle.at.x, handle.at.y));
    for (const step of [10, 20, 30, 40]) {
      leader.editing.pointerMove(at(handle.at.x, handle.at.y - step));
    }
    leader.editing.pointerUp(at(handle.at.x, handle.at.y - 40));

    const result = vertices(leader, 'a1');
    expect(result).toHaveLength(5);
    // The drop is 40 px above the midpoint, which is 4 plane units — not 4 + every step before it.
    expect(result[1]!.y).toBeCloseTo(-6, 6);
    leader.dispose();
  });

  it('an unknown region handle index starts nothing', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'polygon', SQUARE));
    leader.update();
    leader.editing.beginRegionHandleDrag('a1', 99, at(400, 300));
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });

  it('a region grip beats the leg anchor grip they share a pixel with', () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'polygon', SQUARE));
    leader.annotations.select(['a1']);
    leader.update();
    const vertex = leader.geometry.of('a1')!.regionHandles.find(({ kind }) => kind === 'vertex')!;
    expect(leader.editing.hitTest(at(vertex.at.x, vertex.at.y))!.kind).toBe('region-handle');
    leader.dispose();
  });
});

describe('region grips: retargeting the drawing plane', () => {
  it('an anchor grip drag repoints the region at the picked surface and keeps it a region', async () => {
    const { leader } = makeLeader({
      surfacePicking: { point: { x: 0, y: 0, z: 4 }, normal: { x: 0, y: 0, z: 1 } },
    });
    leader.annotations.create(regionNote('a1', FLAT, 'rectangle', RECTANGLE));
    leader.annotations.select(['a1']);
    leader.update();
    const handle = leader.geometry.of('a1')!.handles[0]!;

    leader.editing.beginHandleDrag('a1', 0, at(handle.at.x, handle.at.y));
    leader.editing.pointerMove(at(handle.at.x + 40, handle.at.y));
    leader.editing.pointerUp(at(handle.at.x + 40, handle.at.y));
    await Promise.resolve();
    await Promise.resolve();

    const anchor = region(leader, 'a1');
    expect(anchor.kind).toBe('region');
    expect(anchor.plane.origin).toEqual({ x: 0, y: 0, z: 4 });
    // The shape travels with the plane; only the plane changed.
    expect(anchor.geometry).toMatchObject({ kind: 'rectangle', width: 20, height: 10 });
    leader.dispose();
  });

  it('reverts with a diagnostic when the host provides no surface picking', async () => {
    const { leader } = makeLeader();
    leader.annotations.create(regionNote('a1', FLAT, 'rectangle', RECTANGLE));
    leader.annotations.select(['a1']);
    leader.update();
    const before = leader.annotations.get('a1')!;
    const handle = leader.geometry.of('a1')!.handles[0]!;

    leader.editing.beginHandleDrag('a1', 0, at(handle.at.x, handle.at.y));
    leader.editing.pointerMove(at(handle.at.x + 40, handle.at.y));
    leader.editing.pointerUp(at(handle.at.x + 40, handle.at.y));
    await Promise.resolve();

    expect(leader.annotations.get('a1')).toEqual(before);
    expect(leader.diagnostics.getSnapshot().map(({ code }) => code)).toContain('EDITING_RETARGET_FAILED');
    leader.dispose();
  });
});

describe('ink grips', () => {
  it('publishes one grip per stored point, and a click on the stroke reveals them', () => {
    const { leader, root } = makeLeader();
    createInk(leader, 'ink-1', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }]);
    leader.update();
    expect(leader.geometry.ofInk('ink-1')!.points).toEqual([
      { x: 400, y: 300 }, { x: 450, y: 250 }, { x: 500, y: 300 },
    ]);
    const grips = root.querySelector('[data-ink-handles]') as SVGElement;
    expect(grips.querySelectorAll('[data-ink-handle]')).toHaveLength(3);
    expect(grips.style.display).toBe('none');

    leader.annotations.create(regionNote('a1', FLAT, 'rectangle', RECTANGLE));
    leader.annotations.select(['a1']);
    leader.update();
    root.querySelector('[data-hit-target="ink"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect((root.querySelector('[data-ink-handles]') as SVGElement).style.display).toBe('');
    // Ink is not an annotation, so it must not appear in the annotation selection — and a plain
    // click still replaces the whole selection, which is one selection to the drafter.
    expect(leader.annotations.getSnapshot().selectedIds).toEqual([]);
    leader.dispose();
  });

  it('dragging an ink point moves it, and the stroke still validates', () => {
    const { leader } = makeLeader();
    createInk(leader, 'ink-1', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }]);
    leader.update();

    leader.editing.beginInkPointDrag('ink-1', 1, at(450, 250));
    leader.editing.pointerMove(at(450, 200));
    leader.editing.pointerUp(at(450, 200));

    const ink = leader.authoring.markup.getInk('ink-1')!;
    expect(ink.points).toHaveLength(3);
    expect(ink.points[1]!.x).toBeCloseTo(5, 6);
    expect(ink.points[1]!.y).toBeCloseTo(10, 6);
    expect(ink.points[0]).toEqual({ x: 0, y: 0 });
    expect(() => validateInk(ink)).not.toThrow();
    leader.dispose();
  });

  it('dragging the stroke body moves every point together, in one undo step', () => {
    const { leader } = makeLeader();
    createInk(leader, 'ink-1', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }]);
    leader.update();
    const undoCount = leader.history.getSnapshot().undoCount;

    // (425, 275) lies on the first stroke segment, well away from every point grip.
    drag(leader, { x: 425, y: 275 }, { x: 525, y: 275 });

    const ink = leader.authoring.markup.getInk('ink-1')!;
    expect(ink.points.map(({ x }) => Math.round(x * 1e6) / 1e6)).toEqual([10, 15, 20]);
    expect(ink.points.map(({ y }) => y)).toEqual([0, 5, 0]);
    expect(leader.history.getSnapshot().undoCount).toBe(undoCount + 1);
    expect(leader.history.getSnapshot().undoLabel).toBe('Edit ink');
    leader.dispose();
  });

  it('reopens identically from a saved document', () => {
    const { leader } = makeLeader();
    createInk(leader, 'ink-1', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }]);
    leader.update();
    leader.editing.beginInkPointDrag('ink-1', 1, at(450, 250));
    leader.editing.pointerMove(at(450, 200));
    leader.editing.pointerUp(at(450, 200));
    const expected = leader.authoring.markup.getInk('ink-1')!;
    const serialized = leader.documents.serialize();
    leader.dispose();

    const reopened = makeLeader();
    reopened.leader.documents.replace(serialized);
    expect(reopened.leader.authoring.markup.getInk('ink-1')).toEqual(expected);
    reopened.leader.dispose();
  });

  it('an unknown ink id is refused, and an unknown point index starts nothing', () => {
    const { leader } = makeLeader();
    createInk(leader, 'ink-1', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }]);
    leader.update();
    expect(() => leader.editing.beginInkPointDrag('nope', 0, at(400, 300))).toThrow(/ink/u);
    leader.editing.beginInkPointDrag('ink-1', 9, at(400, 300));
    expect(leader.editing.getSnapshot().phase).toBe('idle');
    leader.dispose();
  });

  it('draws no ink grip and hit-tests none when the host opts out', () => {
    const { leader, root } = makeLeader({ handles: 'none' });
    createInk(leader, 'ink-1', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }]);
    leader.update();
    expect(root.querySelectorAll('[data-ink-handle]')).toHaveLength(0);
    // The stroke itself is still grabbable, and the points are still published.
    expect(leader.editing.hitTest(at(425, 275))!.kind).toBe('ink');
    expect(leader.geometry.ofInk('ink-1')!.points).toHaveLength(3);
    leader.dispose();
  });

  it('an under-threshold press on an ink point changes nothing', () => {
    const { leader } = makeLeader();
    createInk(leader, 'ink-1', [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }]);
    leader.update();
    const before = leader.authoring.markup.getInk('ink-1')!;
    const undoCount = leader.history.getSnapshot().undoCount;

    leader.editing.beginInkPointDrag('ink-1', 1, at(450, 250));
    leader.editing.pointerMove(at(452, 250));
    leader.editing.pointerUp(at(452, 250));

    expect(leader.authoring.markup.getInk('ink-1')).toEqual(before);
    expect(leader.history.getSnapshot().undoCount).toBe(undoCount);
    leader.dispose();
  });
});

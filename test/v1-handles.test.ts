/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';

import {
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
} from '../src/index.js';
import type { EditingSnapshot } from '../src/editing.js';
import type { AnnotationScreenGeometry, InkScreenGeometry } from '../src/render.js';
import type { FollowGeometrySource, FollowTarget } from '../src/internal/follow.js';
import { subscribeFrame } from '../src/internal/frame-seam.js';
import {
  HandlesController,
  type HandleEditingPort,
  type HandleEntry,
  type HandleFollowSink,
  type HandlePointerEvent,
} from '../src/internal/handles.js';
import type { Vec2 } from '../src/types.js';

const VIEWPORT = { width: 800, height: 600 };

/** A fixed orthographic camera that can be panned, so a frame can be forced without a document
 *  change — which is the case the handle *list* must not publish on. */
function pannableAdapters(readPan: () => number): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
      getRevision: () => readPan(),
      project: (point) => ({
        point: { x: 400 + point.x * 10 + readPan(), y: 300 - point.y * 10 },
        depth: point.z,
        visible: true,
      }),
    },
  };
}

/** A pointer event shaped like the fields the handlers read. React's synthetic event is this too. */
function pointerAt(x: number, y: number, currentTarget: EventTarget | null = null): HandlePointerEvent {
  return {
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    pointerType: 'mouse',
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    pointerId: 1,
    currentTarget,
  };
}

/** Records what was registered, so the `onMissing` flip is observable without a real registry. */
function recordingFollow(): HandleFollowSink & { readonly modes: Map<string, string | undefined> } {
  const modes = new Map<string, string | undefined>();
  return {
    modes,
    register: (target, _element, options) => {
      modes.set(keyOf(target), options?.onMissing);
      return () => undefined;
    },
    release: (target) => { modes.delete(keyOf(target)); },
  };
}

function keyOf(target: FollowTarget): string {
  return JSON.stringify(target);
}

// --- a real viewer -----------------------------------------------------------------------------

function note(id: string, position: Vec2, vertices?: readonly Vec2[]): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    routing: vertices === undefined
      ? { kind: 'automatic', mode: 'dogleg' }
      : { kind: 'manual', vertices },
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position },
  };
}

function twoLegNote(id: string): AnnotationDraft {
  return {
    id,
    anchors: [
      {
        id: 'left',
        anchor: { kind: 'world-point', point: { x: -4, y: 0, z: 0 } },
        routing: { kind: 'manual', vertices: [{ x: 330, y: 340 }] },
      },
      {
        id: 'right',
        anchor: { kind: 'world-point', point: { x: 4, y: 0, z: 0 } },
        routing: { kind: 'manual', vertices: [{ x: 470, y: 340 }] },
      },
    ],
    content: { kind: 'plain-note', text: 'Note' },
    placement: { kind: 'manual', position: { x: 600, y: 450 } },
  };
}

interface Viewer {
  readonly leader: ViewLeader;
  readonly boundary: HTMLElement;
  readonly follow: ReturnType<typeof recordingFollow>;
  controllerFor(target: string | { readonly ink: string }): HandlesController;
  /** Moves the camera and draws a frame. No document changes, so nothing publishes. */
  pan(by: number): void;
  dispose(): void;
}

function viewer(): Viewer {
  const boundary = document.createElement('div');
  document.body.append(boundary);
  // jsdom lays nothing out, and `normalizePointer` divides by the boundary's size — without this
  // every pointer normalizes to 0,0 and no drag has a direction.
  boundary.getBoundingClientRect = () => ({
    x: 0, y: 0, left: 0, top: 0, right: VIEWPORT.width, bottom: VIEWPORT.height,
    width: VIEWPORT.width, height: VIEWPORT.height, toJSON: () => ({}),
  }) as DOMRect;
  let pan = 0;
  const leader = new ViewLeader({
    boundary,
    adapters: pannableAdapters(() => pan),
    editing: { handles: 'none' },
  });
  const follow = recordingFollow();
  const controllers: HandlesController[] = [];
  return {
    leader,
    boundary,
    follow,
    controllerFor: (target) => {
      const controller = new HandlesController({
        host: leader,
        boundary,
        follow,
        target,
        subscribeFrame: (listener) => subscribeFrame(leader, listener),
      });
      controllers.push(controller);
      return controller;
    },
    pan: (by) => { pan += by; leader.update(); },
    dispose: () => {
      for (const controller of controllers) controller.dispose();
      leader.dispose();
      boundary.remove();
    },
  };
}

function entry(entries: readonly HandleEntry[], key: string): HandleEntry {
  const found = entries.find((candidate) => candidate.key === key);
  expect(found, `no handle keyed ${key} in ${entries.map((e) => e.key).join(', ')}`).toBeDefined();
  return found!;
}

// --- enumeration -------------------------------------------------------------------------------

describe('handle enumeration', () => {
  it('returns every handle of a multi-leg annotation in one flat array', () => {
    const harness = viewer();
    harness.leader.annotations.create(twoLegNote('a1'));
    harness.leader.update();
    const entries = harness.controllerFor('a1').getSnapshot();
    const geometry = harness.leader.geometry.of('a1')!;

    expect(entries).toHaveLength(
      geometry.handles.length + geometry.routeHandles.length + geometry.regionHandles.length,
    );
    // One arrow handle per leg, and both legs contribute route handles.
    expect(entries.filter((e) => e.kind === 'handle').map((e) => e.legId)).toEqual(['left', 'right']);
    expect(new Set(entries.filter((e) => e.kind === 'midpoint').map((e) => e.legId)))
      .toEqual(new Set(['left', 'right']));
    harness.dispose();
  });

  it('keeps two legs that both publish midpoint 0 apart', () => {
    const harness = viewer();
    harness.leader.annotations.create(twoLegNote('a1'));
    harness.leader.update();
    const entries = harness.controllerFor('a1').getSnapshot();

    const firstMidpoints = entries.filter((e) => e.kind === 'midpoint' && e.index === 0);
    expect(firstMidpoints).toHaveLength(2);
    // `kind + index` collides; the key carries the leg, so it does not.
    expect(new Set(firstMidpoints.map((e) => e.key)).size).toBe(2);
    // And every key in the whole set is unique.
    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
    harness.dispose();
  });

  it('reaches a freehand stroke through the same call with an ink target', () => {
    const harness = viewer();
    // A markup session is the only way to make one.
    const session = harness.leader.authoring.markup.begin('ink');
    session.establishPlane({
      origin: { x: 0, y: 0, z: 0 },
      normal: { x: 0, y: 0, z: 1 },
      xAxis: { x: 1, y: 0, z: 0 },
      yAxis: { x: 0, y: 1, z: 0 },
    });
    for (const point of [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }]) session.appendInkPoint(point);
    harness.leader.authoring.markup.commitInk(session, { id: 'ink-1' });
    harness.leader.update();
    const entries = harness.controllerFor({ ink: 'ink-1' }).getSnapshot();

    expect(entries).toHaveLength(harness.leader.geometry.ofInk('ink-1')!.points.length);
    expect(entries.every((e) => e.kind === 'ink-point')).toBe(true);
    expect(entries.map((e) => e.slot)).toEqual(entries.map((e) => e.index));
    harness.dispose();
  });

  it('gives a midpoint the copy cursor and everything else the move cursor', () => {
    const harness = viewer();
    harness.leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    harness.leader.update();
    const entries = harness.controllerFor('a1').getSnapshot();

    expect(entries.filter((e) => e.kind === 'midpoint').every((e) => e.cursor === 'copy')).toBe(true);
    expect(entries.filter((e) => e.kind !== 'midpoint').every((e) => e.cursor === 'move')).toBe(true);
    harness.dispose();
  });
});

// --- drag routing ------------------------------------------------------------------------------

/** A geometry carrying one of every handle kind, so all four `begin*Drag` routes are reachable. */
const EVERY_KIND: AnnotationScreenGeometry = {
  label: { x: 0, y: 0, width: 10, height: 10 },
  legs: [],
  handles: [{ target: 'leg-1', index: 0, at: { x: 1, y: 1 } }],
  routeHandles: [
    { target: 'leg-1', kind: 'vertex', index: 0, at: { x: 2, y: 2 } },
    { target: 'leg-1', kind: 'midpoint', index: 0, at: { x: 3, y: 3 } },
  ],
  regionHandles: [
    { target: 'leg-1', kind: 'extent', grab: { x: 4, y: 4 }, at: { x: 4, y: 4 } },
    { target: 'leg-1', kind: 'vertex', index: 0, at: { x: 5, y: 5 } },
    { target: 'leg-1', kind: 'midpoint', index: 0, at: { x: 6, y: 6 } },
  ],
  text: {
    fontFamily: 'Helvetica', fontSize: 14, lineHeight: 18, textColor: '#111',
    align: 'start', padding: 4, weight: 'normal',
  },
};

interface FakeHost {
  readonly geometry: FollowGeometrySource;
  readonly editing: HandleEditingPort;
  readonly annotations: { subscribe(listener: () => void): () => void };
  readonly calls: [string, string, number][];
  setPhase(phase: EditingSnapshot['phase']): void;
  setGeometry(value: AnnotationScreenGeometry | undefined): void;
  setInk(value: InkScreenGeometry | undefined): void;
  publish(): void;
}

function fakeHost(): FakeHost {
  const calls: [string, string, number][] = [];
  const listeners = new Set<() => void>();
  let phase: EditingSnapshot['phase'] = 'idle';
  let revision = 0;
  let current: AnnotationScreenGeometry | undefined = EVERY_KIND;
  let ink: InkScreenGeometry | undefined = { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
  const record = (method: string) => (id: string, index: number): void => {
    calls.push([method, id, index]);
  };
  return {
    calls,
    geometry: { of: () => current, ofInk: () => ink },
    annotations: { subscribe: () => () => undefined },
    editing: {
      getSnapshot: () => Object.freeze({
        runtimeRevision: revision, documentRevision: 0, phase, target: null, kind: null, leg: null,
      }),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      beginHandleDrag: record('beginHandleDrag'),
      beginRouteHandleDrag: record('beginRouteHandleDrag'),
      beginRegionHandleDrag: record('beginRegionHandleDrag'),
      beginInkPointDrag: record('beginInkPointDrag'),
      pointerMove: () => undefined,
      pointerUp: () => undefined,
      cancel: () => undefined,
    },
    setPhase: (next) => { phase = next; },
    setGeometry: (value) => { current = value; },
    setInk: (value) => { ink = value; },
    publish: () => { revision += 1; for (const listener of [...listeners]) listener(); },
  };
}

function fakeController(host: FakeHost, target: string | { readonly ink: string } = 'a1'): {
  readonly controller: HandlesController;
  readonly follow: ReturnType<typeof recordingFollow>;
  readonly boundary: HTMLElement;
} {
  const boundary = document.createElement('div');
  document.body.append(boundary);
  const follow = recordingFollow();
  return {
    boundary,
    follow,
    controller: new HandlesController({
      host,
      boundary,
      follow,
      target,
      // The fake's geometry is always current, so an armed check has nothing to wait for.
      subscribeFrame: () => () => undefined,
    }),
  };
}

describe('drag routing', () => {
  it('sends each handle kind to its own begin*Drag, with the geometry-array slot', () => {
    const host = fakeHost();
    const { controller } = fakeController(host);
    for (const handle of controller.getSnapshot()) handle.props.onPointerDown(pointerAt(0, 0));

    // `slot` is the position inside the handle's own geometry array, not inside the flat list —
    // that is what every `begin*Drag` takes.
    expect(host.calls).toEqual([
      ['beginHandleDrag', 'a1', 0],
      ['beginRouteHandleDrag', 'a1', 0],
      ['beginRouteHandleDrag', 'a1', 1],
      ['beginRegionHandleDrag', 'a1', 0],
      ['beginRegionHandleDrag', 'a1', 1],
      ['beginRegionHandleDrag', 'a1', 2],
    ]);
  });

  it('sends an ink point to beginInkPointDrag under the stroke id', () => {
    const host = fakeHost();
    const { controller } = fakeController(host, { ink: 'stroke-1' });
    controller.getSnapshot()[1]!.props.onPointerDown(pointerAt(0, 0));
    expect(host.calls).toEqual([['beginInkPointDrag', 'stroke-1', 1]]);
  });

  it('normalizes the pointer against the boundary rather than handing over raw pixels', () => {
    const harness = viewer();
    harness.leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    harness.leader.update();
    const controller = harness.controllerFor('a1');
    const vertex = entry(controller.getSnapshot(), 'route:a1:leg-1:vertex:0');

    // Raw client pixels; `beginRouteHandleDrag` validates 0..1 and throws on anything else.
    expect(() => vertex.props.onPointerDown(pointerAt(450, 340))).not.toThrow();
    expect(harness.leader.editing.getSnapshot()).toMatchObject({ phase: 'pressed', target: 'a1' });
    harness.leader.editing.cancel('host');
    harness.dispose();
  });
});

// --- the freeze --------------------------------------------------------------------------------

describe('the frozen handle set', () => {
  it('holds its identity while the live set renumbers underneath a bend-inserting drag', () => {
    const harness = viewer();
    harness.leader.annotations.create(
      note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }, { x: 500, y: 380 }]),
    );
    harness.leader.update();
    const controller = harness.controllerFor('a1');

    const before = controller.getSnapshot();
    const liveBefore = harness.leader.geometry.of('a1')!.routeHandles.length;
    const grabbed = entry(before, 'route:a1:leg-1:midpoint:0');

    const grabbedAt = harness.leader.geometry.of('a1')!.routeHandles[grabbed.slot]!.at;
    grabbed.props.onPointerDown(pointerAt(grabbedAt.x, grabbedAt.y));
    grabbed.props.onPointerMove(pointerAt(200, 150));
    harness.leader.update();

    // The live geometry has renumbered: a bend was inserted, so there is one more route handle.
    const liveDuring = harness.leader.geometry.of('a1')!.routeHandles.length;
    expect(liveDuring).toBeGreaterThan(liveBefore);

    // The enumerated set has not. Same array, same keys, and the grabbed handle is still there.
    const during = controller.getSnapshot();
    expect(during).toBe(before);
    expect(during.map((e) => e.key)).toEqual(before.map((e) => e.key));
    expect(entry(during, 'route:a1:leg-1:midpoint:0')).toBe(grabbed);

    // Thaws on release, and picks up the handle the new bend brought with it.
    grabbed.props.onPointerUp(pointerAt(200, 150));
    harness.leader.update();
    const after = controller.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThan(before.length);
    harness.dispose();
  });

  it('waits out the asynchronous picking phase rather than thawing on pointer-up', () => {
    const host = fakeHost();
    const { controller } = fakeController(host);
    const before = controller.getSnapshot();

    host.setPhase('picking');
    host.publish();
    host.setGeometry(undefined);
    // Geometry has gone entirely; a thawed set would be empty.
    expect(controller.getSnapshot()).toBe(before);

    host.setPhase('idle');
    host.publish();
    expect(controller.getSnapshot()).toHaveLength(0);
  });

  it('switches registered handles to onMissing hold while frozen, and back on release', () => {
    const host = fakeHost();
    const { controller, follow } = fakeController(host);
    const [first] = controller.getSnapshot();
    controller.ref(first!)(document.createElement('div'));
    expect([...follow.modes.values()]).toEqual(['hide']);

    host.setPhase('dragging');
    host.publish();
    // Without this the handle being dragged is hidden the moment its live geometry disappears,
    // which is the whole reason the set is frozen.
    expect([...follow.modes.values()]).toEqual(['hold']);

    host.setPhase('idle');
    host.publish();
    expect([...follow.modes.values()]).toEqual(['hide']);
  });

  it('memoizes its ref callbacks by key', () => {
    const host = fakeHost();
    const { controller } = fakeController(host);
    const [first, second] = controller.getSnapshot();
    expect(controller.ref(first!)).toBe(controller.ref(first!));
    expect(controller.ref(first!)).not.toBe(controller.ref(second!));
  });
});

// --- snapshot identity -------------------------------------------------------------------------

describe('snapshot identity', () => {
  it('returns an Object.is-identical value when nothing changed', () => {
    const harness = viewer();
    harness.leader.annotations.create(twoLegNote('a1'));
    harness.leader.update();
    const controller = harness.controllerFor('a1');

    const first = controller.getSnapshot();
    expect(controller.getSnapshot()).toBe(first);

    harness.leader.update();
    expect(controller.getSnapshot()).toBe(first);
    harness.leader.annotations.select(['a1']);
    harness.leader.update();
    expect(controller.getSnapshot()).toBe(first);
    harness.dispose();
  });

  it('does not publish on the frame tick, however far the camera moves', () => {
    const harness = viewer();
    harness.leader.annotations.create(twoLegNote('a1'));
    harness.leader.update();
    const controller = harness.controllerFor('a1');
    const first = controller.getSnapshot();

    let published = 0;
    controller.subscribe(() => { published += 1; });

    const before = harness.leader.geometry.of('a1')!.handles[0]!.at.x;
    for (let step = 0; step < 30; step += 1) harness.pan(3);

    // The handles really did move on screen...
    expect(harness.leader.geometry.of('a1')!.handles[0]!.at.x).not.toBe(before);
    // ...and the list said nothing about it. Positions ride the follow registry; publishing the
    // list per frame is what the whole ref-based design exists to avoid.
    expect(published).toBe(0);
    expect(controller.getSnapshot()).toBe(first);
    harness.dispose();
  });

  it('publishes once, with a new value, when the set actually changes shape', () => {
    const harness = viewer();
    harness.leader.annotations.create(note('a1', { x: 560, y: 420 }, [{ x: 450, y: 340 }]));
    harness.leader.update();
    const controller = harness.controllerFor('a1');
    const before = controller.getSnapshot();

    let published = 0;
    controller.subscribe(() => { published += 1; });

    // Selecting changes runtime state but not the handle set; adding a bend changes the set.
    harness.leader.annotations.select(['a1']);
    harness.leader.update();
    expect(published).toBe(0);
    expect(controller.getSnapshot()).toBe(before);

    harness.leader.annotations.update('a1', {
      anchors: [{
        id: 'leg-1',
        anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
        routing: { kind: 'manual', vertices: [{ x: 450, y: 340 }, { x: 500, y: 380 }] },
      }],
    });
    harness.leader.update();
    const after = controller.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThan(before.length);
    // One publish for the one change, not one per subscription that fired.
    expect(published).toBe(1);
    harness.dispose();
  });

  it('goes inert after dispose', () => {
    const harness = viewer();
    harness.leader.annotations.create(twoLegNote('a1'));
    harness.leader.update();
    const controller = harness.controllerFor('a1');
    const before = controller.getSnapshot();

    controller.dispose();
    expect(controller.getSnapshot()).toHaveLength(0);
    expect(controller.getSnapshot()).not.toBe(before);
    harness.dispose();
  });
});

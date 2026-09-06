/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { ViewLeader, type HostAdapterBundle, type ModelBounds, type PlacementMode, type Rect } from 'viewleader';

const active: ViewLeader[] = [];
afterEach(() => { for (const leader of active.splice(0)) leader.dispose(); document.body.replaceChildren(); });

function fixture(options: { safe?: boolean; snap?: boolean } = {}) {
  let bounds: ModelBounds | null = { min: { x: 200, y: 150, z: 0 }, max: { x: 600, y: 450, z: 0 } };
  const adapters: HostAdapterBundle = {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
      getRevision: () => 1,
      project: (point) => ({ point: { x: point.x, y: point.y }, depth: 0.5, visible: true }),
      ...(options.safe === false ? {} : { projectBounds: (model: ModelBounds) => ({
        status: 'available' as const,
        bounds: { min: { x: model.min.x, y: model.min.y }, max: { x: model.max.x, y: model.max.y } },
      }) }),
    },
    modelBounds: { get: () => bounds },
  };
  const boundary = document.createElement('div');
  document.body.append(boundary);
  const leader = new ViewLeader({ boundary, adapters,
    ...(options.snap ? { strategies: { snap: () => ({ x: 380, y: 260 }) } } : {}),
  });
  active.push(leader);
  for (let i = 0; i < 4; i += 1) leader.annotations.create({
    id: `note-${i}`, anchor: { kind: 'world-point', point: { x: 220 + i * 40, y: 210 + i * 8, z: 0 } },
    content: { kind: 'plain-note', text: `A note ${i}` },
  });
  return { leader, setBounds: (value: ModelBounds | null) => { bounds = value; } };
}

function clears(rect: Rect, bounds: ModelBounds): boolean {
  return rect.x + rect.width <= bounds.min.x || rect.x >= bounds.max.x
    || rect.y + rect.height <= bounds.min.y || rect.y >= bounds.max.y;
}

describe('model organization through the public API', () => {
  it.each(['sides', 'rows', 'auto', 'quadrants'] satisfies PlacementMode[])(
    'keeps full labels outside raw off-screen model bounds in %s mode, including after snapping', (mode) => {
      const { leader, setBounds } = fixture({ snap: true });
      const giant = { min: { x: -400, y: -300, z: 0 }, max: { x: 1200, y: 900, z: 0 } };
      setBounds(giant);
      leader.setPlacementMode(mode);
      leader.setKeepLabelsOutsideModel(true);
      leader.setViewportInsets({ top: 20, right: 0, bottom: 80, left: 0 });
      // A smaller authored guide must not redefine what counts as being outside the model.
      leader.setLayoutFrame({ unit: 'pixels', rect: { x: 300, y: 250, width: 100, height: 100 } });
      leader.update();
      for (let i = 0; i < 4; i += 1) {
        const geometry = leader.geometry.of(`note-${i}`)!;
        expect(clears(geometry.label, giant)).toBe(true);
        expect(geometry.legs.flat().every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))).toBe(true);
      }
      expect(leader.overlayElement.style.overflow).toBe('hidden');
      expect(leader.overlayElement.style.clipPath).toContain('80px');
    },
  );

  it('refreshes model bounds without a camera revision, and does not use stale bounds after removal', () => {
    const { leader, setBounds } = fixture();
    leader.setKeepLabelsOutsideModel(true);
    leader.update();
    const before = leader.geometry.of('note-0')!.label;
    const enlarged = { min: { x: -400, y: -300, z: 0 }, max: { x: 1200, y: 900, z: 0 } };
    setBounds(enlarged);
    leader.update();
    expect(clears(leader.geometry.of('note-0')!.label, enlarged)).toBe(true);
    expect(leader.geometry.of('note-0')!.label).not.toEqual(before);
    setBounds(null);
    leader.update();
    expect(leader.geometry.of('note-0')).toBeUndefined();
    expect(leader.annotations.get('note-0')).toBeDefined();
    setBounds(enlarged);
    leader.update();
    expect(leader.geometry.of('note-0')).toBeDefined();
  });

  it('temporarily constrains manual and locked labels without rewriting authored work', () => {
    const { leader } = fixture();
    leader.annotations.move('note-0', { x: 350, y: 270 });
    leader.annotations.update('note-0', { locked: true });
    leader.annotations.reroute('note-0', { kind: 'manual', vertices: [{ x: 180, y: 200 }] });
    leader.update();
    const before = leader.geometry.of('note-0')!.label;
    const saved = leader.documents.serialize();
    leader.setPlacementMode('quadrants');
    leader.setKeepLabelsOutsideModel(true);
    leader.update();
    expect(leader.geometry.of('note-0')!.label).not.toEqual(before);
    expect(leader.documents.serialize()).toBe(saved);
    leader.setKeepLabelsOutsideModel(false);
    leader.setPlacementMode('auto');
    leader.update();
    expect(leader.geometry.of('note-0')!.label).toEqual(before);
    expect(leader.documents.serialize()).toBe(saved);
    expect(leader.overlayElement.style.overflow).toBe('visible');
  });

  it('withholds strict labels with a clear diagnostic when the host cannot project safe bounds', () => {
    const { leader } = fixture({ safe: false });
    leader.setKeepLabelsOutsideModel(true);
    leader.update();
    expect(leader.geometry.of('note-0')).toBeUndefined();
    expect(leader.diagnostics.getSnapshot().filter((entry) => entry.code === 'MODEL_BOUNDS_UNAVAILABLE')).toHaveLength(1);
    leader.update();
    expect(leader.diagnostics.getSnapshot().filter((entry) => entry.code === 'MODEL_BOUNDS_UNAVAILABLE')).toHaveLength(1);
    leader.setKeepLabelsOutsideModel(false);
    leader.update();
    expect(leader.geometry.of('note-0')).toBeDefined();
  });

  it('restores the existing automatic layout when quadrant organization is disabled', () => {
    const { leader } = fixture();
    leader.update();
    const before = leader.geometry.of('note-0')!.label;
    const serialized = leader.documents.serialize();
    leader.setPlacementMode('quadrants');
    leader.update();
    expect(leader.placementMode).toBe('quadrants');
    leader.setPlacementMode('auto');
    leader.update();
    expect(leader.geometry.of('note-0')!.label).toEqual(before);
    expect(leader.documents.serialize()).toBe(serialized);
  });

  it('keeps an organized label in place when its route is edited or locked', () => {
    const { leader } = fixture();
    leader.setPlacementMode('quadrants');
    leader.update();
    const before = leader.geometry.of('note-2')!.label;
    leader.annotations.reroute('note-2', { kind: 'manual', vertices: [{ x: 160, y: 120 }] });
    leader.update();
    expect(leader.geometry.of('note-2')!.label).toEqual(before);
    leader.annotations.update('note-2', { locked: true });
    leader.update();
    expect(leader.geometry.of('note-2')!.label).toEqual(before);
    leader.setKeepLabelsOutsideModel(true);
    leader.annotations.update('note-2', { content: { kind: 'plain-note', text: 'A much wider label after editing the route and locking the annotation' } });
    leader.update();
    expect(clears(leader.geometry.of('note-2')!.label, {
      min: { x: 200, y: 150, z: 0 }, max: { x: 600, y: 450, z: 0 },
    })).toBe(true);
  });
});

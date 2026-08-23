// Works out the "layout frame": the rectangle on screen that labels are kept outside of, so notes
// sit clear of the building rather than on top of it.
//
// Three sources, in order of preference:
//   1. a rectangle the user drew, which always wins,
//   2. otherwise the model's own outline projected to the screen,
//   3. otherwise the last outline that worked, reused while the model is off-screen.
//
// Step 3 matters because a model can leave the view for a frame or two during a fast orbit. Without
// a remembered box the labels would collapse to the middle of the screen and spring back out.
import type { OrganizationRect, Rect, Vec2, Vec3 } from './types.js';

/** A rectangle on screen, as a top-left and bottom-right corner. */
export interface Bounds2 {
  readonly min: Vec2;
  readonly max: Vec2;
}

/**
 * Turns a user-drawn rectangle into screen pixels. Fractions are measured against the current
 * viewport so the rectangle keeps its place when the window is resized; pixel values pass straight
 * through.
 */
export function resolveOrganizationRect(value: OrganizationRect, viewport: Rect): Rect {
  if (value.unit === 'pixels') return { ...value.rect };
  return {
    x: viewport.x + value.rect.x * viewport.width,
    y: viewport.y + value.rect.y * viewport.height,
    width: value.rect.width * viewport.width,
    height: value.rect.height * viewport.height,
  };
}

/**
 * Converts a rectangle to a min/max box, coping with one dragged out right-to-left. A rectangle
 * with no area returns nothing, so an accidental click does not become a zero-size frame.
 */
function rectToBounds(rect: Rect): Bounds2 | undefined {
  const minX = Math.min(rect.x, rect.x + rect.width);
  const maxX = Math.max(rect.x, rect.x + rect.width);
  const minY = Math.min(rect.y, rect.y + rect.height);
  const maxY = Math.max(rect.y, rect.y + rect.height);
  if (maxX - minX < 1 || maxY - minY < 1) return undefined;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

function corners(world: { min: Vec3; max: Vec3 }): readonly Vec3[] {
  const { min, max } = world;
  return [
    { x: min.x, y: min.y, z: min.z }, { x: max.x, y: min.y, z: min.z },
    { x: min.x, y: max.y, z: min.z }, { x: max.x, y: max.y, z: min.z },
    { x: min.x, y: min.y, z: max.z }, { x: max.x, y: min.y, z: max.z },
    { x: min.x, y: max.y, z: max.z }, { x: max.x, y: max.y, z: max.z },
  ];
}

/**
 * Projects the eight corners of the model's box onto the screen and measures where they land.
 *
 * Corners that fall outside the viewport are kept, so the frame can extend past the edge of the
 * screen when you are zoomed in close. Corners behind the camera cannot be projected at all and are
 * skipped; if none of them project, there is no frame this pass.
 */
export function projectWorldAabb(
  world: { min: Vec3; max: Vec3 },
  project: (point: Vec3) => Vec2 | null,
  viewport: { readonly width: number; readonly height: number },
  margin = 0,
): Bounds2 | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const corner of corners(world)) {
    const point = project(corner);
    if (point === null || !Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    any = true;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!any) return undefined;
  minX = Math.max(0, minX - margin);
  minY = Math.max(0, minY - margin);
  maxX = Math.min(viewport.width, maxX + margin);
  maxY = Math.min(viewport.height, maxY + margin);
  if (maxX - minX < 1 || maxY - minY < 1) return undefined;
  return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
}

/**
 * Remembers the last usable model outline.
 *
 * During a fast orbit the model can briefly leave the view entirely. Without this the frame would
 * vanish for those frames and every label would jump to the centre of the screen and back.
 */
export class BoundaryMemory {
  #last: Bounds2 | undefined;
  public resolve(current: Bounds2 | undefined): Bounds2 | undefined {
    if (current !== undefined) this.#last = current;
    return this.#last;
  }
  public clear(): void {
    this.#last = undefined;
  }
}

/**
 * Picks the frame for one drawn frame of video.
 *
 * A rectangle the user drew always wins, and is deliberately not remembered — erasing it should go
 * straight back to the model outline, not to a stale copy of what was just erased. The model
 * outline is remembered, for the off-screen case above.
 *
 * Returns nothing when there is no frame at all; callers then place labels around their anchors
 * instead of around a frame.
 */
export function resolveLayoutFrame(params: {
  readonly layoutFrame?: OrganizationRect | null;
  readonly worldBounds?: { min: Vec3; max: Vec3 } | null;
  readonly project: (point: Vec3) => Vec2 | null;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly margin?: number;
  readonly memory: BoundaryMemory;
}): Bounds2 | undefined {
  const { layoutFrame, worldBounds, project, viewport, margin = 0, memory } = params;
  if (layoutFrame) {
    return rectToBounds(resolveOrganizationRect(layoutFrame, { x: 0, y: 0, width: viewport.width, height: viewport.height }));
  }
  if (worldBounds) {
    return memory.resolve(projectWorldAabb(worldBounds, project, viewport, margin));
  }
  return memory.resolve(undefined);
}

/** @vitest-environment jsdom */
/**
 * Phase 2.3, last criterion. `ViewLeaderDocument` had no field for the drawn framing rectangle, so
 * `setLayoutFrame` was runtime-only and every drawn frame died on reload.
 *
 * That is worse than losing a setting. Without a frame the placer falls back to the projected model
 * box, so a discarded frame does not merely forget a preference — it silently relays out the whole
 * drawing into a different arrangement than the one that was saved.
 */
import { describe, expect, it } from 'vitest';
import { ViewLeader, type HostAdapterBundle, type OrganizationRect } from 'viewleader';

const VIEWPORT = { width: 800, height: 600 };
const FRAME: OrganizationRect = { rect: { x: 300, y: 200, width: 200, height: 150 }, unit: 'pixels' };

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function adapters(): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ ...VIEWPORT, devicePixelRatio: 1 }),
      project: (point) => ({ point: { x: 400 + point.x * 10, y: 300 - point.y * 10 }, depth: point.z, visible: true }),
      getRevision: () => 1,
    },
  };
}

function withNotes(): ViewLeader {
  const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
  for (let index = 0; index < 6; index += 1) {
    leader.annotations.create({
      id: `n${index}`,
      anchor: { kind: 'world-point', point: { x: index - 3, y: index - 3, z: 0 } },
      content: { kind: 'plain-note', text: `NOTE ${index}` },
    });
  }
  leader.update();
  return leader;
}

describe('the drawn layout frame is document state', () => {
  it('round-trips through save and reopen', () => {
    const leader = withNotes();
    expect(leader.layoutFrame).toBeNull();
    leader.setLayoutFrame(FRAME);
    expect(leader.layoutFrame).toEqual(FRAME);

    const saved = leader.documents.serialize();
    expect(leader.documents.parse(saved).layoutFrame).toEqual(FRAME);
    leader.dispose();

    const reopened = new ViewLeader({ boundary: boundary(), adapters: adapters(), initialDocument: saved });
    expect(reopened.layoutFrame).toEqual(FRAME);
    // Identical in, identical out — a fixed point, not merely lossless once.
    expect(reopened.documents.serialize()).toBe(saved);
    reopened.dispose();
  });

  it('restores the same drawing, not just the same field', () => {
    // The field surviving is not the point; the layout it produces surviving is.
    const drawn = withNotes();
    drawn.setLayoutFrame(FRAME);
    drawn.update();
    const before = drawn.geometry.of('n0')!.label;
    const saved = drawn.documents.serialize();
    drawn.dispose();

    const reopened = new ViewLeader({ boundary: boundary(), adapters: adapters(), initialDocument: saved });
    reopened.update();
    expect(reopened.geometry.of('n0')!.label).toEqual(before);
    reopened.dispose();
  });

  it('is undoable, like every other authored change', () => {
    const leader = withNotes();
    leader.setLayoutFrame(FRAME);
    expect(leader.layoutFrame).toEqual(FRAME);
    expect(leader.history.undo()).toBe(true);
    expect(leader.layoutFrame).toBeNull();
    expect(leader.history.redo()).toBe(true);
    expect(leader.layoutFrame).toEqual(FRAME);
    leader.dispose();
  });

  it('clears to absent rather than to a null field', () => {
    // Two documents that mean the same thing must serialize identically, or every equality check
    // downstream — round trips, dirty tracking, diffing — has to know about both spellings.
    const leader = withNotes();
    const pristine = leader.documents.serialize();
    leader.setLayoutFrame(FRAME);
    leader.setLayoutFrame(null);
    expect(leader.layoutFrame).toBeNull();
    expect(leader.documents.serialize()).toBe(pristine);
    leader.dispose();
  });

  it('survives a v1 document that never had the field', () => {
    const v1 = JSON.stringify({
      schema: 'viewleader.document', version: 1, annotations: [], metadata: {}, pluginEnvelopes: [],
      definitions: { styles: [], enclosures: [], terminators: [], templates: [] },
      savedViews: [], tours: [], ink: [],
    });
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters(), initialDocument: v1 });
    expect(leader.layoutFrame).toBeNull();
    leader.dispose();
  });

  it('refuses a malformed frame rather than storing a box the placer divides by', () => {
    const base = {
      schema: 'viewleader.document', version: 1, annotations: [], metadata: {}, pluginEnvelopes: [],
      definitions: { styles: [], enclosures: [], terminators: [], templates: [] },
      savedViews: [], tours: [], ink: [],
    };
    for (const layoutFrame of [
      { rect: { x: 0, y: 0, width: Number.NaN, height: 10 }, unit: 'pixels' },
      { rect: { x: 0, y: 0, width: 10, height: 10 }, unit: 'furlongs' },
      { rect: { x: 0, y: 0, width: 10 }, unit: 'pixels' },
      { unit: 'pixels' },
    ]) {
      expect(() => new ViewLeader({
        boundary: boundary(), adapters: adapters(),
        initialDocument: JSON.stringify({ ...base, layoutFrame }),
      })).toThrow();
    }
  });

  it('accepts fraction units, which is how a frame survives a resize', () => {
    const fraction: OrganizationRect = { rect: { x: 0.25, y: 0.25, width: 0.5, height: 0.4 }, unit: 'fraction' };
    const leader = withNotes();
    leader.setLayoutFrame(fraction);
    const reopened = new ViewLeader({
      boundary: boundary(), adapters: adapters(), initialDocument: leader.documents.serialize(),
    });
    expect(reopened.layoutFrame).toEqual(fraction);
    leader.dispose();
    reopened.dispose();
  });
});

/** @vitest-environment jsdom */
// audit-close ticket 02: tag text that comes from the model, not from the document.
//
// The document holds a `reference`; a `tagText` host adapter resolves what it says. The resolved
// string is runtime cache — it is never written back, so a save writes the reference and the
// AUTHORED fallback and nothing a resolver ever returned.
//
// Nothing here fakes a canvas: jsdom's deterministic measurement fallback already makes a longer
// string a wider label, which is all the re-measure assertions need.
import { describe, expect, it } from 'vitest';

import {
  UNRESOLVED_TAG_TEXT,
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
  type TagReference,
  type TagTextAdapter,
  type TagTextInvalidation,
  type Unsubscribe,
} from '../src/index.js';

const projection: HostAdapterBundle['projection'] = {
  getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
  project: (point) => ({
    point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
    depth: point.z,
    visible: true,
  }),
};

const WALL: TagReference = { modelId: 'model-a', elementId: 'wall-7', property: 'Mark' };

interface PendingRequest {
  readonly reference: TagReference;
  readonly signal: AbortSignal;
  settle(value: string | null): void;
  fail(cause: unknown): void;
}

/** A host property store that answers when the test says so, and never before. */
interface TagServer {
  readonly adapter: TagTextAdapter;
  readonly requests: PendingRequest[];
  /** Settles the newest outstanding request for `elementId`. The document sorts annotations by id,
   * so request order is not creation order — every answer names what it is answering. */
  answer(elementId: string, value: string | null): void;
  fail(elementId: string, cause: unknown): void;
  /** Fires the adapter's own `subscribe` listener, the way a viewer whose model changed would. */
  notify(invalidation?: TagTextInvalidation): void;
  readonly subscriptions: () => number;
}

function tagServer(options: { readonly subscribable?: boolean } = {}): TagServer {
  const requests: PendingRequest[] = [];
  const listeners = new Set<(invalidation: TagTextInvalidation) => void>();
  const subscribe = (listener: (invalidation: TagTextInvalidation) => void): Unsubscribe => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    adapter: {
      resolve: (reference, signal) => new Promise<string | null>((resolve, reject) => {
        requests.push({
          reference,
          signal,
          settle: resolve,
          fail: reject,
        });
      }),
      ...(options.subscribable === false ? {} : { subscribe }),
    },
    requests,
    answer: (elementId, value) => newest(requests, elementId).settle(value),
    fail: (elementId, cause) => newest(requests, elementId).fail(cause),
    notify: (invalidation = {}) => {
      for (const listener of [...listeners]) listener(invalidation);
    },
    subscriptions: () => listeners.size,
  };
}

function newest(requests: readonly PendingRequest[], elementId: string): PendingRequest {
  const found = [...requests].reverse().find((request) => request.reference.elementId === elementId);
  if (found === undefined) throw new Error(`No tag text request for ${elementId}`);
  return found;
}

const roots = new WeakMap<ViewLeader, HTMLElement>();

function makeLeader(adapters: HostAdapterBundle): ViewLeader {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const leader = new ViewLeader({ boundary: element, adapters });
  roots.set(leader, element);
  return leader;
}

function tag(id: string, extra: Partial<AnnotationDraft> = {}): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    content: { kind: 'tag', text: 'W-00', reference: WALL },
    ...extra,
  };
}

/** What the overlay actually drew for `id`, which is the only thing a drafter can read. */
function drawn(leader: ViewLeader, id: string): string {
  return roots.get(leader)!.querySelector(`[data-annotation-id="${id}"]`)?.textContent ?? '';
}

/** Lets a settled adapter promise reach the manager, then the debounced re-layout reach the frame. */
async function flush(leader: ViewLeader): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  leader.update();
}

describe('live tag text — resolution', () => {
  it('draws the resolved text while the document keeps only the reference', async () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    leader.annotations.create(tag('t1'));
    leader.update();

    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]!.reference).toEqual(WALL);
    server.answer('wall-7', 'W-12');
    await flush(leader);

    expect(drawn(leader, 't1')).toContain('W-12');
    const [stored] = leader.documents.getSnapshot().document.annotations;
    expect(stored!.content).toEqual({ kind: 'tag', text: 'W-00', reference: WALL });
    leader.dispose();
  });

  it('re-measures when the answer lands late, and obeys ticket 03: manual holds, automatic moves', async () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    // `maxWidth` makes the long answer wrap, so the label changes height as well as width — an
    // automatic candidate is offset by half the label's height, so only a height change can prove
    // the position was re-derived rather than left alone.
    leader.annotations.create(tag('pinned', {
      content: { kind: 'tag', text: 'W-00', reference: WALL, maxWidth: 120 },
      placement: { kind: 'manual', position: { x: 120, y: 400 } },
    }));
    leader.annotations.create(tag('auto', {
      content: { kind: 'tag', text: 'W-00', reference: WALL, maxWidth: 120 },
    }));
    leader.update();

    const before = {
      pinned: leader.geometry.of('pinned')!.label,
      auto: leader.geometry.of('auto')!.label,
    };
    // Both tags name the same reference, so one answer resizes both labels at once.
    expect(server.requests).toHaveLength(1);
    server.answer('wall-7', 'EQUIPMENT MARK MECH-204-A FIRE RATED 2HR');
    await flush(leader);

    const after = {
      pinned: leader.geometry.of('pinned')!.label,
      auto: leader.geometry.of('auto')!.label,
    };
    // The labels really did change size, or nothing below proves anything about placement.
    expect(after.pinned.height).toBeGreaterThan(before.pinned.height);
    expect(after.auto.height).toBeGreaterThan(before.auto.height);

    // Manual: the top-left the user chose is untouched; the label grew right and down.
    expect({ x: after.pinned.x, y: after.pinned.y }).toEqual({ x: 120, y: 400 });
    // Automatic: re-derived from the anchor at the new size, not merely left where it was — it
    // lands exactly where a runtime that never saw the unresolved size puts it.
    expect(after.auto.y).not.toBe(before.auto.y);
    const fresh = makeLeader({ projection, tagText: tagServer().adapter });
    fresh.annotations.create(tag('auto', {
      content: { kind: 'tag', text: 'EQUIPMENT MARK MECH-204-A FIRE RATED 2HR', maxWidth: 120 },
    }));
    fresh.update();
    expect(leader.geometry.of('auto')!.label).toEqual(fresh.geometry.of('auto')!.label);
    fresh.dispose();
    leader.dispose();
  });

  it('asks once for a reference two annotations share', async () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    leader.annotations.create(tag('t1'));
    leader.annotations.create(tag('t2'));
    leader.annotations.create(tag('other', {
      content: { kind: 'tag', text: 'D-00', reference: { ...WALL, elementId: 'door-3' } },
    }));
    leader.update();

    expect(server.requests).toHaveLength(2);
    server.answer('wall-7', 'W-12');
    server.answer('door-3', 'D-04');
    await flush(leader);

    expect(drawn(leader, 't1')).toContain('W-12');
    expect(drawn(leader, 't2')).toContain('W-12');
    expect(drawn(leader, 'other')).toContain('D-04');
    // Still one request per reference after many frames: nothing re-asks per frame.
    for (let frame = 0; frame < 5; frame += 1) leader.update();
    expect(server.requests).toHaveLength(2);
    leader.dispose();
  });

  it('updates the text from a subscribe notification, with no reload and no flash of unknown', async () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    leader.annotations.create(tag('t1'));
    leader.update();
    server.answer('wall-7', 'W-12');
    await flush(leader);
    expect(drawn(leader, 't1')).toContain('W-12');

    server.notify({ modelId: 'model-a', elementId: 'wall-7' });
    leader.update();
    // Revalidating, not blanking: the last value holds the frame until the new one arrives.
    expect(drawn(leader, 't1')).toContain('W-12');
    expect(server.requests).toHaveLength(2);

    server.answer('wall-7', 'W-13');
    await flush(leader);
    expect(drawn(leader, 't1')).toContain('W-13');
    leader.dispose();
  });

  it('leaves references the notification did not name alone', async () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    leader.annotations.create(tag('wall'));
    leader.annotations.create(tag('door', {
      content: { kind: 'tag', text: 'D-00', reference: { ...WALL, elementId: 'door-3' } },
    }));
    leader.update();
    server.answer('wall-7', 'W-12');
    server.answer('door-3', 'D-04');
    await flush(leader);

    server.notify({ elementId: 'wall-7' });
    leader.update();

    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]!.reference.elementId).toBe('wall-7');
    leader.dispose();
  });
});

describe('live tag text — unresolved is a real state', () => {
  it('reads as unknown, not as an empty box, before the resolver has answered', () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    leader.annotations.create(tag('t1'));
    leader.update();

    expect(drawn(leader, 't1')).toContain(UNRESOLVED_TAG_TEXT);
    expect(drawn(leader, 't1')).not.toContain('W-00');
    expect(leader.geometry.of('t1')!.label.width).toBeGreaterThan(0);
    leader.dispose();
  });

  it('reports a diagnostic and stays legible when the host answers null', async () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    leader.annotations.create(tag('t1'));
    leader.update();
    server.answer('wall-7', null);
    await flush(leader);

    expect(drawn(leader, 't1')).toContain(UNRESOLVED_TAG_TEXT);
    expect(leader.diagnostics.getSnapshot()).toContainEqual(expect.objectContaining({
      code: 'TAG_TEXT_UNRESOLVED',
      severity: 'warning',
    }));
    // A "no value" answer is not re-asked on every frame.
    for (let frame = 0; frame < 5; frame += 1) leader.update();
    expect(server.requests).toHaveLength(1);
    leader.dispose();
  });

  it('reports a diagnostic and never throws into the frame when the resolver rejects', async () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    leader.annotations.create(tag('t1'));
    leader.update();
    server.fail('wall-7', new Error('property store offline'));
    await flush(leader);

    expect(drawn(leader, 't1')).toContain(UNRESOLVED_TAG_TEXT);
    expect(leader.diagnostics.getSnapshot()).toContainEqual(expect.objectContaining({
      code: 'TAG_TEXT_RESOLUTION_FAILED',
      severity: 'warning',
    }));
    expect(() => leader.update()).not.toThrow();
    leader.dispose();
  });

  it('isolates a resolver that throws synchronously', async () => {
    const leader = makeLeader({
      projection,
      tagText: {
        resolve: () => { throw new Error('adapter is broken'); },
      },
    });
    leader.annotations.create(tag('t1'));
    expect(() => leader.update()).not.toThrow();
    await flush(leader);

    expect(drawn(leader, 't1')).toContain(UNRESOLVED_TAG_TEXT);
    expect(leader.diagnostics.getSnapshot()).toContainEqual(expect.objectContaining({
      code: 'TAG_TEXT_RESOLUTION_FAILED',
    }));
    leader.dispose();
  });

  it('drops a value that has gone away rather than drawing the one it used to have', async () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    leader.annotations.create(tag('t1'));
    leader.update();
    server.answer('wall-7', 'W-12');
    await flush(leader);

    server.notify();
    leader.update();
    server.answer('wall-7', null);
    await flush(leader);

    expect(drawn(leader, 't1')).toContain(UNRESOLVED_TAG_TEXT);
    expect(drawn(leader, 't1')).not.toContain('W-12');
    leader.dispose();
  });
});

describe('live tag text — what it must not touch', () => {
  it('writes nothing and adds no history entry, however many resolutions land', async () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    leader.annotations.create(tag('t1'));
    leader.update();
    const before = {
      history: leader.history.getSnapshot().undoCount,
      revision: leader.documents.getSnapshot().documentRevision,
      serialized: leader.documents.serialize(),
    };

    server.answer('wall-7', 'W-12');
    await flush(leader);
    server.notify();
    leader.update();
    server.answer('wall-7', 'W-13');
    await flush(leader);

    expect(drawn(leader, 't1')).toContain('W-13');
    expect(leader.history.getSnapshot().undoCount).toBe(before.history);
    expect(leader.documents.getSnapshot().documentRevision).toBe(before.revision);
    // THE SAVE DECISION: the reference plus the AUTHORED fallback. Not one resolved byte.
    expect(leader.documents.serialize()).toBe(before.serialized);
    expect(before.serialized).toContain('W-00');
    expect(before.serialized).not.toContain('W-12');
    leader.dispose();
  });

  it('does not write an answer that arrives for a deleted annotation', async () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    leader.annotations.create(tag('t1'));
    leader.update();
    const request = server.requests[0]!;

    leader.annotations.remove('t1');
    expect(request.signal.aborted).toBe(true);
    request.settle('W-12');
    await flush(leader);

    // Re-created with the same reference: a write that leaked past the abort would show here as a
    // tag that is already resolved without anyone having asked again.
    leader.annotations.create(tag('t1'));
    leader.update();
    expect(drawn(leader, 't1')).toContain(UNRESOLVED_TAG_TEXT);
    expect(drawn(leader, 't1')).not.toContain('W-12');
    expect(server.requests).toHaveLength(2);
    leader.dispose();
  });

  it('releases its subscription on dispose', () => {
    const server = tagServer();
    const leader = makeLeader({ projection, tagText: server.adapter });
    expect(server.subscriptions()).toBe(1);
    leader.dispose();
    expect(server.subscriptions()).toBe(0);
    expect(() => server.notify()).not.toThrow();
  });
});

describe('live tag text — a host that never opted in', () => {
  it('draws the authored text with no adapter, exactly as before this existed', () => {
    const leader = makeLeader({ projection });
    leader.annotations.create(tag('referenced'));
    leader.annotations.create(tag('plain', {
      content: { kind: 'tag', text: 'W-99' },
    }));
    leader.update();

    // Even a referenced tag: with nobody to ask, the author's text is the best answer there is.
    expect(drawn(leader, 'referenced')).toContain('W-00');
    expect(drawn(leader, 'plain')).toContain('W-99');
    expect(leader.diagnostics.getSnapshot()).toEqual([]);
    leader.dispose();
  });

  it('works with an adapter that offers no subscribe at all', async () => {
    const server = tagServer({ subscribable: false });
    const leader = makeLeader({ projection, tagText: server.adapter });
    leader.annotations.create(tag('t1'));
    leader.update();
    server.answer('wall-7', 'W-12');
    await flush(leader);

    expect(drawn(leader, 't1')).toContain('W-12');
    leader.dispose();
  });
});

describe('live tag text — the document boundary', () => {
  it('round-trips a reference through serialize and parse', () => {
    const leader = makeLeader({ projection });
    leader.annotations.create(tag('t1'));
    const reloaded = leader.documents.parse(leader.documents.serialize());
    expect(reloaded.annotations[0]!.content).toEqual({
      kind: 'tag',
      text: 'W-00',
      reference: WALL,
    });
    leader.dispose();
  });

  it('refuses a reference that is not an opaque, non-empty identifier', () => {
    const leader = makeLeader({ projection });
    for (const reference of [
      { modelId: '', elementId: 'wall-7', property: 'Mark' },
      { modelId: 'model-a', elementId: 'wall-7', property: '' },
      { modelId: 'model-a', elementId: 'wall\u00007', property: 'Mark' },
    ]) {
      expect(() => leader.annotations.create(tag('bad', {
        content: { kind: 'tag', text: 'W-00', reference },
      }))).toThrow(/tag reference/u);
    }
    leader.dispose();
  });
});

/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import {
  DisposedError,
  InvalidDocumentError,
  ViewLeader,
  type Anchor,
  type AnnotationDraft,
  type ElementResolution,
  type HostAdapterBundle,
} from '../src/index.js';

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function adapters(
  overrides: Partial<HostAdapterBundle> = {},
): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 2 }),
      project: (point) => ({
        point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
        depth: point.z,
        visible: true,
      }),
    },
    ...overrides,
  };
}

function note(id: string, text = id): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
    content: { kind: 'plain-note', text },
  };
}

describe('fresh v1 core vertical slice', () => {
  it('skips unchanged revision-aware projection frames and renders every invalidation', () => {
    const root = boundary();
    let projectionRevision = 0;
    const project = vi.fn((point: { x: number; y: number; z: number }) => ({
      point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
      depth: point.z,
      visible: true,
    }));
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({
        projection: {
          getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 2 }),
          getRevision: () => projectionRevision,
          project,
        },
      }),
    });
    leader.annotations.create(note('revision-aware'));
    leader.update();
    expect(project).toHaveBeenCalled();

    project.mockClear();
    leader.update();
    expect(project).not.toHaveBeenCalled();

    projectionRevision += 1;
    leader.update();
    expect(project).toHaveBeenCalled();

    project.mockClear();
    leader.annotations.update('revision-aware', {
      content: { kind: 'plain-note', text: 'Invalidated' },
    });
    leader.update();
    expect(project).toHaveBeenCalled();
    leader.dispose();
  });

  it('creates, queries, updates, selects, removes, and disposes through grouped capabilities', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    const created = leader.annotations.create(note('note-a', 'Hello'));
    expect(created.id).toBe('note-a');
    expect(leader.annotations.get('note-a')).toEqual(created);
    expect(Object.isFrozen(created)).toBe(true);
    expect(leader.annotations.getSnapshot()).toMatchObject({
      documentRevision: 1,
      annotations: [{ id: 'note-a', anchorStatuses: ['resolved'] }],
    });

    const selectedRevision = leader.annotations.getSnapshot().runtimeRevision;
    leader.annotations.select(['note-a']);
    expect(leader.annotations.getSnapshot()).toMatchObject({
      documentRevision: 1,
      selectedIds: ['note-a'],
    });
    expect(leader.annotations.getSnapshot().runtimeRevision).toBeGreaterThan(selectedRevision);

    const updated = leader.annotations.update('note-a', {
      content: { kind: 'plain-note', text: 'Updated' },
    });
    expect(updated.content).toEqual({ kind: 'plain-note', text: 'Updated' });
    expect(leader.annotations.remove('note-a')).toEqual(updated);
    expect(leader.annotations.getSnapshot().annotations).toEqual([]);

    // A method handed out before disposal — to `useSyncExternalStore`, say — keeps one identity
    // and still refuses afterwards; a detached class method still reaches its own instance.
    const { getSnapshot } = leader.annotations;
    const { list } = leader.definitions;
    expect(leader.annotations.getSnapshot).toBe(getSnapshot);
    expect(list().length).toBeGreaterThan(0);
    leader.dispose();
    leader.dispose();
    expect(root.querySelector('[data-viewleader-overlay]')).toBeNull();
    expect(root.querySelector('[data-viewleader-status]')).toBeNull();
    expect(() => leader.update()).toThrow(DisposedError);
    expect(() => leader.annotations.getSnapshot()).toThrow(DisposedError);
    expect(() => getSnapshot()).toThrow(DisposedError);
    expect(() => list()).toThrow(DisposedError);
  });

  it('serializes deterministically and rejects replacement without observable mutation', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    leader.annotations.create(note('z-note'));
    leader.annotations.create(note('a-note'));
    const before = leader.documents.getSnapshot();
    const bytes = leader.documents.serialize();
    expect(bytes.indexOf('a-note')).toBeLessThan(bytes.indexOf('z-note'));
    expect(leader.documents.serialize()).toBe(bytes);

    expect(() => leader.documents.replace('{"version":1}')).toThrow(InvalidDocumentError);
    expect(leader.documents.getSnapshot()).toEqual(before);
    expect(leader.documents.serialize()).toBe(bytes);

    const replaced = leader.documents.replace(bytes);
    expect(replaced).toEqual(before.document);
    expect(leader.documents.getSnapshot().documentRevision).toBe(
      before.documentRevision + 1,
    );
    expect(leader.history.getSnapshot()).toMatchObject({
      undoCount: 0,
      redoCount: 0,
    });
    leader.dispose();
  });

  it('rejects unsafe host-image content before create, update, or replacement commits', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    let notifications = 0;
    const unsubscribe = leader.documents.subscribe(() => {
      notifications += 1;
    });

    for (const reference of [
      'https://attacker.invalid/image.png',
      'x'.repeat(513),
    ]) {
      expect(() => leader.annotations.create({
        id: `unsafe-${reference.length}`,
        anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
        content: { kind: 'host-image', reference, alt: 'Unsafe image' },
      })).toThrowError(expect.objectContaining({ code: 'INVALID_IMAGE' }));
    }
    expect(leader.documents.getSnapshot().documentRevision).toBe(0);
    expect(leader.history.getSnapshot().undoCount).toBe(0);
    expect(notifications).toBe(0);

    leader.annotations.create(note('safe'));
    notifications = 0;
    const before = leader.documents.serialize();
    const beforeHistory = leader.history.getSnapshot();
    expect(() => leader.annotations.update('safe', {
      content: {
        kind: 'host-image',
        reference: 'data:image/png;base64,unsafe',
        alt: 'Unsafe image',
      },
    })).toThrowError(expect.objectContaining({ code: 'INVALID_IMAGE' }));

    expect(leader.documents.serialize()).toBe(before);
    expect(leader.history.getSnapshot()).toMatchObject({
      documentRevision: beforeHistory.documentRevision,
      undoCount: beforeHistory.undoCount,
      redoCount: beforeHistory.redoCount,
    });
    expect(notifications).toBe(0);

    // A saved file carrying it is a different tier: unsafe is corrupt, not future, so the one
    // annotation is dropped with a diagnostic naming it and the rest of the document still loads.
    const replacement = JSON.parse(before) as {
      annotations: Array<{ content: unknown }>;
    };
    replacement.annotations[0]!.content = {
      kind: 'host-image',
      reference: '//attacker.invalid/image.png',
      alt: 'Unsafe image',
    };
    const loaded = leader.documents.replace(replacement as never);
    expect(loaded.annotations).toEqual([]);
    expect(leader.documents.serialize()).not.toContain('attacker.invalid');
    expect(leader.diagnostics.getSnapshot()).toContainEqual(
      expect.objectContaining({ code: 'document.annotation-skipped', annotationId: 'safe' }),
    );

    unsubscribe();
    leader.dispose();
  });

  it('does not acquire runtime resources when initial-document validation fails', () => {
    const root = boundary();
    const disconnect = vi.fn();
    const connect = vi.fn(() => disconnect);

    expect(() => new ViewLeader({
      boundary: root,
      adapters: adapters({
        projection: {
          ...adapters().projection,
          connect,
        },
      }),
      initialDocument: '{invalid json',
    })).toThrow(InvalidDocumentError);

    expect(connect).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    expect(root.querySelector('[data-viewleader-overlay]')).toBeNull();
    expect(root.querySelector('[data-viewleader-status]')).toBeNull();
  });

  it('unwinds staged host, plugin, and DOM resources when runtime initialization fails', () => {
    const root = boundary();
    const disconnect = vi.fn();
    const pluginCleanup = vi.fn();
    expect(() => new ViewLeader({
      boundary: root,
      plugins: [{
        id: 'fixture.cleanup',
        coreApiRange: '^1.0.0',
        schemaVersion: 1,
        validate: () => undefined,
        setup: ({ registerCleanup }) => registerCleanup(pluginCleanup),
      }],
      adapters: {
        projection: {
          connect: () => disconnect,
          getViewport: () => { throw new Error('viewport failed'); },
          project: () => null,
        },
      },
    })).toThrow('viewport failed');
    expect(disconnect).toHaveBeenCalledOnce();
    expect(pluginCleanup).toHaveBeenCalledOnce();
    expect(root.querySelector('[data-viewleader-overlay]')).toBeNull();
    expect(root.querySelector('[data-viewleader-status]')).toBeNull();
  });

  it('unwinds runtime and DOM resources when authoring construction fails', () => {
    const root = boundary();
    const appendChild = root.appendChild.bind(root);
    let appends = 0;
    Object.defineProperty(root, 'appendChild', {
      configurable: true,
      value: (node: Node) => {
        appends += 1;
        if (appends === 2) throw new Error('status append failed');
        return appendChild(node);
      },
    });
    const disconnect = vi.fn();

    expect(() => new ViewLeader({
      boundary: root,
      adapters: adapters({
        projection: {
          ...adapters().projection,
          connect: () => disconnect,
        },
      }),
    })).toThrow('status append failed');

    expect(disconnect).toHaveBeenCalledOnce();
    expect(root.querySelector('[data-viewleader-overlay]')).toBeNull();
    expect(root.querySelector('[data-viewleader-status]')).toBeNull();
  });

  it('unwinds a staged host connection when overlay construction fails', () => {
    const root = boundary();
    const appendChild = root.appendChild.bind(root);
    Object.defineProperty(root, 'appendChild', {
      configurable: true,
      value: (node: Node) => {
        appendChild(node);
        throw new Error('overlay append failed');
      },
    });
    const disconnect = vi.fn();

    expect(() => new ViewLeader({
      boundary: root,
      adapters: adapters({
        projection: {
          ...adapters().projection,
          connect: () => disconnect,
        },
      }),
    })).toThrow('overlay append failed');

    expect(disconnect).toHaveBeenCalledOnce();
    expect(root.querySelector('[data-viewleader-overlay]')).toBeNull();
  });

  it('publishes replacement only after built-in authoring cancellation is coherent', async () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    const outcome = leader.authoring.start({
      draft: { id: 'pending', content: { kind: 'plain-note', text: 'Pending' } },
    });
    const observed: Array<Readonly<{ revision: number; phase: string }>> = [];
    const unsubscribe = leader.documents.subscribe(() => {
      observed.push({
        revision: leader.documents.getSnapshot().documentRevision,
        phase: leader.authoring.getSnapshot().phase,
      });
    });

    leader.documents.replace(leader.documents.serialize());

    expect(observed).toEqual([{ revision: 1, phase: 'idle' }]);
    await expect(outcome).resolves.toEqual({
      status: 'cancelled',
      reason: 'document-replaced',
    });
    unsubscribe();
    leader.dispose();
  });

  it('publishes replacement only after managed markup cancellation is coherent', async () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    const outcome = leader.authoring.markup.start({
      kind: 'rectangle',
      draft: { id: 'region', content: { kind: 'plain-note', text: 'Region' } },
    });
    const phases: string[] = [];
    const unsubscribe = leader.documents.subscribe(() => {
      phases.push(leader.authoring.markup.getSnapshot().phase);
    });

    leader.documents.replace(leader.documents.serialize());

    expect(phases).toEqual(['idle']);
    await expect(outcome).resolves.toEqual({
      status: 'cancelled',
      reason: 'document-replaced',
    });
    unsubscribe();
    leader.dispose();
  });

  it('publishes replacement only after plugin authoring cancellation is coherent', () => {
    const leader = new ViewLeader({
      boundary: boundary(),
      adapters: adapters(),
      plugins: [{
        id: 'fixture.replacement',
        coreApiRange: '^1.0.0',
        schemaVersion: 1,
        validate: () => undefined,
        tools: [{
          id: 'author',
          initialState: {},
          transition: (state) => ({ state }),
        }],
      }],
    });
    leader.authoring.plugins.start({
      pluginId: 'fixture.replacement',
      toolId: 'author',
    });
    const phases: string[] = [];
    const unsubscribe = leader.documents.subscribe(() => {
      phases.push(leader.authoring.plugins.getSnapshot().phase);
    });

    leader.documents.replace(leader.documents.serialize());

    expect(phases).toEqual(['idle']);
    unsubscribe();
    leader.dispose();
  });

  it('finishes every owned cleanup even when a plugin rejects dispose cancellation', () => {
    const root = boundary();
    const disconnect = vi.fn();
    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters({
        projection: {
          ...adapters().projection,
          connect: () => disconnect,
        },
      }),
      plugins: [{
        id: 'fixture.throwing-dispose',
        coreApiRange: '^1.0.0',
        schemaVersion: 1,
        validate: () => undefined,
        tools: [{
          id: 'author',
          initialState: {},
          transition: (state, input) => {
            if (input.kind === 'cancel' && input.reason === 'disposed') {
              throw new Error('plugin refused disposal');
            }
            return { state };
          },
        }],
      }],
    });
    leader.authoring.plugins.start({
      pluginId: 'fixture.throwing-dispose',
      toolId: 'author',
    });

    expect(() => leader.dispose()).toThrow(AggregateError);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(root.querySelector('[data-viewleader-overlay]')).toBeNull();
    expect(root.querySelector('[data-viewleader-status]')).toBeNull();
    expect(() => leader.update()).toThrow(DisposedError);
    expect(() => leader.dispose()).not.toThrow();
  });

  it('replays construction-time diagnostics through the public diagnostics snapshot', () => {
    const root = boundary();
    const seed = new ViewLeader({ boundary: root, adapters: adapters() });
    const document = JSON.parse(seed.documents.serialize()) as {
      pluginEnvelopes: unknown[];
    };
    seed.dispose();
    document.pluginEnvelopes.push({
      pluginId: 'fixture.missing',
      recordType: 'content',
      schemaVersion: 1,
      data: { preserved: true },
    });

    const leader = new ViewLeader({
      boundary: root,
      adapters: adapters(),
      initialDocument: document as never,
    });

    expect(leader.diagnostics.getSnapshot()).toEqual([
      expect.objectContaining({ code: 'PLUGIN_MISSING', severity: 'warning' }),
    ]);
    leader.dispose();
  });

  it('groups nested transactions, suppresses no-ops, bounds history, and invalidates redo', () => {
    const leader = new ViewLeader({
      boundary: boundary(),
      adapters: adapters(),
      historyCapacity: 2,
    });
    leader.history.transaction('Grouped edit', () => {
      leader.annotations.create(note('one'));
      leader.history.transaction('Nested label is folded', () => {
        leader.annotations.create(note('two'));
      });
    });
    expect(leader.documents.getSnapshot().documentRevision).toBe(1);
    expect(leader.history.getSnapshot()).toMatchObject({ undoCount: 1, undoLabel: 'Grouped edit' });

    const revision = leader.documents.getSnapshot().documentRevision;
    leader.annotations.update('one', {});
    expect(leader.documents.getSnapshot().documentRevision).toBe(revision);
    leader.annotations.update('one', { content: { kind: 'plain-note', text: 'changed' } });
    leader.annotations.update('two', { content: { kind: 'plain-note', text: 'changed' } });
    expect(leader.history.getSnapshot().undoCount).toBe(2);
    expect(leader.history.undo()).toBe(true);
    expect(leader.history.getSnapshot().redoCount).toBe(1);
    leader.annotations.update('two', { content: { kind: 'plain-note', text: 'branch' } });
    expect(leader.history.getSnapshot().redoCount).toBe(0);
    leader.dispose();
  });

  it('keeps element fallback visible, converges without durable mutation, and ignores stale results', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<ElementResolution | null>>>();
    const leader = new ViewLeader({
      boundary: boundary(),
      adapters: adapters({
        elements: {
          resolve: ({ modelId, elementId }) => {
            const request = deferred<ElementResolution | null>();
            pending.set(`${modelId}/${elementId}`, request);
            return request.promise;
          },
        },
      }),
    });
    leader.annotations.create({
      id: 'element-note',
      anchor: elementAnchor('model-a', 'same-id', { x: 1, y: 1, z: 1 }),
      content: { kind: 'tag', text: 'Door' },
    });
    const canonical = leader.documents.serialize();
    const documentRevision = leader.documents.getSnapshot().documentRevision;
    expect(leader.annotations.getSnapshot().annotations[0]).toMatchObject({
      anchorStatuses: ['unresolved'],
      resolvedWorldPoints: [{ x: 1, y: 1, z: 1 }],
    });

    const first = pending.get('model-a/same-id');
    expect(first).toBeDefined();
    leader.annotations.retarget(
      'element-note',
      elementAnchor('model-b', 'same-id', { x: 2, y: 2, z: 2 }),
    );
    first?.resolve({ worldPoint: { x: 100, y: 100, z: 100 } });
    await settle();
    expect(leader.annotations.getSnapshot().annotations[0]).toMatchObject({
      anchorStatuses: ['unresolved'],
      resolvedWorldPoints: [{ x: 2, y: 2, z: 2 }],
    });

    pending.get('model-b/same-id')?.resolve({ worldPoint: { x: 9, y: 8, z: 7 } });
    await settle();
    expect(leader.annotations.getSnapshot().annotations[0]).toMatchObject({
      anchorStatuses: ['resolved'],
      resolvedWorldPoints: [{ x: 9, y: 8, z: 7 }],
    });
    expect(leader.documents.getSnapshot().documentRevision).toBe(documentRevision + 1);
    expect(leader.documents.serialize()).not.toBe(canonical); // retarget is the only durable change
    const afterRetarget = leader.documents.serialize();
    await settle();
    expect(leader.documents.serialize()).toBe(afterRetarget);
    leader.dispose();
  });

  it('cancels pending authoring normally, restores the lease, and rejects late picks', async () => {
    const pick = deferred<Anchor | null>();
    const release = vi.fn();
    const leader = new ViewLeader({
      boundary: boundary(),
      adapters: adapters({
        picking: { pick: () => pick.promise },
        interaction: { acquire: () => ({ release }) },
      }),
    });
    const outcome = leader.authoring.start({
      draft: { id: 'authored', content: { kind: 'plain-note', text: 'Pending' } },
    });
    void leader.authoring.pointerDown(pointer());
    await settle();
    expect(leader.authoring.getSnapshot().pendingPick).toBe(true);
    expect(leader.authoring.cancel()).toEqual({ status: 'cancelled', reason: 'host' });
    expect(await outcome).toEqual({ status: 'cancelled', reason: 'host' });
    expect(release).toHaveBeenCalledOnce();
    pick.resolve({ kind: 'world-point', point: { x: 4, y: 4, z: 0 } });
    await settle();
    expect(leader.annotations.getSnapshot().annotations).toEqual([]);
    expect(leader.history.getSnapshot().undoCount).toBe(0);

    const completed = await leader.authoring.start({
      draft: { id: 'programmatic', content: { kind: 'plain-note', text: 'Done' } },
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
    });
    expect(completed).toMatchObject({ status: 'completed', annotation: { id: 'programmatic' } });
    expect(leader.history.getSnapshot().undoCount).toBe(1);
    leader.dispose();
  });

  it('renders stable accessible SVG for every built-in content kind', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    const contents: readonly AnnotationDraft['content'][] = [
      { kind: 'plain-note', text: 'English العربية', direction: 'auto' },
      { kind: 'tag', text: 'T-01' },
      { kind: 'callout', title: 'Title', text: 'Body' },
      { kind: 'split-callout', primary: 'A', secondary: 'B' },
      { kind: 'symbolic-block', symbol: 'diamond', label: 'D' },
    ];
    contents.forEach((content, index) => leader.annotations.create({
      id: `content-${index}`,
      anchor: { kind: 'world-point', point: { x: index, y: index, z: 0 } },
      content,
    }));
    leader.update();
    const first = root.innerHTML;
    leader.update();
    expect(root.innerHTML).toBe(first);
    const overlay = root.querySelector<SVGSVGElement>('[data-viewleader-overlay]');
    expect(overlay?.style.pointerEvents).toBe('none');
    expect(overlay?.querySelectorAll('[role="button"]')).toHaveLength(5);
    expect(overlay?.querySelectorAll('[data-hit-target="leader"]')).toHaveLength(5);
    expect(overlay?.textContent).toContain('العربية');
    leader.dispose();
  });

  it('forwards a wheel swallowed by a label to a canvas beside the boundary, once', () => {
    const root = boundary();
    // The read-only shape: the boundary is a sibling div over the canvas, so a wheel that lands on
    // a label never reaches the canvas on its own.
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    const delivered: WheelEvent[] = [];
    canvas.addEventListener('wheel', (event) => delivered.push(event as WheelEvent));
    const leader = new ViewLeader({ boundary: root, adapters: adapters(), forwardWheelTo: canvas });
    leader.annotations.create(note('a1'));
    leader.update();

    const label = root.querySelector('[data-hit-target="label"]');
    expect(label).not.toBeNull();
    const swallowed = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    label!.dispatchEvent(swallowed);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.deltaY).toBe(120);
    // Prevented as well as forwarded: the page must not scroll behind the viewer.
    expect(swallowed.defaultPrevented).toBe(true);

    leader.dispose();
    // Dispatched on the boundary itself — the overlay, and the label with it, is gone after
    // dispose, so nothing but a still-registered listener could forward this one.
    root.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
    expect(delivered).toHaveLength(1);
  });

  it('does not re-deliver a wheel that already passed through a canvas inside the boundary', () => {
    const root = boundary();
    // The shape the README documents: the canvas is the boundary's own child, so a wheel on the
    // canvas bubbles up to the overlay's listener having already been delivered. Forwarding it
    // again would dispatch it back onto the canvas, which bubbles up here again — recursion, not a
    // double count, which is why the guard reads the composed path rather than the event's target.
    const canvas = document.createElement('canvas');
    root.appendChild(canvas);
    const delivered: WheelEvent[] = [];
    canvas.addEventListener('wheel', (event) => delivered.push(event as WheelEvent));
    const leader = new ViewLeader({ boundary: root, adapters: adapters(), forwardWheelTo: canvas });
    leader.update();

    canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));

    expect(delivered).toHaveLength(1);
    leader.dispose();
  });
});

function elementAnchor(modelId: string, elementId: string, fallbackPoint: { x: number; y: number; z: number }): Anchor {
  return { kind: 'element', modelId, elementId, fallbackPoint };
}

function pointer() {
  return {
    x: 0.5,
    y: 0.5,
    button: 0,
    buttons: 1,
    pointerType: 'mouse' as const,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

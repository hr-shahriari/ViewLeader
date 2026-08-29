/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { ViewLeader, type AnnotationDraft, type HostAdapterBundle } from '../src/index.js';
import { subscribeFrame } from '../src/internal/frame-seam.js';

/**
 * The seam exists because a camera move fires no DOM event, and `subscribe` only reports state
 * changes — so an orbit that moves every label on screen notifies nobody. It must fire for frames
 * that were actually drawn, and stay quiet for the ones `update()` skips.
 */

function adapters(revision: () => number): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
      getRevision: () => revision(),
      project: (point) => ({
        point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
        depth: point.z,
        visible: true,
      }),
    },
  };
}

function note(id: string): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
    content: { kind: 'plain-note', text: id },
  };
}

function build(revision: () => number): ViewLeader {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const leader = new ViewLeader({ boundary: element, adapters: adapters(revision) });
  leader.annotations.create(note('a'));
  return leader;
}

describe('the internal post-frame seam', () => {
  it('fires for a drawn frame and stays quiet for a skipped one', () => {
    let revision = 1;
    const leader = build(() => revision);
    let frames = 0;
    const stop = subscribeFrame(leader, () => { frames += 1; });

    leader.update();
    const afterFirst = frames;
    expect(afterFirst).toBeGreaterThan(0);

    // Nothing moved and nothing invalidated: `update()` returns at its gate.
    leader.update();
    expect(frames).toBe(afterFirst);

    // A camera move — no DOM event anywhere, which is exactly why this seam exists.
    revision = 2;
    leader.update();
    expect(frames).toBe(afterFirst + 1);

    stop();
    revision = 3;
    leader.update();
    expect(frames).toBe(afterFirst + 1);
    leader.dispose();
  });

  it('keeps one listener’s failure from stopping the frame or its siblings', () => {
    let revision = 1;
    const leader = build(() => revision);
    const seen: string[] = [];
    subscribeFrame(leader, () => { throw new Error('writer blew up'); });
    subscribeFrame(leader, () => { seen.push('second'); });

    expect(() => leader.update()).not.toThrow();
    expect(seen).toContain('second');
    leader.dispose();
  });

  it('detaches every listener when the instance is disposed', () => {
    let revision = 1;
    const leader = build(() => revision);
    let frames = 0;
    subscribeFrame(leader, () => { frames += 1; });
    leader.update();
    const before = frames;
    leader.dispose();
    revision = 2;
    expect(frames).toBe(before);
  });

  it('is honestly inert when subscribed to after disposal', () => {
    // A disposed instance cannot produce another frame, so the subscription must not look live.
    // Previously the owner still resolved to its dead emitter and this returned a plausible
    // unsubscribe for a listener nothing would ever call.
    const leader = build(() => 1);
    leader.dispose();

    let frames = 0;
    const stop = subscribeFrame(leader, () => { frames += 1; });
    // The inert path registers nothing at all, so re-subscribing and unsubscribing stay harmless.
    expect(() => stop()).not.toThrow();
    expect(frames).toBe(0);
  });

  it('hands back an inert unsubscribe for something it never linked', () => {
    const stop = subscribeFrame({}, () => undefined);
    expect(() => stop()).not.toThrow();
  });
});

/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  KEYNOTE_METADATA_KEY,
  ViewLeader,
  type AnnotationDraft,
  type HostAdapterBundle,
} from '../src/index.js';

function boundary(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function adapters(): HostAdapterBundle {
  return {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 2 }),
      project: (point) => ({
        point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
        depth: point.z,
        visible: true,
      }),
    },
  };
}

function note(id: string, keynote?: string): AnnotationDraft {
  return {
    id,
    anchor: { kind: 'world-point', point: { x: 1, y: 2, z: 0 } },
    content: { kind: 'plain-note', text: id },
    ...(keynote === undefined ? {} : { metadata: { [KEYNOTE_METADATA_KEY]: keynote } }),
  };
}

describe('keynotes: metadata convention + query helper', () => {
  it('natural-sorts real NCS UDS-7 keys instead of lexicographically, and pairs each with its annotations', () => {
    // Real NCS-shaped keys, deliberately out of order, covering: a bare category with no keynote
    // suffix at all, a bare-digit suffix next to a lettered one, a deeper sub-segment ('A1.2') that
    // gives its sibling an unequal run count, and leading zeros ('A09' vs 'A9' — the same number,
    // ordered by plain string as a convention) next to the headline case the ticket names ('A3'
    // before 'A10' — the pair a lexicographic sort gets backwards, since 'A10' < 'A3' when
    // compared as plain strings).
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    leader.annotations.create(note('n-a10', '09 91 23.A10'));
    leader.annotations.create(note('n-a3', '09 91 23.A3'));
    leader.annotations.create(note('n-a9', '09 91 23.A9'));
    leader.annotations.create(note('n-a09', '09 91 23.A09'));
    leader.annotations.create(note('n-base', '09 91 23'));
    leader.annotations.create(note('n-bare3', '09 91 23.3'));
    leader.annotations.create(note('n-a1-2', '09 91 23.A1.2'));
    leader.annotations.create(note('n-a1', '09 91 23.A1'));
    // A second annotation on an existing key, to pin the "annotations using it" half of the query.
    leader.annotations.create(note('n-a3-second', '09 91 23.A3'));

    const keys = leader.annotations.keynotes().map((entry) => entry.key);
    expect(keys).toEqual([
      '09 91 23',
      '09 91 23.3',
      '09 91 23.A1',
      '09 91 23.A1.2',
      '09 91 23.A3',
      '09 91 23.A09',
      '09 91 23.A9',
      '09 91 23.A10',
    ]);

    // The headline acceptance case, stated directly rather than only via transitivity above.
    expect(keys.indexOf('09 91 23.A3')).toBeLessThan(keys.indexOf('09 91 23.A10'));

    const a3 = leader.annotations.keynotes().find((entry) => entry.key === '09 91 23.A3');
    expect(a3?.annotationIds).toEqual(['n-a3', 'n-a3-second']);

    leader.dispose();
  });

  it('does not let a leading zero change order relative to the same number without one', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    leader.annotations.create(note('n-a10', '09 91 23.A10'));
    leader.annotations.create(note('n-a09', '09 91 23.A09'));
    leader.annotations.create(note('n-a9', '09 91 23.A9'));

    const keys = leader.annotations.keynotes().map((entry) => entry.key);
    // A9 and A09 are the same keynote written two ways; both must still land before A10, exactly
    // as they would if neither carried a leading zero.
    expect(keys.indexOf('09 91 23.A9')).toBeLessThan(keys.indexOf('09 91 23.A10'));
    expect(keys.indexOf('09 91 23.A09')).toBeLessThan(keys.indexOf('09 91 23.A10'));

    leader.dispose();
  });

  it('orders keys of unequal segment count sensibly instead of throwing', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    leader.annotations.create(note('n-deep', '09 91 23.A1.2'));
    leader.annotations.create(note('n-shallow', '09 91 23.A1'));
    leader.annotations.create(note('n-base', '09 91 23'));

    expect(() => leader.annotations.keynotes()).not.toThrow();
    const keys = leader.annotations.keynotes().map((entry) => entry.key);
    expect(keys).toEqual(['09 91 23', '09 91 23.A1', '09 91 23.A1.2']);

    leader.dispose();
  });

  it('orders a letter suffix present on one sibling and absent on another without throwing', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    leader.annotations.create(note('n-lettered', '09 91 23.A3'));
    leader.annotations.create(note('n-bare', '09 91 23.3'));

    expect(() => leader.annotations.keynotes()).not.toThrow();
    const keys = leader.annotations.keynotes().map((entry) => entry.key);
    expect(keys).toEqual(['09 91 23.3', '09 91 23.A3']);

    leader.dispose();
  });

  it('leaves an annotation with no keynote out of the result entirely, not as a null entry', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    leader.annotations.create(note('n-keyed', '09 91 23.A3'));
    leader.annotations.create(note('n-unkeyed'));

    const entries = leader.annotations.keynotes();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.key).toBe('09 91 23.A3');
    expect(entries.some((entry) => entry.key === null || entry.key === undefined)).toBe(false);
    expect(entries.flatMap((entry) => entry.annotationIds)).not.toContain('n-unkeyed');

    leader.dispose();
  });

  it('is stable: the same document yields the same order every call', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    leader.annotations.create(note('n-a10', '09 91 23.A10'));
    leader.annotations.create(note('n-a3', '09 91 23.A3'));
    leader.annotations.create(note('n-a9', '09 91 23.A9'));

    const first = leader.annotations.keynotes();
    const second = leader.annotations.keynotes();
    expect(second).toEqual(first);

    leader.dispose();
  });

  it('adds a keynote as an ordinary metadata write, with no dedicated mutation verb', () => {
    const root = boundary();
    const leader = new ViewLeader({ boundary: root, adapters: adapters() });
    const created = leader.annotations.create(note('n-plain'));
    expect(leader.annotations.keynotes()).toHaveLength(0);

    leader.annotations.update(created.id, {
      metadata: { ...created.metadata, [KEYNOTE_METADATA_KEY]: '09 91 23.A3' },
    });

    const entries = leader.annotations.keynotes();
    expect(entries).toEqual([{ key: '09 91 23.A3', annotationIds: ['n-plain'] }]);

    leader.dispose();
  });
});

// The leading-zero rule has two forms, and only one of them was covered. A zero in the LAST run
// ('A09' vs 'A9') is harmless however it is implemented, because there is nothing after it to
// outrank. A zero in an EARLIER run is the real test: it must break a tie, never outrank the
// segment that actually differs. The first cut returned on it immediately, which sorted
// '9 91 23.A3' ahead of '09 91 03.A1' — a leading zero deciding a comparison that a different
// section number should have decided.
describe('keynotes: a leading zero breaks ties, it does not dominate', () => {
  it('does not let a zero in an early segment outrank a later segment that differs', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    for (const [id, key] of [
      ['a', '9 91 23.A3'],
      ['b', '09 91 03.A1'],
      ['c', '09 91 23.A3'],
    ] as const) {
      leader.annotations.create(note(id, key));
    }
    const keys = leader.annotations.keynotes().map((entry) => entry.key);

    // Section 03 precedes section 23 whichever way the first segment is written.
    expect(keys.indexOf('09 91 03.A1')).toBeLessThan(keys.indexOf('9 91 23.A3'));
    // And the two spellings of the same key stay neighbours.
    expect(Math.abs(keys.indexOf('9 91 23.A3') - keys.indexOf('09 91 23.A3'))).toBe(1);
    leader.dispose();
  });

  it('compares letters case-insensitively first, so a1 lands beside A1 rather than after Z', () => {
    // Collator order, not code-point order: 'B1' < 'a1' as code points, which would file every
    // lower-case key after every upper-case one.
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    leader.annotations.create(note('k0', 'B1'));
    leader.annotations.create(note('k1', 'a1'));
    leader.annotations.create(note('k2', 'A1'));
    expect(leader.annotations.keynotes().map((entry) => entry.key)).toEqual(['a1', 'A1', 'B1']);
    leader.dispose();
  });

  it('is a total order: every pair has a stable, consistent direction', () => {
    const keys = ['9 91 23.A3', '09 91 23.A3', '09 91 03.A1', '09 91 23', '09 91 23.A10'];
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    keys.forEach((key, index) => leader.annotations.create(note(`k${index}`, key)));
    const order = leader.annotations.keynotes().map((entry) => entry.key);

    // Sorting the same set from a different starting arrangement must land in the same order.
    const other = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    [...keys].reverse().forEach((key, index) => other.annotations.create(note(`k${index}`, key)));
    expect(other.annotations.keynotes().map((entry) => entry.key)).toEqual(order);
    leader.dispose();
    other.dispose();
  });
});

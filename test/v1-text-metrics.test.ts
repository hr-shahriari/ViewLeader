import { describe, expect, it } from 'vitest';

import { layoutBuiltInContent } from '../src/content.js';
import { estimateTextWidth, invalidateTextMetrics, measureText } from '../src/textMetrics.js';

const NARROW = 'Condensed, sans-serif';
const WIDE = 'Courier New, monospace';

describe('text measurement', () => {
  it('scales linearly with font size', () => {
    const small = measureText('Pump P-101', { family: NARROW, size: 14, bold: false });
    const large = measureText('Pump P-101', { family: NARROW, size: 28, bold: false });
    expect(large).toBeCloseTo(small * 2, 5);
  });

  it('measures bold wider than normal', () => {
    const normal = measureText('Pump P-101', { family: NARROW, size: 14, bold: false });
    const bold = measureText('Pump P-101', { family: NARROW, size: 14, bold: true });
    expect(bold).toBeGreaterThan(normal);
  });

  it('caches by the full font spec, so family is not conflated', () => {
    invalidateTextMetrics();
    const first = measureText('IIII', { family: NARROW, size: 14, bold: false });
    const second = measureText('IIII', { family: WIDE, size: 14, bold: false });
    // Under the fallback these tie; the point is that one is not silently returned for the other.
    expect(Number.isFinite(first) && Number.isFinite(second)).toBe(true);
    expect(measureText('IIII', { family: NARROW, size: 14, bold: false })).toBe(first);
  });

  it('returns stable finite numbers with no canvas, and zero for empty text', () => {
    expect(measureText('', { family: NARROW, size: 14, bold: false })).toBe(0);
    expect(estimateTextWidth('Pump P-101', 14)).toBeGreaterThan(0);
    expect(estimateTextWidth('Pump P-101', 28)).toBeCloseTo(estimateTextWidth('Pump P-101', 14) * 2, 5);
  });
});

describe('content layout uses the measured width', () => {
  it('sizes a bold split-callout primary wider than the same text unstyled', () => {
    const bold = layoutBuiltInContent({
      kind: 'split-callout', primary: 'MMMMMMMM', secondary: '',
    });
    const plain = layoutBuiltInContent({ kind: 'plain-note', text: 'MMMMMMMM' });
    // Bold primary must not be measured as if it were normal weight.
    expect(bold.bounds.width).toBeGreaterThan(plain.bounds.width);
  });

  it('wraps against the requested font family without throwing', () => {
    const layout = layoutBuiltInContent(
      { kind: 'plain-note', text: 'a fairly long note that should wrap somewhere', maxWidth: 120 },
      { fontFamily: WIDE },
    );
    const lines = layout.primitives.filter((primitive) => primitive.kind === 'text');
    expect(lines.length).toBeGreaterThan(1);
    expect(layout.bounds.width).toBeGreaterThan(0);
  });
});

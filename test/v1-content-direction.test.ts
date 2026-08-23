import { describe, expect, it } from 'vitest';
import { renderMarkdownPluginContent } from 'viewleader/markdown';
import { layoutBuiltInContent, type TextPrimitive } from '../src/content.js';
import { measureText } from '../src/textMetrics.js';

function textLines(content: Parameters<typeof layoutBuiltInContent>[0]): {
  readonly lines: readonly TextPrimitive[];
  readonly width: number;
} {
  const layout = layoutBuiltInContent(content);
  return {
    lines: layout.primitives.filter((primitive): primitive is TextPrimitive => primitive.kind === 'text'),
    width: layout.bounds.width,
  };
}

describe('text direction and its geometry', () => {
  it('keeps a right-to-left line inside its own box', () => {
    // SVG resolves `text-anchor: start` against the inline-base direction, so under `direction=rtl`
    // an x of `padding` would run the glyphs leftward, out of the box entirely.
    const { lines, width } = textLines({ kind: 'plain-note', text: 'مراجعة', direction: 'rtl' });
    const [line] = lines;

    expect(line).toBeDefined();
    expect(line!.align).toBe('start');
    expect(line!.x).toBeGreaterThan(width / 2);
    expect(line!.bounds.x).toBeGreaterThanOrEqual(0);
    expect(line!.bounds.x + line!.bounds.width).toBeLessThanOrEqual(width);
  });

  it('mirrors an explicit end alignment too, and leaves left-to-right alone', () => {
    const rtl = textLines({ kind: 'plain-note', text: 'مراجعة', direction: 'rtl' });
    const ltr = textLines({ kind: 'plain-note', text: 'Review', direction: 'ltr' });

    // `end` under rtl is the box's left side, which is where `start` under ltr already is.
    expect(ltr.lines[0]!.x).toBeLessThan(ltr.width / 2);
    expect(ltr.lines[0]!.bounds.x).toBeGreaterThanOrEqual(0);
    // Mirrored, not merely shifted: the two land on opposite sides of their boxes.
    expect(rtl.lines[0]!.x / rtl.width).toBeGreaterThan(ltr.lines[0]!.x / ltr.width);
  });

  it('centres regardless of direction', () => {
    const { lines, width } = textLines({ kind: 'tag', text: 'A-101', direction: 'rtl' });
    expect(lines[0]!.align).toBe('middle');
    expect(lines[0]!.x).toBeCloseTo(width / 2, 6);
  });
});

describe('markdown inline run advance', () => {
  it('advances each run by its measured width, not a character count', () => {
    // `" slab · "` is nearly all narrow glyphs; charging every character the same width overpaid for
    // it by roughly half, which landed as a visible gap before the code run.
    const primitives = renderMarkdownPluginContent({ source: '**Level 2** slab · `RC-30`' });
    const runs = primitives.filter((primitive) => primitive.kind === 'text');
    expect(runs).toHaveLength(3);

    let expectedX = 0;
    for (const run of runs) {
      expect(run.position.x).toBeCloseTo(expectedX, 6);
      expectedX += measureText(run.text, {
        family: run.code === true ? 'monospace' : 'Inter, "Noto Sans", Arial, sans-serif',
        size: run.fontSize,
        bold: run.bold === true,
      });
    }
    // The last run must start after the two before it, and well short of the character-count guess
    // that put it at 121.5 for this string.
    expect(runs[2]!.position.x).toBeGreaterThan(runs[1]!.position.x);
    expect(runs[2]!.position.x).toBeLessThan(121);
  });
});

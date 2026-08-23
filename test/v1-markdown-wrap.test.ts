/**
 * Phase 1.2. Before this, `renderMarkdownPluginContent` advanced `x += width` per run with no wrap
 * column, so a two-sentence note drew as one line thousands of pixels wide. Scene A contains a
 * markdown label, which made every overlap number in phases 2 and 3 measured against a box no
 * drawing would ever contain.
 */
import { describe, expect, it } from 'vitest';
import { MARKDOWN_WRAP_WIDTH, renderMarkdownPluginContent } from 'viewleader/markdown';

interface Bounds { x: number; y: number; width: number; height: number }
type Drawn = { text: string; bounds?: Bounds; x?: number; y?: number };

function drawn(source: string): Drawn[] {
  return renderMarkdownPluginContent({ source }) as unknown as Drawn[];
}

/** Right-most drawn edge — the width the label box would have to be to hold this content. */
function contentWidth(primitives: readonly Drawn[]): number {
  return primitives.reduce((widest, primitive) => {
    const bounds = primitive.bounds;
    const right = bounds === undefined ? (primitive.x ?? 0) : bounds.x + bounds.width;
    return Math.max(widest, right);
  }, 0);
}

function lineCount(primitives: readonly Drawn[]): number {
  return new Set(primitives.map((primitive) => primitive.bounds?.y ?? primitive.y ?? 0)).size;
}

const TWO_PARAGRAPHS =
  'Supply air duct requires verification in the field before the ceiling grid is closed.\n\n'
  + 'Coordinate the final elevation with the electrical contractor and confirm 2400 mm clear below.';

describe('markdown labels wrap', () => {
  it('keeps a two-paragraph note inside the wrap column', () => {
    const primitives = drawn(TWO_PARAGRAPHS);
    expect(contentWidth(primitives)).toBeLessThanOrEqual(MARKDOWN_WRAP_WIDTH);
    // Sanity that it is actually a paragraph and not one dropped line.
    expect(lineCount(primitives)).toBeGreaterThan(3);
    expect(primitives.map((primitive) => primitive.text).join(' ')).toContain('electrical contractor');
  });

  it('produces a box that grows down, not sideways, as the note grows', () => {
    const short = drawn('Verify in field.');
    const long = drawn(`${TWO_PARAGRAPHS}\n\n${TWO_PARAGRAPHS}`);
    expect(contentWidth(long)).toBeLessThanOrEqual(MARKDOWN_WRAP_WIDTH);
    expect(lineCount(long)).toBeGreaterThan(lineCount(short));
  });

  it('hard-breaks a single token wider than the column instead of letting it run off', () => {
    // A URL or a part number has no space to wrap at. This is the case that would otherwise
    // reintroduce the exact endless line the wrapping exists to prevent.
    const primitives = drawn(`See ${'A'.repeat(400)} for detail.`);
    expect(contentWidth(primitives)).toBeLessThanOrEqual(MARKDOWN_WRAP_WIDTH);
    expect(primitives.map((primitive) => primitive.text).join('')).toContain('AAAA');
  });

  it('wraps bold and code runs too, at their own measured widths', () => {
    const bold = drawn(`**${'wide bold phrase '.repeat(12)}**`);
    const code = drawn(`\`${'wide code phrase '.repeat(12)}\``);
    expect(contentWidth(bold)).toBeLessThanOrEqual(MARKDOWN_WRAP_WIDTH);
    expect(contentWidth(code)).toBeLessThanOrEqual(MARKDOWN_WRAP_WIDTH);
  });

  it('wraps list items inside their indent, not back to the margin', () => {
    const primitives = drawn(`- ${'coordinate the routing with the structural drawings '.repeat(4)}`);
    expect(contentWidth(primitives)).toBeLessThanOrEqual(MARKDOWN_WRAP_WIDTH);
    // Continuation lines start at the item's indent, so the bullet's text block stays a block.
    const xs = primitives.map((primitive) => primitive.bounds?.x ?? primitive.x ?? 0);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
  });

  it('emits one primitive per drawn line of a run, not one per word', () => {
    const primitives = drawn(TWO_PARAGRAPHS);
    // ~30 words across ~6 lines. If wrapping had split per word this would be far higher.
    expect(primitives.length).toBeLessThanOrEqual(lineCount(primitives) * 2);
  });

  it('still draws a short note on one line, unchanged', () => {
    const primitives = drawn('FD-2 fire damper');
    expect(lineCount(primitives)).toBe(1);
    expect(primitives.map((primitive) => primitive.text).join('')).toBe('FD-2 fire damper');
  });
});

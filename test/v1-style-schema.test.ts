import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LANDING,
  validateDefinition,
  type StyleDefinition,
  type StyleLanding,
} from '../src/definitions.js';
import { createEmptyDocument, parseDocument, prepareDocument, serializeDocument } from '../src/document.js';
import { PEN, CAD_PAPER, textPreset } from '../src/theme.js';

const base = {
  kind: 'style',
  id: 'test.style',
  name: 'Test',
  lineColor: '#1A1D24',
  lineWidth: 1.5,
  textColor: '#1A1D24',
  fontFamily: 'Inter, Arial, sans-serif',
  fontSize: 14,
  terminatorId: 'builtin.terminator.arrow',
} as const satisfies StyleDefinition;

const style = (extra: Partial<StyleDefinition> = {}): StyleDefinition => ({ ...base, ...extra });

describe('style schema — drafting groups', () => {
  it('expresses the reference "standard" style', () => {
    // Diagonal route into a shoulder landing, opaque white box, thin border, radius 2, padding 5.
    const standard = style({
      lineColor: CAD_PAPER.ink,
      lineWidth: PEN.thin,
      fontSize: textPreset('iso-2.5'),
      enclosureId: 'builtin.enclosure.rectangle',
      landing: { length: 28, side: 'auto', gap: 6, render: 'shoulder' },
      content: {
        backgroundColor: CAD_PAPER.mask,
        backgroundOpacity: 1,
        borderColor: CAD_PAPER.border,
        borderWidth: PEN.thin,
        borderRadius: 2,
        padding: 5,
      },
    });
    expect(() => validateDefinition(standard)).not.toThrow();
  });

  it('expresses a tag-circle: coloured fill, white text, fully rounded', () => {
    const tag = style({
      lineColor: CAD_PAPER.accent,
      textColor: '#FFFFFF',
      enclosureId: 'builtin.enclosure.rectangle',
      landing: { length: 22, gap: 5 },
      content: {
        backgroundColor: CAD_PAPER.accent,
        backgroundOpacity: 1,
        borderColor: CAD_PAPER.accent,
        borderWidth: PEN.medium,
        borderRadius: 50,
      },
    });
    expect(() => validateDefinition(tag)).not.toThrow();
  });

  it('still accepts a style with none of the new groups', () => {
    expect(() => validateDefinition(style())).not.toThrow();
  });

  it('accepts partial groups, so an override may state only what it changes', () => {
    expect(() => validateDefinition(style({ landing: { gap: 8 } }))).not.toThrow();
    expect(() => validateDefinition(style({ content: { padding: 3 } }))).not.toThrow();
  });

  it('allows zero length and zero gap — a flush landing is meaningful', () => {
    expect(() => validateDefinition(style({ landing: { length: 0, gap: 0 } }))).not.toThrow();
  });
});

describe('style schema — rejections', () => {
  it('rejects an unknown key inside a group', () => {
    expect(() => validateDefinition(style({
      landing: { lenght: 28 } as unknown as StyleLanding,
    }))).toThrow(/unsupported fields/iu);
  });

  it('rejects an out-of-range landing render or side', () => {
    expect(() => validateDefinition(style({
      landing: { render: 'wavy' as unknown as 'shoulder' },
    }))).toThrow(/shoulder/iu);
    expect(() => validateDefinition(style({
      landing: { side: 'up' as unknown as 'auto' },
    }))).toThrow(/auto/iu);
  });

  it('rejects opacity outside 0..1 and a negative padding', () => {
    expect(() => validateDefinition(style({ content: { backgroundOpacity: 1.5 } }))).toThrow();
    expect(() => validateDefinition(style({ content: { padding: -1 } }))).toThrow();
  });

  it('rejects a malformed colour in the content box', () => {
    expect(() => validateDefinition(style({
      content: { backgroundColor: 'not a colour' },
    }))).toThrow();
  });
});

describe('document round-trip', () => {
  it('preserves landing and content through serialise and reload', () => {
    const styled = style({
      landing: { length: 28, side: 'left', gap: 6, render: 'underline' },
      content: { backgroundColor: '#FFFFFF', backgroundOpacity: 0.9, padding: 5 },
    });
    const document = {
      ...createEmptyDocument(),
      definitions: { styles: [styled], templates: [], terminators: [], enclosures: [] },
    };
    const reloaded = parseDocument(serializeDocument(prepareDocument(document)));
    expect(reloaded.definitions.styles[0]).toEqual(styled);
  });
});

describe('landing defaults', () => {
  it('names the MLEADER shoulder as the default form', () => {
    expect(DEFAULT_LANDING.render).toBe('shoulder');
    expect(DEFAULT_LANDING.side).toBe('auto');
    expect(DEFAULT_LANDING.length).toBeGreaterThan(0);
    expect(Object.isFrozen(DEFAULT_LANDING)).toBe(true);
  });
});

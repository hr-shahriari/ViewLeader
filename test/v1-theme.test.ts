import { describe, expect, it } from 'vitest';

import {
  CAD_DARK,
  CAD_PAPER,
  CAP_RATIO,
  PEN,
  lineweight,
  mm,
  textPreset,
} from '../src/theme.js';

describe('drafting unit conversion', () => {
  it('converts paper millimetres at 96 dpi', () => {
    expect(mm(25.4)).toBe(96);
    expect(mm(0)).toBe(0);
  });

  it('converts CAD points at 96 dpi', () => {
    expect(lineweight(72)).toBe(96);
  });

  it('keys pen tiers to the ISO/NCS millimetre set', () => {
    expect(PEN.thin).toBe(mm(0.25));
    expect(PEN.medium).toBe(mm(0.35));
    // The hierarchy that matters: annotation linework is thinner than symbol outlines.
    expect(PEN.hairline).toBeLessThan(PEN.thin);
    expect(PEN.thin).toBeLessThan(PEN.medium);
    expect(PEN.medium).toBeLessThan(PEN.wide);
    expect(PEN.wide).toBeLessThan(PEN.xwide);
  });
});

describe('lettering presets', () => {
  it('treats ISO nominal sizes as cap heights, not em sizes', () => {
    // 3.5 mm cap height at 96 dpi, divided by the cap ratio. Inverting this yields text ~40% small.
    const size = textPreset('iso-3.5');
    expect(size * CAP_RATIO).toBeCloseTo(mm(3.5), 1);
    expect(size).toBeGreaterThan(mm(3.5));
  });

  it('orders the presets by height', () => {
    expect(textPreset('iso-1.8')).toBeLessThan(textPreset('iso-2.5'));
    expect(textPreset('iso-2.5')).toBeLessThan(textPreset('iso-3.5'));
    expect(textPreset('iso-3.5')).toBeLessThan(textPreset('iso-5'));
    expect(textPreset('iso-5')).toBeLessThan(textPreset('iso-7'));
  });

  it('places the ASME minimum note height between iso-1.8 and iso-2.5', () => {
    // 3/32" = 2.4 mm.
    expect(textPreset('imperial-3/32')).toBeGreaterThan(textPreset('iso-1.8'));
    expect(textPreset('imperial-3/32')).toBeLessThan(textPreset('iso-2.5'));
  });
});

describe('themes', () => {
  it('expose identical key sets so a style built from either resolves', () => {
    expect(Object.keys(CAD_PAPER).sort()).toEqual(Object.keys(CAD_DARK).sort());
  });

  it('share geometry and differ only in colour', () => {
    expect(CAD_DARK.fontSize).toBe(CAD_PAPER.fontSize);
    expect(CAD_DARK.fontStack).toBe(CAD_PAPER.fontStack);
    expect(CAD_DARK.ink).not.toBe(CAD_PAPER.ink);
  });

  it('are frozen', () => {
    expect(Object.isFrozen(CAD_PAPER)).toBe(true);
    expect(Object.isFrozen(PEN)).toBe(true);
  });
});

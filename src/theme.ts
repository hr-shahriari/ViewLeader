/**
 * Drafting units and the two built-in colour schemes.
 *
 * A CAD drawing looks like ink on paper: dark lines, thin and consistent, a plain technical font.
 * To get that look, sizes here are written in the units drafters actually use — paper millimetres,
 * pen weights, standard lettering heights — and converted to screen pixels.
 *
 * A 3D viewport has no paper, so "0.25 mm" means "0.25 mm if this were printed full size". The
 * point of the convention is that every number below can be checked against a published standard
 * instead of being a magic value somebody once liked.
 *
 * This is not the same as annotative scale, which zooms all of it together and lives elsewhere.
 */

const PT_TO_PX = 96 / 72;
const MM_TO_PX = 96 / 25.4;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Paper millimetres to screen pixels. */
export function mm(value: number): number {
  return round2(value * MM_TO_PX);
}

/** A CAD pen weight in points to screen pixels. */
export function lineweight(points: number): number {
  return round2(points * PT_TO_PX);
}

/**
 * How tall a capital letter is compared to the font size, for a typical sans-serif face.
 *
 * Needed because drafting standards specify capital heights while fonts are set by em size, and the
 * two differ by roughly this much.
 *
 * ponytail: one constant instead of measuring each font. The real ratio could be read off the
 * canvas, but that would make text sizes font-dependent to correct about 3% — a tenth of a
 * millimetre on standard lettering. Measure per font if a customer's face is far from this.
 */
export const CAP_RATIO = 0.72;

/**
 * The standard text sizes on a drawing, named by capital-letter height. `iso-2.5` is 2.5 mm; the
 * imperial names are inches, and `imperial-3/32` is the smallest US standards allow for a note.
 */
export type TextPresetName =
  | 'iso-1.8' | 'iso-2.5' | 'iso-3.5' | 'iso-5' | 'iso-7'
  | 'imperial-3/32' | 'imperial-1/8' | 'imperial-3/16';

/** Capital-letter height in millimetres for each size. */
const TEXT_PRESET_CAP_MM: Readonly<Record<TextPresetName, number>> = Object.freeze({
  'iso-1.8': 1.8,
  'iso-2.5': 2.5,
  'iso-3.5': 3.5,
  'iso-5': 5,
  'iso-7': 7,
  'imperial-3/32': 2.4,
  'imperial-1/8': 3.2,
  'imperial-3/16': 4.8,
});

/**
 * The font size to use for a named lettering size.
 *
 * Drawing standards give the height of a capital letter, but fonts are set by em size, which is
 * larger. Using the standard's number directly as a font size draws text about 40% too small.
 */
export function textPreset(preset: TextPresetName): number {
  return round2((TEXT_PRESET_CAP_MM[preset] * MM_TO_PX) / CAP_RATIO);
}

/**
 * The standard set of pen weights, thinnest to thickest.
 *
 * The rule that matters: annotation lines are drawn at about half the weight of the model's own
 * edges, so a leader line never competes with the building for attention. Leaders and dimensions
 * use `thin`; the outlines of symbols use `medium`.
 */
export const PEN = Object.freeze({
  hairline: mm(0.13),
  thin: mm(0.25),
  medium: mm(0.35),
  wide: mm(0.5),
  xwide: mm(0.7),
});

export type PenTier = keyof typeof PEN;

/**
 * A colour scheme. Every built-in style reads its colours from one of these, so switching schemes
 * recolours the whole drawing without changing a single size or shape.
 */
export interface Theme {
  /** The background this scheme assumes. Never drawn — used to pick readable masks and contrast. */
  readonly paper: string;
  /** The main ink colour: leader lines, borders, text. */
  readonly ink: string;
  /** A lighter ink for things that should recede: dimensions, muted notes. */
  readonly inkMuted: string;
  /** The highlight colour, used for section and detail bubbles. */
  readonly accent: string;
  /** What is painted behind label text so the model does not show through and blur it. */
  readonly mask: string;
  /** The colour of boxes drawn around labels. */
  readonly border: string;
  /** The font, with fallbacks for machines that do not have the first choice. */
  readonly fontStack: string;
  /** Default text size, matching the smallest standard lettering height. */
  readonly fontSize: number;
}

/**
 * Only faces that are already on the machine — nothing that has to be downloaded.
 *
 * The raster export loads the sheet as an `<img>` from a `blob:` URL. That is an isolated document:
 * it inherits no stylesheet from the page and fetches no `@font-face`. So a downloadable family
 * resolves on screen and silently falls through in the PNG, and the picture comes out at widths
 * that were measured for a different face.
 *
 * Four names cover macOS, Windows and Linux. Nothing more is needed: `"Segoe UI"` after `Arial`
 * can never fire because Arial ships on every Windows install, and `"Liberation Sans"` after
 * `Arial` can never fire because fontconfig aliases Arial onto it. `Roboto` is out for the same
 * reason `Inter` was — it is commonly delivered as a web font.
 */
export const FONT_STACK = "'Helvetica Neue', Helvetica, Arial, sans-serif";

/** Dark ink on light paper, the way a printed drawing looks. The default. */
export const CAD_PAPER: Theme = Object.freeze({
  paper: '#F4F2EC',
  ink: '#1A1D24',
  inkMuted: '#5A5E68',
  accent: '#0B5394',
  mask: '#FFFFFF',
  border: '#1A1D24',
  fontStack: FONT_STACK,
  fontSize: textPreset('iso-2.5'),
});

/** For dark viewports. Identical sizes and shapes, inverted colours. */
export const CAD_DARK: Theme = Object.freeze({
  paper: '#1E1F24',
  ink: '#E7E9EF',
  inkMuted: '#9098AC',
  accent: '#5AA6F5',
  mask: '#23252C',
  border: '#3A3D46',
  fontStack: FONT_STACK,
  fontSize: textPreset('iso-2.5'),
});

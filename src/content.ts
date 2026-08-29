import { measureText, type FontSpec } from './textMetrics.js';
import { CAP_RATIO, FONT_STACK } from './theme.js';
import type { BuiltInContent, TextAlign, TextDirection } from './types.js';

// Turns a note, callout, tag or symbol into the shapes and text runs that get drawn.
//
// This is the measuring stage: it decides how big each label is and where every line of text sits
// inside it. The renderer draws exactly what comes out of here and never measures anything itself,
// so a label's size is decided once and stays consistent between layout and drawing.
/**
 * The font measuring assumes, which is the theme's — the same string, not a copy of it. Held
 * apart they drifted to `'Noto Sans'` here against `'Roboto Condensed'` there, so text was
 * measured in one face and drawn in another.
 *
 * Annotated `: string` so the value is not shipped as a public literal type.
 */
export const DEFAULT_FONT_FAMILY: string = FONT_STACK;
export const DEFAULT_FONT_SIZE = 14;
/** Spacing between lines, measured at {@link DEFAULT_FONT_SIZE} and scaled with the text. */
export const LINE_HEIGHT = 18;
export const DEFAULT_PADDING = 8;
/** The box an image occupies before anyone knows its real size. */
export const DEFAULT_IMAGE_WIDTH = 160;
export const DEFAULT_IMAGE_HEIGHT = 90;

interface BasePrimitive {
  readonly bounds: ContentBounds;
}

export interface TextPrimitive extends BasePrimitive {
  readonly kind: 'text';
  /** The point the text lines up against. For centred or right-aligned text this is not the
   *  line's left edge — see {@link TextPrimitive.bounds} for that. */
  readonly x: number;
  readonly baseline: number;
  readonly text: string;
  readonly direction: TextDirection;
  readonly weight: 'normal' | 'bold';
  readonly align: TextAlign;
}

export interface PathPrimitive extends BasePrimitive {
  readonly kind: 'path';
  readonly path: string;
  readonly filled: boolean;
  /**
   * What this shape is for, so the renderer knows which ones a style is allowed to change.
   *
   * `'enclosure'` is the box around a label, which a style may replace with its own. `'symbol'` is
   * the shape of a symbolic block — drawn the same way but never replaced, because the shape *is*
   * the content and a style must not turn a requested diamond into a rectangle. Dividers and other
   * decoration carry no tag.
   */
  readonly role?: 'enclosure' | 'symbol';
}

export interface ImagePrimitive extends BasePrimitive {
  readonly kind: 'image';
  readonly reference: string;
  readonly alt: string;
}

export type ContentPrimitive = TextPrimitive | PathPrimitive | ImagePrimitive;

export interface ContentBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface BuiltInContentLayout {
  readonly bounds: ContentBounds;
  readonly primitives: readonly ContentPrimitive[];
  readonly accessibleText: string;
  readonly direction: TextDirection;
}

export interface ContentLayoutOptions {
  readonly fontFamily?: string;
  /** Space between the text and the box around it. */
  readonly padding?: number;
  /** `'square'` when the shape around the label must keep equal sides — a circle rather than an
   *  ellipse — so the box has to grow instead of stretching. */
  readonly aspect?: 'free' | 'square';
  /** Left unset, each kind of content picks its own: notes and callouts read from the start, tags
   *  and symbols centre. */
  readonly align?: TextAlign;
  /**
   * How bold the main text is — a note's body, a callout's title, a tag's number.
   *
   * Supporting text keeps its own weight regardless, because the contrast between a bold title and
   * a lighter body is the whole point of a callout.
   *
   * Left unset, each kind picks its own: bold for tags, symbols and anything with a title, normal
   * for a plain note. A style only needs to set this when it wants something different.
   */
  readonly weight?: 'normal' | 'bold';
  /**
   * The true size of an image, once the host has actually loaded it.
   *
   * An image with no size given by the author is then drawn at its own proportions rather than
   * squeezed into a guessed box. Not known until loading finishes; the next frame lays out again
   * with the real numbers.
   */
  readonly intrinsic?: Readonly<{ width: number; height: number }>;
}

/** The normal and bold variants of one font, both at the size layout works in. */
interface LayoutFonts {
  readonly normal: FontSpec;
  readonly bold: FontSpec;
}

function fonts(family: string): LayoutFonts {
  return {
    normal: { family, size: DEFAULT_FONT_SIZE, bold: false },
    bold: { family, size: DEFAULT_FONT_SIZE, bold: true },
  };
}

/**
 * Lays out one piece of content: works out the label's size and the position of every line in it.
 *
 * Always measured at one fixed font size, with the caller scaling the finished result to whatever
 * size the style asks for. Text width scales evenly with font size, so this is exact rather than an
 * approximation — and it means a label is measured once instead of once per size.
 *
 * The font family cannot be scaled away like that, which is why it is passed in.
 */
export function layoutBuiltInContent(
  content: BuiltInContent,
  options: ContentLayoutOptions = {},
): BuiltInContentLayout {
  if (content.kind === 'host-image') return imageLayout(content, options.intrinsic);
  const direction = content.direction ?? 'auto';
  const font = fonts(options.fontFamily ?? DEFAULT_FONT_FAMILY);
  const box: BoxOptions = {
    padding: options.padding ?? DEFAULT_PADDING,
    aspect: options.aspect ?? 'free',
  };
  const align = options.align ?? defaultAlign(content.kind);
  const weight = options.weight ?? defaultWeight(content.kind);
  switch (content.kind) {
    case 'plain-note':
      return boxTextLayout(content.text, direction, content.maxWidth, 'plain', font, box, align, weight);
    case 'tag':
      return boxTextLayout(content.text, direction, content.maxWidth, 'tag', font, box, align, weight);
    case 'callout':
      return calloutLayout(content.title, content.text, direction, content.maxWidth, font, box, align, weight);
    case 'split-callout':
      return splitCalloutLayout(content.primary, content.secondary, direction, content.maxWidth, font, box, align, weight);
    case 'symbolic-block':
      return symbolicBlockLayout(content.symbol, content.label, direction, content.maxWidth, font, box, align, weight);
  }
}

/**
 * Standard drafting practice: a note is read as a sentence and starts at the left, while the number
 * inside a tag or a symbol sits in the middle of it.
 */
function defaultAlign(kind: BuiltInContent['kind']): TextAlign {
  return kind === 'tag' || kind === 'symbolic-block' ? 'middle' : 'start';
}

/** The weight each kind of content uses when its style does not ask for a particular one. */
function defaultWeight(kind: BuiltInContent['kind']): 'normal' | 'bold' {
  return kind === 'plain-note' ? 'normal' : 'bold';
}

interface BoxOptions {
  readonly padding: number;
  readonly aspect: 'free' | 'square';
}

/**
 * A small upward nudge that makes centred text look centred.
 *
 * A line of text is taller than the letters in it — there is empty space above for accents and
 * below for descenders. Centring the line box therefore leaves the visible letters sitting slightly
 * low. This shifts the letters themselves onto the centre instead, which is what makes a single
 * digit inside a circle look properly placed.
 */
const OPTICAL_VERTICAL_OFFSET = (LINE_HEIGHT - 2 * DEFAULT_FONT_SIZE + CAP_RATIO * DEFAULT_FONT_SIZE) / 2;

/**
 * Works out the label box that fits a block of text.
 *
 * A shape that must stay square grows taller than the text needs, and the text is then centred in
 * that extra height. Horizontal position is not decided here — that is what {@link TextAlign} is
 * for.
 */
function fitBox(
  textWidth: number,
  textHeight: number,
  minWidth: number,
  box: BoxOptions,
): Readonly<{ bounds: ContentBounds; y: number }> {
  const width = Math.max(minWidth, textWidth + box.padding * 2);
  const height = Math.max(LINE_HEIGHT, textHeight) + box.padding * 2;
  const extent = box.aspect === 'square' ? Math.max(width, height) : 0;
  const bounds = rect(0, 0, Math.max(width, extent), Math.max(height, extent));
  const y = box.aspect === 'square'
    ? (bounds.height - textHeight) / 2 + OPTICAL_VERTICAL_OFFSET
    : box.padding;
  return { bounds, y };
}

function boxTextLayout(
  text: string,
  direction: TextDirection,
  maxWidth: number | undefined,
  form: 'plain' | 'tag',
  font: LayoutFonts,
  box: BoxOptions,
  align: TextAlign,
  weight: 'normal' | 'bold',
): BuiltInContentLayout {
  const spec = font[weight];
  const lines = wrapText(text, maxWidth, spec, box.padding);
  const textWidth = maxLineWidth(lines, spec);
  const fit = fitBox(textWidth, lines.length * LINE_HEIGHT, form === 'tag' ? 36 : 24, box);
  const outline = form === 'tag'
    ? roundedRectanglePath(fit.bounds, Math.min(fit.bounds.height / 2, 12))
    : rectanglePath(fit.bounds);
  return freezeLayout({
    bounds: fit.bounds,
    primitives: [
      enclosure(fit.bounds, outline),
      ...textPrimitives(lines, fit.y, fit.bounds.width, box.padding, align, direction, weight, spec),
    ],
    accessibleText: text,
    direction,
  });
}

function calloutLayout(
  title: string | undefined,
  text: string,
  direction: TextDirection,
  maxWidth: number | undefined,
  font: LayoutFonts,
  box: BoxOptions,
  align: TextAlign,
  weight: 'normal' | 'bold',
): BuiltInContentLayout {
  const titleSpec = font[weight];
  const titleLines = title === undefined ? [] : wrapText(title, maxWidth, titleSpec, box.padding);
  const bodyLines = wrapText(text, maxWidth, font.normal, box.padding);
  const textWidth = Math.max(maxLineWidth(titleLines, titleSpec), maxLineWidth(bodyLines, font.normal));
  const titleHeight = titleLines.length * LINE_HEIGHT;
  const bodyHeight = bodyLines.length * LINE_HEIGHT;
  const separator = titleLines.length === 0 ? 0 : 1;
  const fit = fitBox(textWidth, titleHeight + bodyHeight + separator, 36, box);
  const bounds = fit.bounds;
  const width = bounds.width;
  const primitives: ContentPrimitive[] = [enclosure(bounds, rectanglePath(bounds))];
  primitives.push(...textPrimitives(titleLines, fit.y, width, box.padding, align, direction, weight, titleSpec));
  const bodyY = fit.y + titleHeight + separator;
  if (separator > 0) {
    const lineBounds = rect(0, fit.y + titleHeight, width, 1);
    primitives.push(path(lineBounds, `M 0 ${lineBounds.y + 0.5} L ${width} ${lineBounds.y + 0.5}`));
  }
  primitives.push(...textPrimitives(bodyLines, bodyY, width, box.padding, align, direction, 'normal', font.normal));
  return freezeLayout({
    bounds,
    primitives,
    accessibleText: title === undefined ? text : `${title}: ${text}`,
    direction,
  });
}

function splitCalloutLayout(
  primary: string,
  secondary: string,
  direction: TextDirection,
  maxWidth: number | undefined,
  font: LayoutFonts,
  box: BoxOptions,
  align: TextAlign,
  weight: 'normal' | 'bold',
): BuiltInContentLayout {
  const firstSpec = font[weight];
  const first = wrapText(primary, maxWidth, firstSpec, box.padding);
  const second = wrapText(secondary, maxWidth, font.normal, box.padding);
  const firstHeight = first.length * LINE_HEIGHT;
  const secondHeight = second.length * LINE_HEIGHT;
  const fit = fitBox(
    Math.max(maxLineWidth(first, firstSpec), maxLineWidth(second, font.normal)),
    firstHeight + secondHeight + 1,
    48,
    box,
  );
  const bounds = fit.bounds;
  const width = bounds.width;
  const dividerY = fit.y + firstHeight + 0.5;
  return freezeLayout({
    bounds,
    primitives: [
      enclosure(bounds, rectanglePath(bounds)),
      ...textPrimitives(first, fit.y, width, box.padding, align, direction, weight, firstSpec),
      path(rect(0, dividerY, width, 1), `M 0 ${dividerY} L ${width} ${dividerY}`),
      ...textPrimitives(second, dividerY + 0.5, width, box.padding, align, direction, 'normal', font.normal),
    ],
    accessibleText: `${primary}: ${secondary}`,
    direction,
  });
}

function symbolicBlockLayout(
  symbol: 'circle' | 'square' | 'diamond' | 'hexagon',
  label: string,
  direction: TextDirection,
  maxWidth: number | undefined,
  font: LayoutFonts,
  box: BoxOptions,
  align: TextAlign,
  weight: 'normal' | 'bold',
): BuiltInContentLayout {
  const labelSpec = font[weight];
  const lines = wrapText(label, maxWidth, labelSpec, box.padding);
  const textWidth = maxLineWidth(lines, font.bold);
  // Always square. A symbol's proportions are part of its meaning, so the style cannot stretch it.
  const fit = fitBox(textWidth, lines.length * LINE_HEIGHT, 36, { ...box, aspect: 'square' });
  const bounds = fit.bounds;
  return freezeLayout({
    bounds,
    primitives: [
      symbolShape(bounds, symbolPath(symbol, bounds.width)),
      ...textPrimitives(lines, fit.y, bounds.width, box.padding, align, direction, weight, labelSpec),
    ],
    accessibleText: label,
    direction,
  });
}

function imageLayout(
  content: Extract<BuiltInContent, { kind: 'host-image' }>,
  intrinsic?: Readonly<{ width: number; height: number }>,
): BuiltInContentLayout {
  // Prefer the size the author asked for, then the image's own size, and only then a placeholder.
  // Skipping the middle step would stretch every image without an explicit size to 16:9, no matter
  // what shape it really was.
  const width = content.width ?? intrinsic?.width ?? DEFAULT_IMAGE_WIDTH;
  const height = content.height ?? intrinsic?.height ?? DEFAULT_IMAGE_HEIGHT;
  const bounds = rect(0, 0, width, height);
  return freezeLayout({
    bounds,
    primitives: [
      enclosure(bounds, `${rectanglePath(bounds)} M 0 0 L ${width} ${height} M ${width} 0 L 0 ${height}`),
      { kind: 'image', bounds, reference: content.reference, alt: content.alt },
    ],
    accessibleText: content.alt,
    direction: 'auto',
  });
}

function wrapText(
  text: string,
  maxWidth: number | undefined,
  font: FontSpec,
  padding: number,
): readonly string[] {
  const paragraphs = text.split('\n');
  if (maxWidth === undefined) return paragraphs;
  const available = Math.max(1, maxWidth - padding * 2);
  return paragraphs.flatMap((paragraph) => wrapParagraph(paragraph, available, font));
}

function wrapParagraph(
  paragraph: string,
  maxWidth: number,
  font: FontSpec,
): readonly string[] {
  if (paragraph === '') return [''];
  const segments = paragraph.split(/(\s+)/u).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const segment of segments) {
    const candidate = line + segment;
    if (line !== '' && measureText(candidate, font) > maxWidth) {
      lines.push(line.trimEnd());
      line = segment.trimStart();
    } else {
      line = candidate;
    }
  }
  lines.push(line);
  return lines;
}

function textPrimitives(
  lines: readonly string[],
  y: number,
  boxWidth: number,
  padding: number,
  align: TextAlign,
  direction: TextDirection,
  weight: 'normal' | 'bold',
  font: FontSpec,
): readonly TextPrimitive[] {
  // In right-to-left text the "start" of a line is its right edge, so the geometry is mirrored
  // while the alignment stays as the author wrote it. That keeps the two consistent: the renderer
  // and this file agree on which edge to measure from.
  //
  // ponytail: `direction: 'auto'` is treated as left-to-right. Deciding it properly means working
  // out the direction from the characters themselves, which only the browser can see. Set
  // `direction: 'rtl'` explicitly for right-to-left text.
  const edge = direction === 'rtl' ? mirrorAlign(align) : align;
  return lines.map((text, index) => {
    const width = measureText(text, font);
    const top = y + index * LINE_HEIGHT;
    return {
      kind: 'text',
      bounds: rect(alignedLeft(edge, width, boxWidth, padding), top, width, LINE_HEIGHT),
      x: anchorX(edge, boxWidth, padding),
      baseline: top + 14,
      text,
      direction,
      weight,
      align,
    };
  });
}

/** The same physical edge, named the way the opposite reading direction would name it. */
function mirrorAlign(align: TextAlign): TextAlign {
  if (align === 'middle') return align;
  return align === 'start' ? 'end' : 'start';
}

/** The line's actual left edge on screen, whichever way it is aligned. */
function alignedLeft(align: TextAlign, width: number, boxWidth: number, padding: number): number {
  switch (align) {
    case 'start': return padding;
    case 'end': return boxWidth - padding - width;
    case 'middle': return (boxWidth - width) / 2;
  }
}

/**
 * The point this line is positioned against.
 *
 * Measured from the label box rather than from the line's own width, so editing the text cannot
 * slowly drift a centred character off the middle of its circle.
 */
function anchorX(align: TextAlign, boxWidth: number, padding: number): number {
  switch (align) {
    case 'start': return padding;
    case 'end': return boxWidth - padding;
    case 'middle': return boxWidth / 2;
  }
}

function path(bounds: ContentBounds, value: string): PathPrimitive {
  return { kind: 'path', bounds, path: value, filled: false };
}

function enclosure(bounds: ContentBounds, value: string): PathPrimitive {
  return { kind: 'path', bounds, path: value, filled: false, role: 'enclosure' };
}

function symbolShape(bounds: ContentBounds, value: string): PathPrimitive {
  return { kind: 'path', bounds, path: value, filled: false, role: 'symbol' };
}

function rect(x: number, y: number, width: number, height: number): ContentBounds {
  return Object.freeze({
    x: roundGeometry(x),
    y: roundGeometry(y),
    width: roundGeometry(width),
    height: roundGeometry(height),
  });
}

function rectanglePath(bounds: ContentBounds): string {
  return `M ${bounds.x} ${bounds.y} H ${bounds.x + bounds.width} V ${bounds.y + bounds.height} H ${bounds.x} Z`;
}

export function roundedRectanglePath(bounds: ContentBounds, radius: number): string {
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  return `M ${bounds.x + radius} ${bounds.y} H ${right - radius} Q ${right} ${bounds.y} ${right} ${bounds.y + radius} V ${bottom - radius} Q ${right} ${bottom} ${right - radius} ${bottom} H ${bounds.x + radius} Q ${bounds.x} ${bottom} ${bounds.x} ${bottom - radius} V ${bounds.y + radius} Q ${bounds.x} ${bounds.y} ${bounds.x + radius} ${bounds.y} Z`;
}

function symbolPath(symbol: 'circle' | 'square' | 'diamond' | 'hexagon', extent: number): string {
  switch (symbol) {
    case 'circle': {
      const radius = extent / 2;
      return `M ${radius} 0 A ${radius} ${radius} 0 1 1 ${radius} ${extent} A ${radius} ${radius} 0 1 1 ${radius} 0`;
    }
    case 'square':
      return `M 0 0 H ${extent} V ${extent} H 0 Z`;
    case 'diamond':
      return `M ${extent / 2} 0 L ${extent} ${extent / 2} L ${extent / 2} ${extent} L 0 ${extent / 2} Z`;
    case 'hexagon':
      return `M ${extent * 0.25} 0 H ${extent * 0.75} L ${extent} ${extent / 2} L ${extent * 0.75} ${extent} H ${extent * 0.25} L 0 ${extent / 2} Z`;
  }
}

function maxLineWidth(lines: readonly string[], font: FontSpec): number {
  return lines.reduce((maximum, line) => Math.max(maximum, measureText(line, font)), 0);
}

function roundGeometry(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function freezeLayout(layout: BuiltInContentLayout): BuiltInContentLayout {
  for (const primitive of layout.primitives) Object.freeze(primitive);
  Object.freeze(layout.primitives);
  return Object.freeze(layout);
}

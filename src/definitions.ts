// Styles, and the pieces they are built from: arrowheads, label outlines, and the templates that
// pair a style with a route.
//
// A style says how an annotation looks — its ink, pen weight, text size, the shape around it. The
// eleven built-in ones cover standard AEC drafting practice, and a host adds its own.
//
// Every number here is a drafting unit rather than a pixel: pen tiers, paper millimetres, standard
// lettering heights. That way each one can be checked against a published standard instead of being
// a value somebody once thought looked right.
import {
  domainError,
  InvalidInputError,
  InvariantViolationError,
  NotFoundError,
} from './errors.js';
import { CAD_PAPER, PEN, mm, type Theme } from './theme.js';
import type {
  Annotation,
  AnnotationContent,
  AnnotationPlacement,
  AnnotationRouting,
  DefinitionCollections,
  JsonObject,
  JsonValue,
  SnapshotStamp,
  TextAlign,
  Unsubscribe,
  Vec2,
} from './types.js';
import { revisionCache } from './internal/snapshot-cache.js';
import { assertJson, type JsonBounds } from './internal/json.js';

export type DefinitionKind = 'style' | 'template' | 'terminator' | 'enclosure';

export interface DefinitionBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface DefinitionAttachment {
  readonly point: Vec2;
  readonly direction: Vec2;
}

export type DeclarativePathCommand =
  | { readonly command: 'move'; readonly to: Vec2 }
  | { readonly command: 'line'; readonly to: Vec2 }
  | { readonly command: 'quadratic'; readonly control: Vec2; readonly to: Vec2 }
  | {
      readonly command: 'cubic';
      readonly control1: Vec2;
      readonly control2: Vec2;
      readonly to: Vec2;
    }
  | { readonly command: 'close' };

/**
 * Which side of the label the leader arrives at. `auto` picks whichever side faces the target.
 *
 * `top` and `bottom` are for labels arranged in rows above and below the model, where a leader
 * arriving from the side would have to loop around the label to reach it.
 */
export type LandingSide = 'auto' | 'left' | 'right' | 'top' | 'bottom';

/**
 * How the landing is drawn.
 *
 * - `shoulder` — a visible horizontal segment, then a gap, then the label. The MLEADER default.
 * - `underline` — the landing continues beneath the text rather than stopping short of it.
 * - `none` — no landing; the leader meets the label directly.
 */
export type LandingRender = 'shoulder' | 'underline' | 'none';

/**
 * The short horizontal tail between the sloping leader and the label.
 *
 * This is the detail that makes a leader read as a note rather than as another line in the model.
 * A line running diagonally into text looks like pipework; the same line with a level tail into the
 * text reads immediately as an annotation.
 *
 * Every field is optional, so a style only states what it changes. Anything unset falls back to
 * {@link DEFAULT_LANDING}.
 */
export interface StyleLanding {
  readonly length?: number;
  readonly side?: LandingSide;
  readonly gap?: number;
  readonly render?: LandingRender;
}

/**
 * How the box around a label is painted: its fill, its border, its padding.
 *
 * The *shape* of that box comes from `enclosureId` instead. Keeping the two apart means one circle
 * shape can be painted a dozen different ways without redefining the circle each time.
 */
export interface StyleContentBox {
  readonly backgroundColor?: string;
  /** 0 to 1. An opaque background hides the model behind the label so the text stays readable. */
  readonly backgroundOpacity?: number;
  readonly borderColor?: string;
  readonly borderWidth?: number;
  readonly borderRadius?: number;
  readonly padding?: number;
  /**
   * How text lines up in the box. Left unset, each kind of content picks sensibly for itself —
   * notes read from the start, tags and symbols centre — so most styles never need to say.
   */
  readonly align?: TextAlign;
  /**
   * How bold the main text is. Left unset, each kind of content picks for itself; a style only sets
   * this when it wants something different — a grid bubble, for instance, should look like a grid
   * bubble whatever text is poured into it.
   */
  readonly weight?: 'normal' | 'bold';
}

/** What a leader's tail looks like when a style does not say. */
export const DEFAULT_LANDING: Required<StyleLanding> = Object.freeze({
  length: 28,
  side: 'auto',
  gap: 6,
  render: 'shoulder',
});

export interface StyleDefinition {
  readonly kind: 'style';
  readonly id: string;
  readonly name: string;
  readonly lineColor: string;
  readonly lineWidth: number;
  readonly textColor: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  /** What is drawn where the leader meets the model — usually an arrowhead. */
  readonly terminatorId: string;
  /** The shape drawn around the label. */
  readonly enclosureId?: string;
  /** What is drawn where the leader meets the label. Usually nothing. */
  readonly labelTerminatorId?: string;
  readonly landing?: StyleLanding;
  readonly content?: StyleContentBox;
}

/**
 * Per-annotation tweaks to a style — a different colour on this one note, without defining a whole
 * new style.
 *
 * Identity fields are deliberately excluded: an override changes how a style looks, never which
 * style it is.
 *
 * Typed against the real style rather than loose JSON on purpose, so a misspelled property is an
 * error where you write it instead of a setting that silently does nothing.
 */
export type StyleOverride = Partial<Omit<StyleDefinition, 'kind' | 'id' | 'name'>>;

export interface TemplateDefaults {
  readonly content?: AnnotationContent;
  readonly styleId?: string;
  readonly placement?: AnnotationPlacement;
  readonly routing?: AnnotationRouting;
}

export interface TemplateDefinition {
  readonly kind: 'template';
  readonly id: string;
  readonly name: string;
  readonly defaults: TemplateDefaults;
}

/**
 * Shapes are drawn in multiples of a unit rather than in pixels, so they stay correct at any size.
 *
 * `'text-height'` scales with the text, which is how standards specify an arrowhead: as long as the
 * lettering is tall. `'line-width'` scales with the pen, which is how the surface dot is specified:
 * five line widths across.
 */
export type TerminatorSizing = 'text-height' | 'line-width';

export interface TerminatorDefinition {
  readonly kind: 'terminator';
  readonly id: string;
  readonly name: string;
  readonly bounds: DefinitionBounds;
  readonly attachment: DefinitionAttachment;
  readonly commands: readonly DeclarativePathCommand[];
  readonly fill: 'filled' | 'outline';
  readonly sizing?: TerminatorSizing;
}

/**
 * Whether a shape may be stretched to fit its text. A stretched circle is an ellipse, so shapes
 * that must stay regular declare it once here instead of every style having to remember.
 */
export type EnclosureAspect = 'free' | 'square';

/** Whether rounding the corners means anything for this shape. Only rectangles have corners. */
export type EnclosureCorners = 'sharp' | 'radiused';

export interface EnclosureDefinition {
  readonly kind: 'enclosure';
  readonly id: string;
  readonly name: string;
  /** Drawn once at unit size around the origin, then scaled onto whatever text it ends up
   *  wrapping — so one definition serves every label size. */
  readonly bounds: DefinitionBounds;
  readonly attachment: DefinitionAttachment;
  readonly commands: readonly DeclarativePathCommand[];
  readonly aspect?: EnclosureAspect;
  readonly corners?: EnclosureCorners;
}

export type TypedDefinition =
  | StyleDefinition
  | TemplateDefinition
  | TerminatorDefinition
  | EnclosureDefinition;

export interface DefinitionReferenceCounts {
  readonly annotations: number;
  readonly styles: number;
  readonly templates: number;
  readonly total: number;
}

export interface DefinitionMutation<Value> {
  readonly definitions: readonly TypedDefinition[];
  readonly value: Value;
}

/**
 * How styles reach the document.
 *
 * Styles live in the document itself rather than in a separate registry, which is what makes adding
 * one undoable and makes a saved file carry everything needed to draw it.
 */
export interface DefinitionDocumentPort {
  readDefinitions(): readonly TypedDefinition[];
  referenceCounts(id: string): DefinitionReferenceCounts;
  snapshotStamp(): SnapshotStamp;
  subscribe(listener: () => void): Unsubscribe;
  transact<Value>(
    label: string,
    operation: (current: readonly TypedDefinition[]) => DefinitionMutation<Value>,
  ): Value;
}

export interface DefinitionsSnapshot extends SnapshotStamp {
  readonly definitions: readonly TypedDefinition[];
}

/** Template defaults are a handful of fields. The caps stop a runaway object, not a real template. */
const TEMPLATE_JSON_BOUNDS: JsonBounds = Object.freeze({
  maxDepth: 16,
  maxNodes: 2_048,
  maxArrayLength: 512,
  maxKeyLength: 128,
});

/** Standard arrowhead proportions: three times as long as it is wide. */
const ARROW_HALF_WIDTH = 1 / 6;

/** Drawn with its tip at the origin pointing backwards, so placing one is just a move and a
 *  rotation — no reflection, no special cases per direction. */
const ANCHOR_TIP: DefinitionAttachment = { point: { x: 0, y: 0 }, direction: { x: 1, y: 0 } };

const DEFAULT_TERMINATOR: TerminatorDefinition = {
  kind: 'terminator',
  id: 'builtin.terminator.arrow',
  name: 'Arrow',
  bounds: { x: -1, y: -ARROW_HALF_WIDTH, width: 1, height: ARROW_HALF_WIDTH * 2 },
  attachment: ANCHOR_TIP,
  commands: [
    { command: 'move', to: { x: 0, y: 0 } },
    { command: 'line', to: { x: -1, y: -ARROW_HALF_WIDTH } },
    { command: 'line', to: { x: -1, y: ARROW_HALF_WIDTH } },
    { command: 'close' },
  ],
  fill: 'filled',
};

const OPEN_ARROW_TERMINATOR: TerminatorDefinition = {
  kind: 'terminator',
  id: 'builtin.terminator.arrow-open',
  name: 'Open arrow',
  bounds: { x: -1, y: -ARROW_HALF_WIDTH, width: 1, height: ARROW_HALF_WIDTH * 2 },
  attachment: ANCHOR_TIP,
  // An open V drawn with the pen, not a filled triangle. AutoCAD calls this one "Open".
  commands: [
    { command: 'move', to: { x: -1, y: -ARROW_HALF_WIDTH } },
    { command: 'line', to: { x: 0, y: 0 } },
    { command: 'line', to: { x: -1, y: ARROW_HALF_WIDTH } },
  ],
  fill: 'outline',
};

/** Half the reach of a unit-length 45° tick. */
const TICK_REACH = 0.3536;

const TICK_TERMINATOR: TerminatorDefinition = {
  kind: 'terminator',
  id: 'builtin.terminator.tick',
  name: 'Architectural tick',
  bounds: { x: -TICK_REACH, y: -TICK_REACH, width: TICK_REACH * 2, height: TICK_REACH * 2 },
  attachment: ANCHOR_TIP,
  // Drawn across the point rather than behind it. That is what makes it read as a tick mark.
  commands: [
    { command: 'move', to: { x: -TICK_REACH, y: TICK_REACH } },
    { command: 'line', to: { x: TICK_REACH, y: -TICK_REACH } },
  ],
  fill: 'outline',
};

/** The standard surface dot: five line widths across. */
const DOT_RADIUS = 2.5;
/** The magic number for drawing a circle out of four curves. Scaled by the radius. */
const DOT_HANDLE = DOT_RADIUS * 0.5523;

const DOT_TERMINATOR: TerminatorDefinition = {
  kind: 'terminator',
  id: 'builtin.terminator.dot',
  name: 'Surface dot',
  bounds: { x: -DOT_RADIUS, y: -DOT_RADIUS, width: DOT_RADIUS * 2, height: DOT_RADIUS * 2 },
  attachment: ANCHOR_TIP,
  commands: [
    { command: 'move', to: { x: DOT_RADIUS, y: 0 } },
    { command: 'cubic', control1: { x: DOT_RADIUS, y: DOT_HANDLE }, control2: { x: DOT_HANDLE, y: DOT_RADIUS }, to: { x: 0, y: DOT_RADIUS } },
    { command: 'cubic', control1: { x: -DOT_HANDLE, y: DOT_RADIUS }, control2: { x: -DOT_RADIUS, y: DOT_HANDLE }, to: { x: -DOT_RADIUS, y: 0 } },
    { command: 'cubic', control1: { x: -DOT_RADIUS, y: -DOT_HANDLE }, control2: { x: -DOT_HANDLE, y: -DOT_RADIUS }, to: { x: 0, y: -DOT_RADIUS } },
    { command: 'cubic', control1: { x: DOT_HANDLE, y: -DOT_RADIUS }, control2: { x: DOT_RADIUS, y: -DOT_HANDLE }, to: { x: DOT_RADIUS, y: 0 } },
    { command: 'close' },
  ],
  fill: 'filled',
  sizing: 'line-width',
};

/** Label shapes are drawn at unit size around the origin, and leaders meet them on the left. */
const UNIT_BOX: DefinitionBounds = { x: -0.5, y: -0.5, width: 1, height: 1 };
const LEFT_EDGE: DefinitionAttachment = { point: { x: -0.5, y: 0 }, direction: { x: -1, y: 0 } };

/** The same circle-drawing constant, at the unit box's radius. */
const CIRCLE_HANDLE = 0.5 * 0.5523;

const UNIT_CIRCLE: readonly DeclarativePathCommand[] = [
  { command: 'move', to: { x: 0.5, y: 0 } },
  { command: 'cubic', control1: { x: 0.5, y: CIRCLE_HANDLE }, control2: { x: CIRCLE_HANDLE, y: 0.5 }, to: { x: 0, y: 0.5 } },
  { command: 'cubic', control1: { x: -CIRCLE_HANDLE, y: 0.5 }, control2: { x: -0.5, y: CIRCLE_HANDLE }, to: { x: -0.5, y: 0 } },
  { command: 'cubic', control1: { x: -0.5, y: -CIRCLE_HANDLE }, control2: { x: -CIRCLE_HANDLE, y: -0.5 }, to: { x: 0, y: -0.5 } },
  { command: 'cubic', control1: { x: CIRCLE_HANDLE, y: -0.5 }, control2: { x: 0.5, y: -CIRCLE_HANDLE }, to: { x: 0.5, y: 0 } },
  { command: 'close' },
];

const DEFAULT_ENCLOSURE: EnclosureDefinition = {
  kind: 'enclosure',
  id: 'builtin.enclosure.rectangle',
  name: 'Rectangle',
  bounds: UNIT_BOX,
  attachment: LEFT_EDGE,
  commands: [
    { command: 'move', to: { x: -0.5, y: -0.5 } },
    { command: 'line', to: { x: 0.5, y: -0.5 } },
    { command: 'line', to: { x: 0.5, y: 0.5 } },
    { command: 'line', to: { x: -0.5, y: 0.5 } },
    { command: 'close' },
  ],
  corners: 'radiused',
};

const CIRCLE_ENCLOSURE: EnclosureDefinition = {
  kind: 'enclosure',
  id: 'builtin.enclosure.circle',
  name: 'Circle',
  bounds: UNIT_BOX,
  attachment: LEFT_EDGE,
  commands: UNIT_CIRCLE,
  aspect: 'square',
};

const SPLIT_CIRCLE_ENCLOSURE: EnclosureDefinition = {
  kind: 'enclosure',
  id: 'builtin.enclosure.split-circle',
  name: 'Split circle',
  bounds: UNIT_BOX,
  attachment: LEFT_EDGE,
  // The detail-bubble shape: a circle split by a line across its middle.
  commands: [
    ...UNIT_CIRCLE,
    { command: 'move', to: { x: -0.5, y: 0 } },
    { command: 'line', to: { x: 0.5, y: 0 } },
  ],
  aspect: 'square',
};

const HEXAGON_ENCLOSURE: EnclosureDefinition = {
  kind: 'enclosure',
  id: 'builtin.enclosure.hexagon',
  name: 'Hexagon',
  bounds: UNIT_BOX,
  attachment: LEFT_EDGE,
  commands: [
    { command: 'move', to: { x: -0.25, y: -0.5 } },
    { command: 'line', to: { x: 0.25, y: -0.5 } },
    { command: 'line', to: { x: 0.5, y: 0 } },
    { command: 'line', to: { x: 0.25, y: 0.5 } },
    { command: 'line', to: { x: -0.25, y: 0.5 } },
    { command: 'line', to: { x: -0.5, y: 0 } },
    { command: 'close' },
  ],
};

const CHEVRON_ENCLOSURE: EnclosureDefinition = {
  kind: 'enclosure',
  id: 'builtin.enclosure.chevron',
  name: 'Chevron',
  bounds: UNIT_BOX,
  attachment: LEFT_EDGE,
  // Points right. The tip takes space the text would otherwise use, so styles built on this shape
  // want more padding than a plain box.
  commands: [
    { command: 'move', to: { x: -0.5, y: -0.5 } },
    { command: 'line', to: { x: 0.25, y: -0.5 } },
    { command: 'line', to: { x: 0.5, y: 0 } },
    { command: 'line', to: { x: 0.25, y: 0.5 } },
    { command: 'line', to: { x: -0.5, y: 0.5 } },
    { command: 'close' },
  ],
};

/** The style an annotation resolves against when it names none. Internal: not in `index.ts`. */
export const DEFAULT_STYLE_ID = 'builtin.style.standard';
const GRID_BUBBLE_STYLE_ID = 'builtin.style.grid-bubble';

/** How far the leader's tail runs, in paper millimetres. A note reaches furthest, a symbol less, a
 *  dimension least — longer text needs more of a run-in to read as attached to it. */
const NOTE_LANDING: StyleLanding = { length: mm(7.5), gap: mm(1.5) };
const SYMBOL_LANDING: StyleLanding = { length: mm(6), gap: mm(1.5) };
const TIGHT_LANDING: StyleLanding = { length: mm(5), gap: mm(1) };

/**
 * The eleven built-in styles, built from a colour scheme.
 *
 * Both schemes produce the same style ids, so switching a whole drawing from light to dark changes
 * nothing about the annotations themselves — no document is edited and no reference has to move.
 *
 * There is less here than eleven separate designs suggests: the shapes all come from the label
 * outlines above, and what actually differs between these styles is ink, pen weight, tail length
 * and padding.
 */
export function buildDefaultStyles(theme: Theme): readonly StyleDefinition[] {
  const base = {
    kind: 'style',
    lineColor: theme.ink,
    lineWidth: PEN.thin,
    textColor: theme.ink,
    fontFamily: theme.fontStack,
    fontSize: theme.fontSize,
    terminatorId: DEFAULT_TERMINATOR.id,
  } as const;

  // A bubble: outlined, opaque behind, with its number centred. It ends in a dot rather than an
  // arrowhead because it marks a surface rather than an edge — which is what a grid line or a
  // detail callout points at.
  //
  // The text weight is stated outright rather than left to the content, because someone choosing
  // this shape wants a grid bubble, and it must look like one whatever text goes in it.
  const bubble = (ink: string) => ({
    lineColor: ink,
    textColor: ink,
    terminatorId: DOT_TERMINATOR.id,
    landing: SYMBOL_LANDING,
    content: {
      backgroundColor: theme.mask,
      backgroundOpacity: 1,
      borderColor: ink,
      borderWidth: PEN.medium,
      padding: mm(2),
      align: 'middle',
      weight: 'bold',
    },
  } satisfies StyleOverride);

  // A BIM tag: solid fill with the text knocked out in the background colour, so it stays readable
  // in both light and dark schemes. The shape says which discipline it belongs to; recolouring it
  // per discipline is the host's business.
  const tag = (padding: number) => ({
    lineColor: theme.accent,
    textColor: theme.paper,
    terminatorId: DOT_TERMINATOR.id,
    landing: SYMBOL_LANDING,
    content: {
      backgroundColor: theme.accent,
      backgroundOpacity: 1,
      borderColor: theme.accent,
      borderWidth: PEN.medium,
      padding,
      align: 'middle',
      weight: 'bold',
    },
  } satisfies StyleOverride);

  // No box at all, for the marks that sit on the model and must not hide it.
  const bare = {
    landing: SYMBOL_LANDING,
    content: { borderWidth: 0, padding: mm(1) },
  } satisfies StyleOverride;

  return deepFreeze<readonly StyleDefinition[]>([
    {
      ...base,
      id: DEFAULT_STYLE_ID,
      name: 'Standard',
      enclosureId: DEFAULT_ENCLOSURE.id,
      landing: NOTE_LANDING,
      content: {
        backgroundColor: theme.mask,
        backgroundOpacity: 1,
        borderColor: theme.border,
        borderWidth: PEN.thin,
        borderRadius: mm(0.5),
        padding: mm(1.5),
      },
    },
    {
      ...base,
      id: 'builtin.style.note',
      name: 'Note',
      terminatorId: TICK_TERMINATOR.id,
      landing: NOTE_LANDING,
      // With no shape named, the label keeps its own plain box — and a zero-width border leaves
      // that box invisible.
      content: { backgroundColor: theme.mask, backgroundOpacity: 0.92, borderWidth: 0, padding: mm(1) },
    },
    {
      ...base,
      id: 'builtin.style.dimension',
      name: 'Dimension',
      lineColor: theme.inkMuted,
      textColor: theme.inkMuted,
      landing: TIGHT_LANDING,
      content: { backgroundColor: theme.mask, backgroundOpacity: 0.9, borderWidth: 0, padding: mm(1) },
    },
    {
      ...base, ...bubble(theme.accent),
      id: 'builtin.style.detail-bubble', name: 'Detail bubble',
      enclosureId: SPLIT_CIRCLE_ENCLOSURE.id,
    },
    {
      // A section head points along the cut it marks, so it takes an arrowhead. A detail bubble
      // marks a surface, so it takes a dot.
      ...base, ...bubble(theme.accent),
      id: 'builtin.style.section-head', name: 'Section head',
      enclosureId: SPLIT_CIRCLE_ENCLOSURE.id,
      terminatorId: DEFAULT_TERMINATOR.id,
    },
    {
      ...base, ...bubble(theme.ink),
      id: GRID_BUBBLE_STYLE_ID, name: 'Grid bubble',
      enclosureId: CIRCLE_ENCLOSURE.id,
      landing: TIGHT_LANDING,
    },
    { ...base, ...bare, id: 'builtin.style.level-head', name: 'Level head', terminatorId: DOT_TERMINATOR.id },
    { ...base, ...bare, id: 'builtin.style.spot-elevation', name: 'Spot elevation' },
    {
      ...base, ...tag(mm(2)),
      id: 'builtin.style.tag-circle', name: 'Tag · circle',
      enclosureId: CIRCLE_ENCLOSURE.id,
    },
    {
      // A pointed shape steals width from the text, so those tags need more padding than a circle.
      ...base, ...tag(mm(3)),
      id: 'builtin.style.tag-hexagon', name: 'Tag · hexagon',
      enclosureId: HEXAGON_ENCLOSURE.id,
    },
    {
      ...base, ...tag(mm(3)),
      id: 'builtin.style.tag-chevron', name: 'Tag · chevron',
      enclosureId: CHEVRON_ENCLOSURE.id,
    },
  ]);
}

const DEFAULT_TEMPLATE: TemplateDefinition = {
  kind: 'template',
  id: 'builtin.template.note',
  name: 'Standard note',
  defaults: {
    content: { kind: 'plain-note', text: '' },
    styleId: DEFAULT_STYLE_ID,
    placement: { kind: 'automatic' },
    routing: { kind: 'automatic', mode: 'dogleg' },
  },
};

/**
 * Templates pair a style with a route, for the cases where the two go together.
 *
 * A grid bubble, for instance, wants a straight vertical drop onto its grid line. A style cannot
 * express that: every saved leader already records its own route, so there is no unset value for a
 * style default to fill in. A template applies at the moment of creation instead, which is exactly
 * where that choice belongs.
 */
const GRID_BUBBLE_TEMPLATE: TemplateDefinition = {
  kind: 'template',
  id: 'builtin.template.grid-bubble',
  name: 'Grid bubble',
  defaults: {
    content: { kind: 'symbolic-block', symbol: 'circle', label: '' },
    styleId: GRID_BUBBLE_STYLE_ID,
    placement: { kind: 'automatic' },
    routing: { kind: 'automatic', mode: 'orthogonal' },
  },
};

/**
 * The built-in definitions in the default light colour scheme.
 *
 * The **ids** are the same on every instance, whichever scheme it uses — this is the canonical list
 * to check a style id against. The **colours** are not: to see what is actually being drawn, read
 * `definitions.list()` on the instance itself.
 */
export const BUILT_IN_DEFINITIONS: readonly TypedDefinition[] = deepFreeze([
  ...buildDefaultStyles(CAD_PAPER),
  DEFAULT_TEMPLATE,
  GRID_BUBBLE_TEMPLATE,
  DEFAULT_TERMINATOR,
  OPEN_ARROW_TERMINATOR,
  TICK_TERMINATOR,
  DOT_TERMINATOR,
  DEFAULT_ENCLOSURE,
  CIRCLE_ENCLOSURE,
  SPLIT_CIRCLE_ENCLOSURE,
  HEXAGON_ENCLOSURE,
  CHEVRON_ENCLOSURE,
]);

const BUILT_IN_IDS = new Set(BUILT_IN_DEFINITIONS.map(({ id }) => id));

const THEMED_DEFINITIONS = new WeakMap<Theme, readonly TypedDefinition[]>();

/**
 * The built-in definitions for a given colour scheme.
 *
 * Only styles carry colour, so a themed set is the eleven styles rebuilt from the new palette,
 * followed by exactly the same shapes and arrowheads. Ids never change, which is why everything
 * that only cares about ids can keep reading the plain list instead.
 *
 * Cached per scheme, because this is consulted for every annotation on every frame.
 */
export function builtInDefinitions(theme?: Theme): readonly TypedDefinition[] {
  if (theme === undefined || theme === CAD_PAPER) return BUILT_IN_DEFINITIONS;
  const cached = THEMED_DEFINITIONS.get(theme);
  if (cached !== undefined) return cached;
  const built = deepFreeze<readonly TypedDefinition[]>([
    ...buildDefaultStyles(theme),
    ...BUILT_IN_DEFINITIONS.filter(({ kind }) => kind !== 'style'),
  ]);
  THEMED_DEFINITIONS.set(theme, built);
  return built;
}

export interface TemplateApplicable {
  readonly content?: AnnotationContent;
  readonly styleId?: string;
  readonly placement?: AnnotationPlacement;
  readonly routing?: AnnotationRouting;
}

/** Copied on the way out, so nothing created from a template can later modify the template. */
export function applyTemplateDefaults<Target extends TemplateApplicable>(
  target: Target,
  template: TemplateDefinition,
): Target {
  // This template came out of the document, so it is read leniently: a field written by a newer
  // version is carried through rather than rejected.
  validateDefinition(template, []);
  return clone({ ...target, ...template.defaults }) as Target;
}

export class DefinitionsCapability {
  readonly #port: DefinitionDocumentPort;
  /** The definitions this instance actually draws with, colours included. */
  readonly #builtIns: readonly TypedDefinition[];

  readonly #snapshotCache = revisionCache<DefinitionsSnapshot>();

  public constructor(port: DefinitionDocumentPort, theme?: Theme) {
    this.#port = port;
    this.#builtIns = builtInDefinitions(theme);
  }

  public getSnapshot(): DefinitionsSnapshot {
    const stamp = this.#port.snapshotStamp();
    return this.#snapshotCache(stamp.runtimeRevision, () => Object.freeze({
      ...stamp,
      definitions: Object.freeze([...this.list()]),
    }));
  }

  public subscribe(listener: () => void): Unsubscribe {
    return this.#port.subscribe(listener);
  }

  public list(kind?: DefinitionKind): readonly TypedDefinition[] {
    const definitions = [...this.#builtIns, ...this.#port.readDefinitions()];
    return clone(kind === undefined ? definitions : definitions.filter((entry) => entry.kind === kind));
  }

  public get(id: string): TypedDefinition | undefined {
    const value = this.#builtIns.find((candidate) => candidate.id === id)
      ?? this.#port.readDefinitions().find((candidate) => candidate.id === id);
    return value === undefined ? undefined : clone(value);
  }

  public create<Definition extends TypedDefinition>(definition: Definition): Definition {
    validateDefinition(definition);
    this.#assertCustomId(definition.id);
    const owned = clone(definition);
    return this.#port.transact(`Create ${definition.kind} ${definition.id}`, (current) => {
      if (current.some(({ id }) => id === definition.id)) {
        throw new InvalidInputError(`Definition "${definition.id}" already exists`, {
          id: definition.id,
          kind: definition.kind,
        });
      }
      validateDefinitionReferences(owned, [...current, owned]);
      return { definitions: [...current, owned], value: clone(owned) };
    }) as Definition;
  }

  public update<Definition extends TypedDefinition>(
    id: string,
    replacement: Definition,
  ): Definition {
    validateDefinition(replacement);
    this.#assertCustomId(id);
    if (replacement.id !== id) {
      throw new InvalidInputError('A definition update cannot change its id', {
        id,
        replacementId: replacement.id,
      });
    }
    const owned = clone(replacement);
    return this.#port.transact(`Update ${replacement.kind} ${id}`, (current) => {
      const index = current.findIndex((candidate) => candidate.id === id);
      const before = current[index];
      if (before === undefined) throw new NotFoundError('definition', id);
      if (before.kind !== replacement.kind) {
        throw new InvalidInputError('A definition update cannot change its kind', {
          id,
          currentKind: before.kind,
          replacementKind: replacement.kind,
        });
      }
      const next = [...current];
      next[index] = owned;
      validateDefinitionReferences(owned, next);
      return { definitions: next, value: clone(owned) };
    }) as Definition;
  }

  public remove(id: string): TypedDefinition {
    this.#assertCustomId(id);
    const references = this.#port.referenceCounts(id);
    if (references.total > 0) {
      throw domainError('DEFINITION_IN_USE', `Definition "${id}" is still referenced`, {
        id,
        referenceCounts: references,
      });
    }
    return this.#port.transact(`Remove definition ${id}`, (current) => {
      const removed = current.find((candidate) => candidate.id === id);
      if (removed === undefined) throw new NotFoundError('definition', id);
      return {
        definitions: current.filter((candidate) => candidate.id !== id),
        value: clone(removed),
      };
    });
  }

  public applyTemplate<Target extends TemplateApplicable>(
    target: Target,
    templateId: string,
  ): Target {
    const template = this.get(templateId);
    if (template === undefined) throw new NotFoundError('template', templateId);
    if (template.kind !== 'template') {
      throw new InvalidInputError(`Definition "${templateId}" is not a template`, {
        id: templateId,
        kind: template.kind,
      });
    }
    return applyTemplateDefaults(target, template);
  }

  #assertCustomId(id: string): void {
    if (BUILT_IN_IDS.has(id) || id.startsWith('builtin.')) {
      throw domainError('IMMUTABLE_DEFINITION', `Built-in definition "${id}" is immutable`, {
        id,
        builtIn: true,
      });
    }
  }
}

export function validateDefinition(
  definition: TypedDefinition,
  unrecognized?: string[],
): void {
  if (definition === null || typeof definition !== 'object') {
    throw new InvalidInputError('Definition must be an object');
  }
  validateId(definition.id);
  validateBoundedString(definition.name, 'definition name', 256);
  switch (definition.kind) {
    case 'style':
      assertExactKeys(definition, [
        'kind', 'id', 'name', 'lineColor', 'lineWidth', 'textColor', 'fontFamily',
        'fontSize', 'terminatorId', 'enclosureId', 'labelTerminatorId', 'landing', 'content',
      ], 'style definition', unrecognized);
      validateStyle(definition);
      return;
    case 'template':
      assertExactKeys(definition, ['kind', 'id', 'name', 'defaults'], 'template definition', unrecognized);
      assertExactKeys(definition.defaults, ['content', 'styleId', 'placement', 'routing'], 'template defaults', unrecognized);
      assertJson(definition.defaults, 'template defaults', TEMPLATE_JSON_BOUNDS, (_failure, message, details) =>
        new InvalidInputError(message, details));
      return;
    case 'terminator':
      assertExactKeys(definition, [
        'kind', 'id', 'name', 'bounds', 'attachment', 'commands', 'fill', 'sizing',
      ], 'terminator definition', unrecognized);
      validateDeclarativeGeometry(definition, unrecognized);
      if (definition.fill !== 'filled' && definition.fill !== 'outline') {
        throw new InvalidInputError('Terminator fill must be filled or outline');
      }
      if (definition.sizing !== undefined
        && definition.sizing !== 'text-height' && definition.sizing !== 'line-width') {
        throw new InvalidInputError('Terminator sizing must be text-height or line-width');
      }
      return;
    case 'enclosure':
      assertExactKeys(definition, [
        'kind', 'id', 'name', 'bounds', 'attachment', 'commands', 'aspect', 'corners',
      ], 'enclosure definition', unrecognized);
      validateDeclarativeGeometry(definition, unrecognized);
      if (definition.aspect !== undefined
        && definition.aspect !== 'free' && definition.aspect !== 'square') {
        throw new InvalidInputError('Enclosure aspect must be free or square');
      }
      if (definition.corners !== undefined
        && definition.corners !== 'sharp' && definition.corners !== 'radiused') {
        throw new InvalidInputError('Enclosure corners must be sharp or radiused');
      }
      return;
    default:
      throw domainError('INVALID_DEFINITION', 'Unknown definition kind', {
        kind: (definition as { readonly kind?: unknown }).kind,
      });
  }
}

function validateDeclarativeGeometry(
  definition: TerminatorDefinition | EnclosureDefinition,
  unrecognized?: string[],
): void {
  assertExactKeys(definition.bounds, ['x', 'y', 'width', 'height'], 'definition bounds', unrecognized);
  assertExactKeys(definition.attachment, ['point', 'direction'], 'definition attachment', unrecognized);
  assertExactKeys(definition.attachment.point, ['x', 'y'], 'attachment point', unrecognized);
  assertExactKeys(definition.attachment.direction, ['x', 'y'], 'attachment direction', unrecognized);
  validateBounds(definition.bounds);
  validateContainedPoint(definition.attachment.point, definition.bounds, 'attachment point');
  validatePoint(definition.attachment.direction, 'attachment direction');
  if (Math.hypot(definition.attachment.direction.x, definition.attachment.direction.y) < 1e-9) {
    throw new InvalidInputError('Attachment direction must not be zero');
  }
  if (!Array.isArray(definition.commands) || definition.commands.length < 2 || definition.commands.length > 256) {
    throw new InvalidInputError('Declarative geometry must contain 2–256 path commands');
  }
  if (definition.commands[0]?.command !== 'move') {
    throw new InvalidInputError('Declarative geometry must begin with a move command');
  }
  for (const command of definition.commands) {
    switch (command.command) {
      case 'move':
      case 'line':
        assertExactKeys(command, ['command', 'to'], `${command.command} command`, unrecognized);
        assertExactKeys(command.to, ['x', 'y'], `${command.command} endpoint`, unrecognized);
        validateContainedPoint(command.to, definition.bounds, `${command.command} endpoint`);
        break;
      case 'quadratic':
        assertExactKeys(command, ['command', 'control', 'to'], 'quadratic command', unrecognized);
        validateContainedPoint(command.control, definition.bounds, 'quadratic control');
        validateContainedPoint(command.to, definition.bounds, 'quadratic endpoint');
        break;
      case 'cubic':
        assertExactKeys(command, ['command', 'control1', 'control2', 'to'], 'cubic command', unrecognized);
        validateContainedPoint(command.control1, definition.bounds, 'cubic control 1');
        validateContainedPoint(command.control2, definition.bounds, 'cubic control 2');
        validateContainedPoint(command.to, definition.bounds, 'cubic endpoint');
        break;
      case 'close':
        assertExactKeys(command, ['command'], 'close command', unrecognized);
        break;
      default:
        throw new InvalidInputError('Unsupported declarative path command');
    }
  }
}

/**
 * Reads definitions out of a saved document and writes them back.
 *
 * Both directions are forgiving: a field written by a newer version of ViewLeader is carried
 * through untouched rather than causing the file to be rejected.
 *
 * Creating or editing a definition is checked strictly instead, so an author's typo still fails
 * immediately, where they typed it.
 */
export function definitionToJson(
  definition: TypedDefinition,
  unrecognized: string[] = [],
): JsonObject {
  validateDefinition(definition, unrecognized);
  return clone(definition) as unknown as JsonObject;
}

export function definitionFromJson(
  value: JsonObject,
  unrecognized: string[] = [],
): TypedDefinition {
  const definition = clone(value) as unknown as TypedDefinition;
  validateDefinition(definition, unrecognized);
  return definition;
}

export function definitionsFromCollections(
  collections: DefinitionCollections,
  unrecognized: string[] = [],
): readonly TypedDefinition[] {
  const definitions = [
    ...collections.styles,
    ...collections.templates,
    ...collections.terminators,
    ...collections.enclosures,
  ].map((stored) => definitionFromJson(stored, unrecognized));
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id) || BUILT_IN_IDS.has(definition.id)) {
      throw domainError('INVALID_DEFINITION', `Duplicate or shadowed definition "${definition.id}"`, {
        id: definition.id,
      });
    }
    ids.add(definition.id);
  }
  for (const definition of definitions) validateDefinitionReferences(definition, definitions);
  return definitions;
}

/**
 * Writes definitions back into the document, just as forgivingly.
 *
 * This runs over every definition in the file each time any one of them is edited. Refusing here
 * would mean one small edit made the whole file unsaveable; quietly dropping the unknown field
 * would be the same bug, only harder to notice.
 */
export function definitionsToCollections(
  definitions: readonly TypedDefinition[],
  unrecognized: string[] = [],
): DefinitionCollections {
  const ids = new Set<string>();
  for (const definition of definitions) {
    validateDefinition(definition, unrecognized);
    if (BUILT_IN_IDS.has(definition.id) || definition.id.startsWith('builtin.') || ids.has(definition.id)) {
      throw domainError('INVALID_DEFINITION', `Duplicate or shadowed definition "${definition.id}"`, {
        id: definition.id,
      });
    }
    ids.add(definition.id);
  }
  for (const definition of definitions) validateDefinitionReferences(definition, definitions);
  return {
    styles: definitions.filter((definition) => definition.kind === 'style').map((entry) => definitionToJson(entry, unrecognized)),
    templates: definitions.filter((definition) => definition.kind === 'template').map((entry) => definitionToJson(entry, unrecognized)),
    terminators: definitions.filter((definition) => definition.kind === 'terminator').map((entry) => definitionToJson(entry, unrecognized)),
    enclosures: definitions.filter((definition) => definition.kind === 'enclosure').map((entry) => definitionToJson(entry, unrecognized)),
  };
}

export function countDefinitionReferences(
  id: string,
  definitions: readonly TypedDefinition[],
  annotations: readonly Annotation[],
): DefinitionReferenceCounts {
  let annotationReferences = 0;
  for (const annotation of annotations) {
    if (annotation.styleId === id) annotationReferences += 1;
    annotationReferences += countJsonString(annotation.styleOverride, id);
  }
  let styleReferences = 0;
  let templateReferences = 0;
  for (const definition of definitions) {
    if (definition.kind === 'style') {
      if (definition.terminatorId === id) styleReferences += 1;
      if (definition.labelTerminatorId === id) styleReferences += 1;
      if (definition.enclosureId === id) styleReferences += 1;
    } else if (definition.kind === 'template') {
      templateReferences += countJsonString(definition.defaults as unknown as JsonValue, id);
    }
  }
  return {
    annotations: annotationReferences,
    styles: styleReferences,
    templates: templateReferences,
    total: annotationReferences + styleReferences + templateReferences,
  };
}

function validateDefinitionReferences(
  definition: TypedDefinition,
  available: readonly TypedDefinition[],
): void {
  const get = (id: string): TypedDefinition | undefined =>
    BUILT_IN_DEFINITIONS.find((candidate) => candidate.id === id)
    ?? available.find((candidate) => candidate.id === id);
  if (definition.kind === 'style') {
    const terminator = get(definition.terminatorId);
    if (terminator?.kind !== 'terminator') {
      throw domainError('INVALID_DEFINITION', 'Style references an unknown terminator', {
        definitionId: definition.id,
        referenceId: definition.terminatorId,
      });
    }
    if (definition.labelTerminatorId !== undefined
      && get(definition.labelTerminatorId)?.kind !== 'terminator') {
      throw domainError('INVALID_DEFINITION', 'Style references an unknown label terminator', {
        definitionId: definition.id,
        referenceId: definition.labelTerminatorId,
      });
    }
    if (definition.enclosureId !== undefined) {
      const enclosure = get(definition.enclosureId);
      if (enclosure?.kind !== 'enclosure') {
        throw domainError('INVALID_DEFINITION', 'Style references an unknown enclosure', {
          definitionId: definition.id,
          referenceId: definition.enclosureId,
        });
      }
    }
  } else if (definition.kind === 'template' && definition.defaults.styleId !== undefined) {
    const style = get(definition.defaults.styleId);
    if (style?.kind !== 'style') {
      throw domainError('INVALID_DEFINITION', 'Template references an unknown style', {
        definitionId: definition.id,
        referenceId: definition.defaults.styleId,
      });
    }
  }
}

function validateStyle(style: StyleDefinition): void {
  validateColor(style.lineColor, 'line color');
  validateColor(style.textColor, 'text color');
  validateBoundedString(style.fontFamily, 'font family', 256);
  if (!/^[\p{L}\p{N} _.,'"-]+$/u.test(style.fontFamily)) {
    throw domainError('INVALID_DEFINITION', 'Font family must be a declarative family list');
  }
  validateId(style.terminatorId, 'Style terminatorId');
  if (style.enclosureId !== undefined) validateId(style.enclosureId, 'Style enclosureId');
  if (style.labelTerminatorId !== undefined) validateId(style.labelTerminatorId, 'Style labelTerminatorId');
  for (const [field, value] of [['lineWidth', style.lineWidth], ['fontSize', style.fontSize]] as const) {
    if (!Number.isFinite(value) || value <= 0 || value > 1_000) {
      throw new InvalidInputError(`${field} must be finite and positive`, { field, value });
    }
  }
  if (style.landing !== undefined) validateLanding(style.landing);
  if (style.content !== undefined) validateContentBox(style.content);
}

const LANDING_SIDES: readonly LandingSide[] = ['auto', 'left', 'right', 'top', 'bottom'];
const LANDING_RENDERS: readonly LandingRender[] = ['shoulder', 'underline', 'none'];

function validateLanding(landing: StyleLanding): void {
  assertExactKeys(landing, ['length', 'side', 'gap', 'render'], 'style landing');
  // Zero means something for both: a tail of no length, or one that touches the label.
  validateNonNegative(landing.length, 'landing length');
  validateNonNegative(landing.gap, 'landing gap');
  if (landing.side !== undefined && !LANDING_SIDES.includes(landing.side)) {
    throw new InvalidInputError('Landing side must be auto, left, right, top, or bottom', { side: landing.side });
  }
  if (landing.render !== undefined && !LANDING_RENDERS.includes(landing.render)) {
    throw new InvalidInputError('Landing render must be shoulder, underline, or none', {
      render: landing.render,
    });
  }
}

const TEXT_ALIGNS: readonly TextAlign[] = ['start', 'middle', 'end'];
const TEXT_WEIGHTS: readonly ('normal' | 'bold')[] = ['normal', 'bold'];

function validateContentBox(content: StyleContentBox): void {
  assertExactKeys(content, [
    'backgroundColor', 'backgroundOpacity', 'borderColor', 'borderWidth', 'borderRadius', 'padding',
    'align', 'weight',
  ], 'style content box');
  if (content.backgroundColor !== undefined) validateColor(content.backgroundColor, 'background color');
  if (content.borderColor !== undefined) validateColor(content.borderColor, 'border color');
  validateNonNegative(content.borderWidth, 'border width');
  validateNonNegative(content.borderRadius, 'border radius');
  validateNonNegative(content.padding, 'padding');
  if (content.backgroundOpacity !== undefined
    && (!Number.isFinite(content.backgroundOpacity)
      || content.backgroundOpacity < 0 || content.backgroundOpacity > 1)) {
    throw new InvalidInputError('Background opacity must be between 0 and 1', {
      backgroundOpacity: content.backgroundOpacity,
    });
  }
  if (content.align !== undefined && !TEXT_ALIGNS.includes(content.align)) {
    throw new InvalidInputError('Content align must be start, middle, or end', { align: content.align });
  }
  if (content.weight !== undefined && !TEXT_WEIGHTS.includes(content.weight)) {
    throw new InvalidInputError('Content weight must be normal or bold', { weight: content.weight });
  }
}

function validateNonNegative(value: number | undefined, label: string): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0 || value > 1_000) {
    throw new InvalidInputError(`${label} must be finite, non-negative, and bounded`, { value });
  }
}

/**
 * Merges an override onto a style, field by field, one level down into the nested groups.
 *
 * A plain top-level merge would be wrong: overriding just the gap would replace the whole tail
 * description and silently lose its length and side. Two levels covers the entire schema, so there
 * is no need for anything deeper.
 */
export function mergeStyleOverride(base: StyleOverride, override: StyleOverride): StyleOverride {
  return {
    ...base,
    ...override,
    ...(base.landing === undefined && override.landing === undefined
      ? {}
      : { landing: { ...base.landing, ...override.landing } }),
    ...(base.content === undefined && override.content === undefined
      ? {}
      : { content: { ...base.content, ...override.content } }),
  };
}

/**
 * Which layer supplied a resolved field.
 *
 * A panel needs this to badge a field as overridden and to offer "revert to style" — without it a
 * host has to re-implement the merge to work out whether a value is the style's or the
 * annotation's, which is the duplication this exists to remove.
 */
export type StyleFieldSource = 'view-override' | 'annotation-override' | 'style';

/**
 * A style as it is actually being drawn, with the layer each field came from.
 *
 * Sizes are in **pixels and unscaled** — deliberately not the annotation-scaled values the renderer
 * uses, and deliberately without a millimetre twin. `px → mm → px` round-trips exactly but
 * `mm → px → mm` does not (up to 0.52% on the thinnest pen, and 19% if displayed to one decimal),
 * so a panel must write back only the fields it actually touched. `from` is what makes that
 * possible.
 *
 * Unlike `geometry.of()`, this is **stable**: it changes only when the document or the active saved
 * view changes, both of which publish. It is safe to hold in framework state and subscribe to.
 */
export interface ResolvedStyle extends Omit<StyleDefinition, 'kind' | 'id' | 'name'> {
  /** The style actually resolved against, which is what "revert to style" reverts to. */
  readonly styleId: string;
  /**
   * Present for every field the resolved style carries.
   *
   * `ponytail:` keyed at the top level only, while `landing` and `content` merge one level deep.
   * Ceiling — when two layers each set a *different* sub-field of the same group, this names the
   * higher layer for the whole group, so a "revert to style" that clears `landing` discards the
   * lower layer's sub-fields along with it. Upgrade path: let those two keys carry a nested
   * `Record<keyof StyleLanding, StyleFieldSource>` instead of a single source, and have revert
   * rebuild the group rather than delete it. Not built until a panel needs sub-field reverts.
   */
  readonly from: Readonly<Partial<Record<keyof StyleOverride, StyleFieldSource>>>;
}

/**
 * Resolves one annotation's style through the three layers and records where each field came from.
 *
 * Precedence, highest first: the active saved view's override, the annotation's own override, then
 * the style definition. `landing` and `content` merge one level deep, matching the renderer — a
 * saved view setting one landing field must not wipe out the annotation's own settings beside it.
 */
export function resolveStyleWithProvenance(
  style: StyleDefinition,
  annotationOverride: StyleOverride = {},
  viewOverride: StyleOverride = {},
): ResolvedStyle {
  const overrides = mergeStyleOverride(annotationOverride, viewOverride);
  const from: { -readonly [Key in keyof StyleOverride]?: StyleFieldSource } = {};
  // The reader map is typed `OverrideReaders<StyleOverride>`, so the compiler already forces an
  // entry per field. Taking the field list from it means a new style field cannot be added without
  // provenance following it.
  for (const key of Object.keys(STYLE_OVERRIDE_READERS) as (keyof StyleOverride)[]) {
    if (overrides[key] === undefined && style[key] === undefined) continue;
    from[key] = viewOverride[key] !== undefined
      ? 'view-override'
      : annotationOverride[key] !== undefined ? 'annotation-override' : 'style';
  }
  const { kind, id, name, ...visual } = style;
  return Object.freeze({
    ...(mergeStyleOverride(visual, overrides) as Omit<StyleDefinition, 'kind' | 'id' | 'name'>),
    styleId: id,
    from: Object.freeze(from),
  });
}

/** Returns nothing when the stored value is not something this version can use. */
type OverrideReader<Value> = (
  value: unknown,
  dropped: string[],
  path: string,
) => Value | undefined;

/**
 * One reader per style field. Deliberately written so the compiler demands an entry for every
 * field — adding one to the schema fails to build until it says how it should be read back.
 */
type OverrideReaders<Shape> = {
  readonly [Key in keyof Shape]-?: OverrideReader<Exclude<Shape[Key], undefined>>;
};

const readText: OverrideReader<string> = (value) =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const readPositive: OverrideReader<number> = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

const readNonNegative: OverrideReader<number> = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function readOneOf<Value extends string>(allowed: readonly Value[]): OverrideReader<Value> {
  return (value) => allowed.includes(value as Value) ? value as Value : undefined;
}

const LANDING_READERS: OverrideReaders<StyleLanding> = {
  length: readNonNegative,
  side: readOneOf(LANDING_SIDES),
  gap: readNonNegative,
  render: readOneOf(LANDING_RENDERS),
};

const CONTENT_READERS: OverrideReaders<StyleContentBox> = {
  backgroundColor: readText,
  backgroundOpacity: (value) =>
    typeof value === 'number' && value >= 0 && value <= 1 ? value : undefined,
  borderColor: readText,
  borderWidth: readNonNegative,
  borderRadius: readNonNegative,
  padding: readNonNegative,
  align: readOneOf(TEXT_ALIGNS),
  weight: readOneOf(TEXT_WEIGHTS),
};

const STYLE_OVERRIDE_READERS: OverrideReaders<StyleOverride> = {
  lineColor: readText,
  lineWidth: readPositive,
  textColor: readText,
  fontFamily: readText,
  fontSize: readPositive,
  terminatorId: readText,
  labelTerminatorId: readText,
  enclosureId: readText,
  landing: (value, dropped, path) => readGroup(value, LANDING_READERS, dropped, path),
  content: (value, dropped, path) => readGroup(value, CONTENT_READERS, dropped, path),
};

function readGroup<Shape extends object>(
  value: unknown,
  readers: OverrideReaders<Shape>,
  dropped: string[],
  path: string,
): Shape | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const nested = path === '' ? key : `${path}.${key}`;
    const read = (readers as Record<string, OverrideReader<unknown> | undefined>)[key];
    if (read === undefined) {
      dropped.push(nested);
      continue;
    }
    const parsed = read(entry, dropped, nested);
    if (parsed !== undefined) result[key] = parsed;
  }
  return result as Shape;
}

/**
 * Strict when authoring, forgiving when loading.
 *
 * An override saved by a newer version must still open, so unknown fields are kept out of the
 * resolved style and reported once as a diagnostic. The document itself keeps the override exactly
 * as written, so saving does not destroy them.
 */
export function readStyleOverride(
  value: JsonObject | undefined,
  dropped: string[] = [],
): StyleOverride {
  return value === undefined ? {} : readGroup(value, STYLE_OVERRIDE_READERS, dropped, '') ?? {};
}

function validateBounds(bounds: DefinitionBounds): void {
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0
    || bounds.width > 100_000 || bounds.height > 100_000) {
    throw new InvalidInputError('Definition bounds must be finite, positive, and bounded');
  }
}

function validatePoint(point: Vec2, label: string): void {
  if (point === null || typeof point !== 'object'
    || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || Math.abs(point.x) > 1_000_000 || Math.abs(point.y) > 1_000_000) {
    throw new InvalidInputError(`${label} must be a finite bounded point`);
  }
}

function validateContainedPoint(point: Vec2, bounds: DefinitionBounds, label: string): void {
  validatePoint(point, label);
  const epsilon = 1e-9;
  if (point.x < bounds.x - epsilon || point.x > bounds.x + bounds.width + epsilon
    || point.y < bounds.y - epsilon || point.y > bounds.y + bounds.height + epsilon) {
    throw domainError('INVALID_DEFINITION', `${label} falls outside explicit definition bounds`, {
      point,
      bounds,
    });
  }
}

/** Errors name the field the author actually wrote, so a missing arrowhead reports the arrowhead
 *  rather than complaining about some unrelated "id". */
function validateId(id: string, label = 'Definition id'): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128
    || !/^[a-zA-Z][a-zA-Z0-9._:-]*$/u.test(id)) {
    throw new InvalidInputError(`${label} is invalid`, { id });
  }
}

function validateBoundedString(value: string, label: string, maximum: number): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new InvalidInputError(`${label} must contain 1–${maximum} characters`);
  }
}

function validateColor(value: string, label: string): void {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value)) {
    throw domainError('INVALID_DEFINITION', `${label} must be a hexadecimal color`);
  }
}

/**
 * Strict when authoring, forgiving when loading — the same rule as everywhere else.
 *
 * Loading, an unrecognised field belongs to a newer version, so it is reported and carried through.
 * Authoring, it is a typo, and the author is told about it at the point they made it.
 */
function assertExactKeys(
  value: object,
  allowed: readonly string[],
  label: string,
  unrecognized?: string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length === 0) return;
  if (unrecognized === undefined) {
    throw domainError('INVALID_DEFINITION', `${label} contains unsupported fields`, { unknown });
  }
  for (const key of unknown) unrecognized.push(`${label}.${key}`);
}

function countJsonString(value: JsonValue | undefined, target: string): number {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'string') return value === target ? 1 : 0;
  if (typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce((sum, child) => sum + countJsonString(child, target), 0);
  let total = 0;
  for (const child of Object.values(value)) total += countJsonString(child, target);
  return total;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// What the React and Vue pages have in common: the notes they seed, the swatches they offer and
// the styling of the chrome they draw. The two pages exist to show the same API in two frameworks,
// so everything that is not the framework lives here once. Styles are string-valued so the same
// object satisfies React's `CSSProperties` and Vue's `StyleValue`.
import type { ViewLeader } from 'viewleader';
import type { HandleEntry, SelectionValue } from 'viewleader/react';
import { MOCK_ELEMENTS } from './mockBuilding';

export const NOTES = [
  { key: 'roof', element: MOCK_ELEMENTS.roofSlab, title: 'Roof slab', text: 'RC 200 mm' },
  { key: 'door', element: MOCK_ELEMENTS.frontDoor, title: 'Front door', text: 'D-04' },
  { key: 'column', element: MOCK_ELEMENTS.cornerColumn, title: 'Corner column', text: 'C-12' },
] as const;

export const SWATCHES = ['#1f2937', '#b91c1c', '#047857'] as const;

export const HINT = 'Click a label to select it. Drag its handles, double-click to retype, recolour from'
  + ' the toolbar, nudge with the arrows. Every element here belongs to the page.';

/** Seeds one generation's notes and selects the first, so the page opens with its handles showing. */
export function seedNotes(leader: ViewLeader, generation: number): void {
  for (const note of NOTES) {
    leader.annotations.create({
      id: `${note.key}-${generation}`,
      anchor: {
        kind: 'element',
        modelId: 'building',
        elementId: note.element.id,
        // Where the leader points if the element is not in the model this session — a reload
        // with a changed id lands here rather than dropping the note.
        fallbackPoint: note.element.point,
      },
      content: { kind: 'callout', title: note.title, text: note.text },
    });
  }
  leader.annotations.select([`${NOTES[0].key}-${generation}`]);
}

/** Absolutely positioned against the boundary; the follow registry writes the transform every frame. */
export const FOLLOWED = { position: 'absolute', top: '0', left: '0', pointerEvents: 'auto' } as const;

/**
 * A handle drawn by the page rather than by core. Square for the arrow end, round for anything that
 * reshapes the leader — the same distinction core's own grips draw. A midpoint inserts a bend rather
 * than moving one, and hollow-versus-solid is the only thing on screen that says so.
 */
export const handleStyle = (entry: HandleEntry) => ({
  ...FOLLOWED,
  width: '9px',
  height: '9px',
  marginLeft: '-5px',
  marginTop: '-5px',
  cursor: entry.cursor,
  borderRadius: entry.kind === 'handle' ? '2px' : '5px',
  background: entry.cursor === 'copy' ? '#fff' : '#2563eb',
  border: '1.5px solid #2563eb',
  boxSizing: 'border-box',
} as const);

/** The swatch toolbar, sitting above the label's own box with `bottom: 100%` rather than a guessed offset. */
export const TOOLBAR = {
  position: 'absolute',
  left: '0',
  bottom: 'calc(100% + 6px)',
  display: 'flex',
  gap: '4px',
  padding: '4px',
  background: '#fff',
  border: '1px solid #d4d8e0',
  borderRadius: '6px',
  boxShadow: '0 2px 8px rgb(16 20 28 / 12%)',
} as const;

/**
 * One swatch. `current` is the selection's line colour, and `mixed` is a real state, not an absent
 * one: with several selected and disagreeing, no swatch is the current one.
 */
export const swatchStyle = (colour: string, current: SelectionValue<string> | undefined) => ({
  width: '18px',
  height: '18px',
  padding: '0',
  borderRadius: '4px',
  background: colour,
  cursor: 'pointer',
  border: current?.mixed === false && current.value === colour ? '2px solid #111' : '1px solid #d4d8e0',
} as const);

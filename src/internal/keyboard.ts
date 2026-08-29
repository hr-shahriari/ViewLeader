// The four keys an annotation editor needs, bound once instead of hand-rolled in every host.
//
// Only the nudge really earns a home in the library. Delete is three lines of
// `history.transaction`, Escape is one — but a nudge has to read the label's *drawn* rect and add
// the delta, never `placement.position`, or a single arrow press silently undoes the drag that
// placed the label. That is the knowledge `view-leader.ts`'s `move()` comment carries today and
// every host has to read; here it is written down once.
//
// Recorded honestly: this softens a position core states twice in shipped comments — "core … never
// claims Del, the arrows or ⌘A" (`demo/src/pages/host-chrome.ts`), "Undo, redo and Delete are the
// host's to name" (`demo/src/pages/leader-editor.ts`). This is a *binding-level* convenience over
// `annotations.*`; it does not move the position for core, which still claims only Escape while it
// holds a gesture.
//
// No `SnapshotSource` here: the controller publishes nothing. Every key writes straight through
// `annotations` and `history`, which publish their own changes, and the key map is fixed — there is
// no state a framework could render. It is a lifetime plus a side effect, closer to `useViewLeader`
// than to the hooks that return spreadable props.
import type { Vec2 } from '../types.js';
import type { ViewLeader } from '../view-leader.js';

export interface EditingKeyboardOptions {
  /**
   * Default `true`. `false` binds nothing at all, which is the whole override story: a host wanting
   * a different map turns this off and writes its own `keydown` — about 25 lines, as both gallery
   * pages already do.
   */
  readonly enabled?: boolean;
}

/**
 * Screen pixels per press, and with Shift held.
 *
 * Pixels rather than `mm()` deliberately, even though every other size in this library is written in
 * paper millimetres. The paper-unit convention exists so each constant is checkable against a
 * published drafting standard; no standard says how far an arrow key moves a label, so an `mm()`
 * here would be a citation to nothing — worse than a plain number, because it looks sourced.
 * `annotations.move()` speaks screen pixels and its doc comment already names arrow-key nudging as
 * the case it was hardened for. 1 and 10 are what both gallery pages ship and what the e2e suite
 * grades.
 */
const STEP = 1;
const COARSE_STEP = 10;

/** Screen axes: y grows downward, so ArrowUp is negative. */
const NUDGE: Readonly<Record<string, Vec2>> = {
  ArrowLeft: { x: -1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
  ArrowUp: { x: 0, y: -1 },
  ArrowDown: { x: 0, y: 1 },
};

/** What the last press wrote for one annotation, and the drawn rect it measured from. */
interface NudgeStep {
  readonly from: Vec2;
  readonly to: Vec2;
}

/**
 * Keyboard editing for one `ViewLeader`: arrows nudge, Shift+arrow nudges further, Delete and
 * Backspace remove the selection, Escape clears it.
 *
 * **Undo and redo are not bound.** Undo scope is application scope, and a library claiming
 * Cmd/Ctrl+Z at document level cannot know whose undo the user meant — a host with its own stack
 * would have two racing, invisibly, until someone pressed it over the wrong pane. Cmd/Ctrl+A is out
 * for the same reason, and Enter/Space are already handled per annotation by the overlay itself.
 *
 * The listener goes on the boundary's `ownerDocument`, matching the three `keydown` listeners core
 * already binds there. The library sets no `tabIndex` and calls no `.focus()`: focus stays the
 * host's, and two viewers in one page are separated with `enabled`, not with a second attachment
 * point.
 *
 * ```ts
 * const keys = new EditingKeyboard(viewLeader);
 * // …later
 * keys.dispose();
 * ```
 *
 * ponytail: fixed key map, no override. Ceiling — a host wanting different keys gets all four or
 * none. Upgrade path: a `keys` record, once a real host asks twice.
 *
 * ponytail: annotations only. Ceiling — a selected ink stroke is not deleted or nudged, so a mixed
 * selection on a marked-up page behaves inconsistently. Upgrade path: publish the ink selection on
 * a snapshot (`runtime.#selectedInk` has no public accessor today), then include it here.
 */
export class EditingKeyboard {
  readonly #leader: ViewLeader;
  /**
   * Where the current run of key repeats has written each label to.
   *
   * Cleared whenever a press starts a fresh run, so it never outlives one gesture.
   */
  readonly #run = new Map<string, NudgeStep>();
  #detach: (() => void) | undefined;

  public constructor(leader: ViewLeader, options: EditingKeyboardOptions = {}) {
    this.#leader = leader;
    if (options.enabled === false) return;
    // The overlay `<svg>` is a child of the boundary, so this *is* `boundary.ownerDocument` —
    // ViewLeader does not expose the boundary itself, and reaching through the overlay beats making
    // every caller hold on to an element the hook was never handed.
    const target = leader.overlayElement.ownerDocument;
    const handler = (event: KeyboardEvent): void => this.#handle(event);
    target.addEventListener('keydown', handler);
    this.#detach = (): void => target.removeEventListener('keydown', handler);
  }

  public dispose(): void {
    this.#detach?.();
    this.#detach = undefined;
    this.#run.clear();
  }

  #handle(event: KeyboardEvent): void {
    if (isTextEntryTarget(event.target)) return;
    const { annotations, editing, history } = this.#leader;

    if (event.key === 'Escape') {
      // Core binds Escape on this same document to cancel a gesture it holds. If that press was
      // already spent cancelling a drag, wiping the selection on top of it would be a second,
      // unasked-for effect of one keypress.
      if (editing.getSnapshot().phase === 'idle') annotations.clearSelection();
      return;
    }

    const selected = annotations.getSnapshot().selectedIds;
    if (selected.length === 0) return;

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      history.transaction('Delete annotations', () => {
        for (const id of selected) annotations.remove(id);
      });
      return;
    }

    const direction = NUDGE[event.key];
    if (direction === undefined) return;
    event.preventDefault();
    this.#nudge(selected, event.shiftKey ? COARSE_STEP : STEP, direction, event.repeat);
  }

  #nudge(
    ids: readonly string[],
    step: number,
    direction: Vec2,
    repeat: boolean,
  ): void {
    const delta = { x: direction.x * step, y: direction.y * step };
    if (!repeat) this.#run.clear();
    const { annotations, geometry, history } = this.#leader;
    // One transaction is one undo step for the whole selection, and `coalesce` folds a run of key
    // repeats into that same step. The caller opts in from `KeyboardEvent.repeat` because only the
    // caller knows a repeat is happening — without it a held arrow key pushes an entry per repeat
    // and evicts the default 100-entry history in about three seconds.
    history.transaction('Nudge annotations', () => {
      for (const id of ids) {
        const label = geometry.of(id)?.label;
        // Off screen this frame. Nothing to measure from, so nothing to move.
        if (label === undefined) continue;
        const from = { x: label.x, y: label.y };
        const previous = this.#run.get(id);
        // `geometry.of()` reports the last frame the runtime drew, so two repeats landing inside one
        // frame both read the same rect — and the second would write the position the first already
        // wrote, dropping the step. An unchanged rect means no frame has run since our last write,
        // so continue from it; a changed one means the layout is authoritative again.
        const base = previous !== undefined && previous.from.x === from.x && previous.from.y === from.y
          ? previous.to
          : from;
        const to = { x: base.x + delta.x, y: base.y + delta.y };
        // The drawn rect, not `placement.position`: an anchored label is drawn at its position plus
        // however far its anchor has moved since, so adding the delta to the stored position would
        // snap it back to where the camera was when it was dropped.
        annotations.move(id, to);
        this.#run.set(id, { from, to });
      }
    }, { coalesce: repeat });
  }
}

/**
 * Whether the key went to something the user is typing in — **the key-target guard**.
 *
 * Distinct from `isHostChrome` in `editing.ts`, **the pointerdown chrome guard**, which asks a
 * different question: did a press land on host chrome sitting over a label, and would dragging it
 * therefore drag the label. That one counts `button` and `data-viewleader-ignore` too; this one is
 * narrower on purpose, so a focused toolbar `<button>` still passes Delete and the arrows through
 * to the selection, which is what a toolbar button should do.
 *
 * `closest` rather than a tag check, so a caret inside a `contenteditable` region is covered as well
 * as the element carrying the attribute — and so is the inline label text editor, which sits inside
 * the boundary where no attachment point could protect it.
 *
 * Duck-typed rather than `instanceof HTMLElement`, for the same reason `isHostChrome` is: core is
 * handed an `Element` and must not assume a DOM global exists just to test one.
 *
 * ponytail: a form-control list. Ceiling — a host editor that is neither a form control nor
 * `contenteditable` (a custom caret painted over SVG, say) still has its keys taken; it must set
 * `enabled: false` while open. Upgrade path: honour the host's own `defaultPrevented` from a
 * capture-phase listener, if one asks.
 */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== 'object') return false;
  const element = target as { readonly closest?: unknown };
  if (typeof element.closest !== 'function') return false;
  const closest = element.closest as (selectors: string) => unknown;
  return closest.call(
    element,
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]',
  ) !== null;
}

// The screen edges the gallery's own chrome owns, handed to core once and kept in sync.
//
// Core never sees the host's DOM, so it cannot know that a fixed control dock is painted over the
// bottom of the viewport or that the notes panel hangs over the top-right of it. A label laid out
// underneath either one is invisible, or visible and un-clickable — "no note behind the toolbar" is
// the promise this library is built on — so every page with chrome measures it and claims the edge.
import type { ViewLeader } from 'viewleader';

/** Gap between the chrome's real edge and the box layout may use, so nothing sits flush against it. */
const BREATHING_ROOM = 8;

/**
 * Measures `.control-dock` and the open `.page-notes-body` and keeps `setViewportInsets` in step.
 *
 * Takes a getter rather than an instance because a page's runtime is not forever: `drafting-styles`
 * and `plugin-anatomy` rebuild theirs to swap a theme or a plugin, and the framework pages hand
 * ownership to a hook whose instance is null until the boundary mounts. The sync function is
 * returned for the same reason — insets live on the runtime, so a fresh one starts with none and
 * has to be told again.
 */
export function claimChromeEdges(leader: () => ViewLeader | null | undefined): () => void {
  // `#viewport` rather than the ViewLeader boundary: every page's boundary is `inset: 0` inside it,
  // so the two rectangles are the same one, and this works on the pages whose boundary belongs to a
  // framework hook and does not exist yet when this is called.
  const frame = document.querySelector<HTMLElement>('#viewport');
  const dock = document.querySelector<HTMLElement>('.control-dock');
  const notes = document.querySelector<HTMLDetailsElement>('details.page-notes');
  const notesBody = notes?.querySelector<HTMLElement>('.page-notes-body') ?? null;

  const sync = (): void => {
    const target = leader();
    if (!target || !frame) return;
    const box = frame.getBoundingClientRect();
    let top = 0;
    let right = 0;
    let bottom = 0;

    if (dock !== null) {
      // Insets are per-edge, so a bottom-left widget claims the whole bottom strip. Coarse on
      // purpose: the alternative is labels threading a gap the next wrapped button row will cover.
      // Measured rather than hard-coded, because the bar grows a second row at exactly the window
      // width where a constant would be wrong.
      const chrome = dock.getBoundingClientRect();
      bottom = Math.max(0, Math.round(box.bottom - chrome.top + BREATHING_ROOM));
    }

    if (notes?.open === true && notesBody !== null) {
      // The panel touches two edges — it hangs from the top of the viewport and is pinned to its
      // right — so a top strip and a right strip each cover it, and the cheaper one wins. Always
      // taking the top is what the panel's height makes dangerous: the busiest page's runs several
      // hundred pixels, and a top claim that deep leaves layout a band too short for its own labels,
      // which is label-on-label — the same north star broken from the other side. Compared as areas
      // because that is the drawing surface each claim actually costs.
      const chrome = notesBody.getBoundingClientRect();
      const asTop = Math.max(0, Math.round(chrome.bottom - box.top + BREATHING_ROOM));
      const asRight = Math.max(0, Math.round(box.right - chrome.left + BREATHING_ROOM));
      if (asTop * box.width <= asRight * box.height) top = asTop;
      else right = asRight;
    }

    // `null`, not four zeroes: a page whose panel is shut and whose dock does not exist has claimed
    // nothing, and should read that way to anyone inspecting `leader.viewportInsets`.
    target.setViewportInsets(top + right + bottom === 0 ? null : { top, right, bottom, left: 0 });
  };

  // Size changes only — no per-frame work, because chrome does not move when the camera does. The
  // observer catches the button bar wrapping and the panel reflowing at a narrower window. It does
  // NOT reliably catch the reader shutting the panel: a closed `<details>` stops rendering its
  // children rather than resizing them, so `toggle` is listened for as well.
  const observer = new ResizeObserver(sync);
  if (dock !== null) observer.observe(dock);
  if (notesBody !== null) observer.observe(notesBody);
  notes?.addEventListener('toggle', sync);

  sync();
  return sync;
}

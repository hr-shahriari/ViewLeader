// The screen edges the gallery's own chrome owns, handed to core once and kept in sync.
//
// Core never sees the host's DOM, so it cannot know that a fixed control dock is painted over the
// bottom of the viewport. A label laid out underneath it is invisible, or visible and un-clickable —
// "no note behind the toolbar" is the promise this library is built on — so every page with chrome
// measures it and claims the edge.
import type { ViewLeader } from 'viewleader';

/** Gap between the chrome's real edge and the box layout may use, so nothing sits flush against it. */
const BREATHING_ROOM = 8;

/**
 * Measures `.control-dock` and keeps `setViewportInsets` in step.
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

  const sync = (): void => {
    const target = leader();
    if (!target || !frame || dock === null) return;
    // Insets are per-edge, so a bottom-left widget claims the whole bottom strip. Coarse on purpose:
    // the alternative is labels threading a gap the next wrapped button row will cover. Measured
    // rather than hard-coded, because the bar grows a second row at exactly the window width where a
    // constant would be wrong.
    const box = frame.getBoundingClientRect();
    const chrome = dock.getBoundingClientRect();
    const bottom = Math.max(0, Math.round(box.bottom - chrome.top + BREATHING_ROOM));
    // `null`, not four zeroes: a page whose dock is off-screen has claimed nothing, and should read
    // that way to anyone inspecting `leader.viewportInsets`.
    target.setViewportInsets(bottom === 0 ? null : { top: 0, right: 0, bottom, left: 0 });
  };

  // Size changes only — no per-frame work, because chrome does not move when the camera does. The
  // observer is what catches the button bar wrapping to a second row at a narrower window.
  if (dock !== null) new ResizeObserver(sync).observe(dock);

  sync();
  return sync;
}

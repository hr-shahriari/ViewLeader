import type { LandingGeometry, RouteLegInput, ScreenBounds } from './routing.js';

type Baseline = 'first' | 'last';
interface LandingMemory { readonly signature: string; readonly baseline: Baseline }

export interface LandingProposal {
  readonly landing: LandingGeometry;
  readonly memory?: LandingMemory;
}

// CSS pixels: projection roundoff should not decide an initial tie, and subsequent camera
// jitter should not move the attachment by a whole line of text.
const INITIAL_TIE_EPSILON = 1e-7;
const SWITCH_MARGIN = 2;

export function selectTextBaseline(delta: number, previous?: Baseline): Baseline {
  if (previous === 'first') return delta > SWITCH_MARGIN ? 'last' : 'first';
  if (previous === 'last') return delta < -SWITCH_MARGIN ? 'first' : 'last';
  return delta <= INITIAL_TIE_EPSILON ? 'first' : 'last';
}

/** Transient attachment choices. Candidate evaluation is pure; only accepted routes commit. */
export class LandingStability {
  private readonly previous = new Map<string, LandingMemory>();

  preview(
    id: string,
    legs: readonly RouteLegInput[],
    bounds: ScreenBounds,
    landing: LandingGeometry,
  ): LandingProposal {
    const doglegs = legs.filter(({ anchor, route }) => route.mode === 'dogleg'
      && Number.isFinite(anchor.x) && Number.isFinite(anchor.y));
    const lines = landing.textLines;
    if (doglegs.length === 0 || lines === undefined || lines.first === lines.last
      || !Number.isFinite(lines.first) || !Number.isFinite(lines.last)) return { landing };
    const middle = doglegs.reduce((sum, { anchor }) => ({
      x: sum.x + anchor.x / doglegs.length, y: sum.y + anchor.y / doglegs.length,
    }), { x: 0, y: 0 });
    const side = landing.side === undefined || landing.side === 'auto'
      ? (middle.x <= bounds.x + bounds.width / 2 ? 'left' : 'right') : landing.side;
    if (side === 'top' || side === 'bottom') return { landing };
    const signature = JSON.stringify([
      side, landing.render ?? 'shoulder', lines.first, lines.last,
      doglegs.map(({ id: legId }) => legId).sort(),
    ]);
    const previous = this.previous.get(id);
    const baseline = selectTextBaseline(middle.y - (bounds.y + bounds.height / 2),
      previous?.signature === signature ? previous.baseline : undefined);
    const line = lines[baseline];
    return {
      landing: { ...landing, side, textLines: { first: line, last: line } },
      memory: { signature, baseline },
    };
  }

  commit(id: string, proposal: LandingProposal): void {
    if (proposal.memory === undefined) this.previous.delete(id);
    else this.previous.set(id, proposal.memory);
  }

  forget(liveIds: ReadonlySet<string>): void {
    for (const id of this.previous.keys()) if (!liveIds.has(id)) this.previous.delete(id);
  }

  clear(): void { this.previous.clear(); }
}

import type { Vector2d } from "../types";

const SVG_NS = 'http://www.w3.org/2000/svg';

export type AnchorEnd = 'arrow' | 'dot' | 'none'
export type LabelEnd = 'disc' | 'none'

export function makeAnchorEnd(at: Vector2d, dir: -1 | 1, kind: AnchorEnd, color = '#000000'): SVGElement | null {
    if (kind === 'none') return null
    if (kind === 'dot') {
        const c = document.createElementNS(SVG_NS, 'circle')
        c.setAttribute('cx', String(at.x))
        c.setAttribute('cy', String(at.y))
        c.setAttribute('r', '2.5')
        c.setAttribute('fill', color)
        return c;
    }

    const tip = at.x
    const back = at.x + dir * 7
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', `M ${tip} ${at.y} L ${back} ${at.y - 3} L ${back} ${at.y + 3} Z`);
    path.setAttribute('fill', color);
    return path;
}

export function makeLabelEnd(at: Vector2d, kind: LabelEnd, color = '#000000'): SVGElement | null {
    if (kind === 'none') return null
    const c = document.createElementNS(SVG_NS, 'circle')
    c.setAttribute('cx', String(at.x));
    c.setAttribute('cy', String(at.y));
    c.setAttribute('r', '2.5');
    c.setAttribute('fill', color);
    return c;
}
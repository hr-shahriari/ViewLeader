import type { AnchorPlugType, LabelPlugType } from '../types';

/**
 * SVG path data for built-in anchor endpoint markers (arrowheads pointing at the annotated target).
 * Each is drawn in a coordinate space centered at (0,0).
 */
export const BuiltInAnchorPlugs: Record<AnchorPlugType, string> = {
    Arrow1: 'M-10,-4L0,0L-10,4Z',
    Arrow2: 'M-10,-4L0,0L-10,4',
    Arrow3: 'M-8,-3L0,0L-8,3',
    Dot: 'M-3,0a3,3 0 1,0 6,0a3,3 0 1,0 -6,0',
    None: '',
};

/**
 * SVG path data for built-in label endpoint markers (at the label/text end of the leader).
 */
export const BuiltInLabelPlugs: Record<LabelPlugType, string> = {
    Disc: 'M-4,0a4,4 0 1,0 8,0a4,4 0 1,0 -8,0',
    Crosshair: 'M-6,0h12M0,-6v12',
    Diamond: 'M0,-5L5,0L0,5L-5,0Z',
    Square: 'M-4,-4h8v8h-8Z',
    None: '',
};

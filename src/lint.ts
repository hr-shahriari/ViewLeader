/**
 * Grades a drawn frame against drafting standards, the way a reviewer would mark up a drawing.
 *
 * Each rule names the standard behind it, because the first thing an engineer asks about a finding
 * is which clause it comes from:
 *
 *   leader-crossing       leader lines must not cross each other      ASME Y14.2 / ISO 128-22
 *   non-preferred-angle   leaders are drawn at standard angles        ISO 128-22
 *   minimum-text-height   text must be legible when printed           ISO 3098
 *   leader-through-label  a leader must not run through other text    ASME Y14.2
 */
import type { Rect, Vec2 } from './types.js';

export interface Segment {
  readonly start: Vec2;
  readonly end: Vec2;
}

const EPSILON = 1e-9;

export type IntersectionKind = 'none' | 'interior' | 'endpoint' | 't-junction' | 'collinear-overlap';
export interface Intersection { readonly kind: IntersectionKind; readonly point?: Vec2 }

function finitePoint(point: Vec2): boolean { return Number.isFinite(point.x) && Number.isFinite(point.y); }
function distance(a: Vec2, b: Vec2): number { return Math.hypot(b.x - a.x, b.y - a.y); }
function cross(a: Vec2, b: Vec2): number { return a.x * b.y - a.y * b.x; }
function subtract(a: Vec2, b: Vec2): Vec2 { return { x: a.x - b.x, y: a.y - b.y }; }
function inUnit(value: number): boolean { return value >= -EPSILON && value <= 1 + EPSILON; }
function strictlyInUnit(value: number): boolean { return value > EPSILON && value < 1 - EPSILON; }

export function classifyIntersection(a: Segment, b: Segment): Intersection {
  if (![a.start, a.end, b.start, b.end].every(finitePoint)) return { kind: 'none' };
  const r = subtract(a.end, a.start);
  const s = subtract(b.end, b.start);
  const denominator = cross(r, s);
  const qMinusP = subtract(b.start, a.start);
  if (Math.abs(denominator) <= EPSILON) {
    if (Math.abs(cross(qMinusP, r)) > EPSILON) return { kind: 'none' };
    const axis: 'x' | 'y' = Math.abs(r.x) >= Math.abs(r.y) ? 'x' : 'y';
    const a0 = a.start[axis]; const a1 = a.end[axis]; const b0 = b.start[axis]; const b1 = b.end[axis];
    const low = Math.max(Math.min(a0, a1), Math.min(b0, b1));
    const high = Math.min(Math.max(a0, a1), Math.max(b0, b1));
    if (high < low - EPSILON) return { kind: 'none' };
    if (Math.abs(high - low) <= EPSILON) {
      const ratio = Math.abs(a1 - a0) <= EPSILON ? 0 : (low - a0) / (a1 - a0);
      return { kind: 'endpoint', point: { x: a.start.x + r.x * ratio, y: a.start.y + r.y * ratio } };
    }
    return { kind: 'collinear-overlap' };
  }
  const t = cross(qMinusP, s) / denominator;
  const u = cross(qMinusP, r) / denominator;
  if (!inUnit(t) || !inUnit(u)) return { kind: 'none' };
  const point = { x: a.start.x + t * r.x, y: a.start.y + t * r.y };
  if (strictlyInUnit(t) && strictlyInUnit(u)) return { kind: 'interior', point };
  if (strictlyInUnit(t) !== strictlyInUnit(u)) return { kind: 't-junction', point };
  return { kind: 'endpoint', point };
}

/**
 * Whether two lines touch at all, including merely meeting end to end. Deliberately generous: on a
 * drawing, two leader lines touching reads as badly as two crossing.
 */
export function inclusiveIntersection(a: Segment, b: Segment): boolean {
  return classifyIntersection(a, b).kind !== 'none';
}

export function polylineSegments(points: readonly Vec2[]): readonly Segment[] {
  const result: Segment[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]; const end = points[index];
    if (start !== undefined && end !== undefined && finitePoint(start) && finitePoint(end)) result.push({ start, end });
  }
  return result;
}

/**
 * The angles a leader line is meant to be drawn at, in degrees from horizontal.
 *
 * Measured as a slope rather than a direction, so a line at 15° and one at 195° are the same angle.
 *
 * This is the standard's full set, not the three angles most drawings happen to use. A leader at
 * 15° is perfectly correct, and flagging it would be a false alarm on conforming work — which is
 * exactly how an engineer learns to ignore the tool.
 */
export const PREFERRED_LEADER_ANGLES = [15,30,45,60,75,90] as const;
export type LintRuleId='leader-crossing'|'non-preferred-angle'|'minimum-text-height'|'leader-through-label';
/**
 * One stroke as actually drawn on screen.
 *
 * A leader line with a gap in it — where it passes under another label — arrives here as several
 * pieces sharing one leg id. That is on purpose: a line with a gap genuinely does not run through
 * the label it is gapped under, and grading the unbroken line would report a fault nobody can see.
 *
 * `continuation` marks the pieces after the first, so rules about the leader as a whole — its angle,
 * its text size — are only counted once. Otherwise a line would look worse the more gaps it had.
 */
export interface LintPolyline{readonly annotationId:string;readonly legId?:string;readonly points:readonly Vec2[];readonly label:Rect;readonly fontSize:number;readonly capHeightRatio:number;readonly annotationScale:number;readonly continuation?:boolean}
export interface LintFinding{readonly ruleId:LintRuleId;readonly severity:'warning'|'error';readonly annotationIds:readonly string[];readonly legIds:readonly string[];readonly message:string;readonly point:Vec2}
export interface LintOptions{readonly pixelsPerMillimetre:number;readonly minimumTextHeightMm:number;readonly angleToleranceDegrees:number;readonly skip?:ReadonlySet<LintRuleId>;readonly minimumSegmentLength?:number}

/**
 * How close two leader lines have to be before they count as deliberately joined rather than
 * accidentally crossing.
 *
 * When several legs of one note merge into a shared shoulder they are meant to meet, but their
 * endpoints land a fraction of a pixel apart rather than exactly together. Demanding an exact match
 * would report every legitimate merge as a crossing error.
 *
 * Half a pixel is narrower than the line that draws it, so nothing a person could actually see gets
 * excused by this.
 */
export const MERGE_EPS = 0.5;

function sharedEndpoint(a:Segment,b:Segment):boolean{return [a.start,a.end].some(left=>[b.start,b.end].some(right=>distance(left,right)<=MERGE_EPS));}
function firstSloped(points:readonly Vec2[],minimum:number):Segment|undefined{return polylineSegments(points).find(segment=>{const dx=Math.abs(segment.end.x-segment.start.x);const dy=Math.abs(segment.end.y-segment.start.y);return distance(segment.start,segment.end)>=minimum&&dx>1e-8&&dy>1e-8;});}
function pointInside(rect:Rect,point:Vec2):boolean{return point.x>rect.x&&point.x<rect.x+rect.width&&point.y>rect.y&&point.y<rect.y+rect.height;}
/**
 * Whether a line passes through the inside of a rectangle. Running along its edge does not count.
 *
 * Shared deliberately between the router that avoids labels and the rule that grades the result. If
 * the two used different definitions, the router would be optimising for something other than what
 * it is marked on.
 */
export function segmentThroughInterior(segment:Segment,rect:Rect):boolean{
  if(![segment.start,segment.end].every(finitePoint)||![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite))return false;
  if(pointInside(rect,segment.start)||pointInside(rect,segment.end))return true;
  // Tested against a very slightly shrunken rectangle, so a line running exactly along the border
  // stays outside it.
  const epsilon=1e-7;const left=rect.x+epsilon,right=rect.x+rect.width-epsilon,top=rect.y+epsilon,bottom=rect.y+rect.height-epsilon;
  if(left>=right||top>=bottom)return false;const dx=segment.end.x-segment.start.x,dy=segment.end.y-segment.start.y;let t0=0,t1=1;
  const tests:[number,number][]= [[-dx,segment.start.x-left],[dx,right-segment.start.x],[-dy,segment.start.y-top],[dy,bottom-segment.start.y]];
  for(const [p,q] of tests){if(Math.abs(p)<1e-12){if(q<0)return false;continue;}const r=q/p;if(p<0)t0=Math.max(t0,r);else t1=Math.min(t1,r);if(t0>t1)return false;}
  return t1>t0&&t1>0&&t0<1;
}

export function lintFrame(polylines:readonly LintPolyline[],options:LintOptions):readonly LintFinding[]{
  const findings:LintFinding[]=[];const skip=options.skip??new Set<LintRuleId>();
  if(!skip.has('leader-crossing'))for(let leftIndex=0;leftIndex<polylines.length;leftIndex+=1)for(let rightIndex=leftIndex+1;rightIndex<polylines.length;rightIndex+=1){const left=polylines[leftIndex],right=polylines[rightIndex];if(left===undefined||right===undefined||left.annotationId===right.annotationId)continue;outer:for(const a of polylineSegments(left.points))for(const b of polylineSegments(right.points)){const classified=classifyIntersection(a,b);if(!inclusiveIntersection(a,b)||classified.kind==='collinear-overlap'||sharedEndpoint(a,b))continue;findings.push({ruleId:'leader-crossing',severity:'error',annotationIds:[left.annotationId,right.annotationId],legIds:[left.legId,right.legId].filter((id):id is string=>id!==undefined),message:'Leader crossing violates ASME Y14.2 / ISO 128-22.',point:classified.point??a.start});break outer;}}
  for(const entry of polylines){
    if(!skip.has('non-preferred-angle')&&entry.continuation!==true){const segment=firstSloped(entry.points,options.minimumSegmentLength??2);if(segment!==undefined){const raw=Math.abs(Math.atan2(segment.end.y-segment.start.y,segment.end.x-segment.start.x)*180/Math.PI)%180;const angle=raw>90?180-raw:raw;const preferred=PREFERRED_LEADER_ANGLES.some(value=>Math.abs(value-angle)<=options.angleToleranceDegrees);if(!preferred)findings.push({ruleId:'non-preferred-angle',severity:'warning',annotationIds:[entry.annotationId],legIds:entry.legId?[entry.legId]:[],message:'Leader angle is not preferred by ISO 128-22.',point:segment.start});}}
    if(!skip.has('minimum-text-height')&&entry.continuation!==true&&Number.isFinite(options.pixelsPerMillimetre)&&options.pixelsPerMillimetre>0){const mm=(entry.fontSize*entry.capHeightRatio*entry.annotationScale)/options.pixelsPerMillimetre;if(Number.isFinite(mm)&&mm<options.minimumTextHeightMm)findings.push({ruleId:'minimum-text-height',severity:'warning',annotationIds:[entry.annotationId],legIds:entry.legId?[entry.legId]:[],message:'Text cap height is below the ISO 3098 minimum.',point:{x:entry.label.x,y:entry.label.y}});}
    if(!skip.has('leader-through-label'))for(const foreign of polylines){if(foreign.annotationId===entry.annotationId)continue;if(polylineSegments(entry.points).some(segment=>segmentThroughInterior(segment,foreign.label))){findings.push({ruleId:'leader-through-label',severity:'error',annotationIds:[entry.annotationId,foreign.annotationId],legIds:entry.legId?[entry.legId]:[],message:'Leader passes through a foreign annotation label.',point:{x:foreign.label.x+foreign.label.width/2,y:foreign.label.y+foreign.label.height/2}});break;}}
  }
  return findings;
}

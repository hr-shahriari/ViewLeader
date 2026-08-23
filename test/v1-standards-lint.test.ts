/** @vitest-environment jsdom */
import { describe,expect,it } from 'vitest';
import { PREFERRED_LEADER_ANGLES,lintFrame,type LintPolyline } from '../src/lint.js';
// Deliberately the package specifier, not a deep path: the point of the second describe block is
// that a host reaches the lint through the published surface and nothing else.
import {
  CAP_RATIO,
  MERGE_EPS,
  ViewLeader,
  lintFrame as publicLintFrame,
  type AnnotationDraft,
  type HostAdapterBundle,
  type LintPolyline as PublicLintPolyline,
} from 'viewleader';

const options={pixelsPerMillimetre:4,minimumTextHeightMm:2.5,angleToleranceDegrees:2};
function entry(annotationId:string,points:readonly {x:number;y:number}[],label={x:100,y:100,width:20,height:10},extra:Partial<LintPolyline>={}):LintPolyline{return{annotationId,points,label,fontSize:20,capHeightRatio:.7,annotationScale:1,...extra};}

describe('standards lint',()=>{
  it('exports preferred angles and reports inclusive T crossings but exempts shared endpoints, overlap and same annotation legs',()=>{
    expect(PREFERRED_LEADER_ANGLES).toEqual([15,30,45,60,75,90]);
    const t=lintFrame([entry('a',[{x:0,y:5},{x:10,y:5}]),entry('b',[{x:5,y:5},{x:5,y:10}])],options);expect(t.some(f=>f.ruleId==='leader-crossing')).toBe(true);
    const shared=lintFrame([entry('a',[{x:0,y:0},{x:5,y:5}]),entry('b',[{x:5,y:5},{x:10,y:0}])],options);expect(shared.some(f=>f.ruleId==='leader-crossing')).toBe(false);
    const overlap=lintFrame([entry('a',[{x:0,y:0},{x:10,y:0}]),entry('b',[{x:2,y:0},{x:8,y:0}])],options);expect(overlap.some(f=>f.ruleId==='leader-crossing')).toBe(false);
    const same=lintFrame([entry('a',[{x:0,y:5},{x:10,y:5}],undefined,{legId:'1'}),entry('a',[{x:5,y:0},{x:5,y:10}],undefined,{legId:'2'})],options);expect(same.some(f=>f.ruleId==='leader-crossing')).toBe(false);
  });

  it('flags off-angle first slope while exempting horizontal, vertical, preferred and short segments',()=>{
    const bad=lintFrame([entry('bad',[{x:0,y:0},{x:10,y:4}])],options);expect(bad.some(f=>f.ruleId==='non-preferred-angle')).toBe(true);
    for(const [id,points] of [['horizontal',[{x:0,y:0},{x:10,y:0}]],['vertical',[{x:0,y:0},{x:0,y:10}]],['preferred',[{x:0,y:0},{x:10,y:10}]],['short',[{x:0,y:0},{x:1,y:.4}]]] as const)expect(lintFrame([entry(id,points)],options).some(f=>f.ruleId==='non-preferred-angle')).toBe(false);
  });

  // The narrow [30,45,60] set flagged conforming work. 15° and 75° are ISO 128-22 preferred angles;
  // a lint that cries wolf on a correct leader is one an engineer stops reading.
  it('accepts every ISO 128-22 preferred angle, in both slope directions',()=>{
    for(const degrees of PREFERRED_LEADER_ANGLES){
      const radians=degrees*Math.PI/180;
      for(const sign of [1,-1]){
        const end={x:100*Math.cos(radians),y:sign*100*Math.sin(radians)};
        const findings=lintFrame([entry(`at-${degrees}-${sign}`,[{x:0,y:0},end])],options);
        expect(findings.filter(f=>f.ruleId==='non-preferred-angle')).toEqual([]);
      }
    }
    // Still catches the genuinely off-angle: 21.8° sits more than the tolerance from 15 and from 30.
    expect(lintFrame([entry('off',[{x:0,y:0},{x:100,y:40}])],options).some(f=>f.ruleId==='non-preferred-angle')).toBe(true);
  });

  it('converts cap height at annotation scale and reports complete finding identity',()=>{
    const low=lintFrame([entry('low',[{x:0,y:0},{x:10,y:0}],{x:2,y:3,width:4,height:5},{fontSize:8,capHeightRatio:.5,annotationScale:1,legId:'primary'})],options).find(f=>f.ruleId==='minimum-text-height');expect(low).toMatchObject({severity:'warning',annotationIds:['low'],legIds:['primary'],point:{x:2,y:3}});expect(low?.message).toContain('ISO 3098');
    expect(lintFrame([entry('scaled',[{x:0,y:0},{x:10,y:0}],undefined,{fontSize:8,capHeightRatio:.5,annotationScale:3})],options).some(f=>f.ruleId==='minimum-text-height')).toBe(false);
  });

  it('flags true foreign-label passage, exempts own label and border graze, honors skips and poison safety',()=>{
    const foreign=entry('label-owner',[{x:100,y:100},{x:110,y:100}],{x:4,y:4,width:4,height:4});const crossing=entry('line',[{x:0,y:6},{x:10,y:6}],{x:20,y:20,width:2,height:2});expect(lintFrame([foreign,crossing],options).some(f=>f.ruleId==='leader-through-label')).toBe(true);
    const graze=entry('graze',[{x:0,y:4},{x:10,y:4}],{x:30,y:30,width:2,height:2});expect(lintFrame([foreign,graze],options).some(f=>f.ruleId==='leader-through-label'&&f.annotationIds[0]==='graze')).toBe(false);
    const skipped=lintFrame([entry('bad',[{x:0,y:0},{x:10,y:4}])],{...options,skip:new Set(['non-preferred-angle' as const])});expect(skipped.some(f=>f.ruleId==='non-preferred-angle')).toBe(false);
    expect(()=>lintFrame([entry('nan',[{x:Number.NaN,y:0},{x:2,y:3}])],options)).not.toThrow();
  });
});

describe('a host lints its own frame through the published API', () => {
  function boundary(): HTMLDivElement {
    const element = document.createElement('div');
    document.body.appendChild(element);
    return element;
  }

  function adapters(): HostAdapterBundle {
    return {
      projection: {
        getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
        project: (point) => ({ point: { x: 400 + point.x * 10, y: 300 - point.y * 10 }, depth: point.z, visible: true }),
        getRevision: () => 1,
      },
    };
  }

  function note(id: string, x: number, y: number): AnnotationDraft {
    return { id, anchor: { kind: 'world-point', point: { x, y, z: 0 } }, content: { kind: 'plain-note', text: id } };
  }

  it('reaches lintFrame from diagnostics with no deep import and no internals', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    leader.annotations.create(note('a', -2, 1));
    leader.annotations.create(note('b', 2, -1));
    leader.update();

    // 4 px/mm is a plausible plot scale; every field but this one comes from core itself.
    const findings = leader.diagnostics.lintFrame({ pixelsPerMillimetre: 4 });
    expect(Array.isArray(findings)).toBe(true);
    for (const finding of findings) {
      expect(['leader-crossing', 'non-preferred-angle', 'minimum-text-height', 'leader-through-label']).toContain(finding.ruleId);
      // Findings name real annotations, so a host can highlight them without a lookup table.
      for (const id of finding.annotationIds) expect(['a', 'b']).toContain(id);
    }
    leader.dispose();
  });

  it('grades against the cap height as drawn — a bigger annotation scale clears ISO 3098', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    leader.annotations.create(note('a', -2, 1));
    leader.update();

    // At 0.4 px/mm the label is far under 2.5 mm of cap height; at 40 it is far over. If the runtime
    // double-counted annotation scale, or read an unscaled font size, one of these would be wrong.
    const tiny = leader.diagnostics.lintFrame({ pixelsPerMillimetre: 0.4 });
    const large = leader.diagnostics.lintFrame({ pixelsPerMillimetre: 40 });
    expect(tiny.some((f) => f.ruleId === 'minimum-text-height')).toBe(false);
    expect(large.some((f) => f.ruleId === 'minimum-text-height')).toBe(true);

    // The rule is skippable per call, without a second lint pass or a config round trip.
    expect(leader.diagnostics.lintFrame({ pixelsPerMillimetre: 40, skip: new Set(['minimum-text-height' as const]) })).toEqual([]);
    leader.dispose();
  });

  // Phase 1.4: a host must be able to assemble lint input by hand, with no deep imports. That needs
  // CAP_RATIO on the public surface — otherwise the only way to fill `capHeightRatio` is to copy
  // 0.72 out of core's internals and re-copy it every time core retunes.
  it('lets a host build LintPolyline from published exports alone', () => {
    expect(CAP_RATIO).toBeGreaterThan(0);
    const entry: PublicLintPolyline = {
      annotationId: 'hand-built',
      points: [{ x: 0, y: 0 }, { x: 100, y: 40 }],
      label: { x: 200, y: 200, width: 80, height: 20 },
      fontSize: 4,
      capHeightRatio: CAP_RATIO,
      annotationScale: 1,
    };
    const findings = publicLintFrame([entry], { pixelsPerMillimetre: 4, minimumTextHeightMm: 2.5, angleToleranceDegrees: 2 });
    // 4 px font at 0.72 cap over 4 px/mm is 0.72 mm — well under the ISO 3098 floor.
    expect(findings.some((finding) => finding.ruleId === 'minimum-text-height')).toBe(true);
  });

  // Phase 1.4: a multi-leg keynote merges its legs into one shoulder, and the two endpoints land a
  // fraction of a pixel apart because each is computed independently from float label geometry.
  // At the promoted 1e-8 tolerance every one of those merges was an `error`-severity crossing.
  it('exempts a fan-in merge within MERGE_EPS but still catches a real crossing', () => {
    expect(MERGE_EPS).toBe(0.5);
    const merge = { x: 200, y: 100 };
    const fanIn = publicLintFrame([
      { annotationId: 'leg-a', legId: 'a', points: [{ x: 0, y: 0 }, merge], label: { x: 300, y: 90, width: 80, height: 20 }, fontSize: 20, capHeightRatio: CAP_RATIO, annotationScale: 1 },
      // A quarter-pixel off the shared point: the same shoulder, reached by different arithmetic.
      { annotationId: 'leg-b', legId: 'b', points: [{ x: 0, y: 200 }, { x: merge.x + 0.25, y: merge.y - 0.2 }], label: { x: 300, y: 90, width: 80, height: 20 }, fontSize: 20, capHeightRatio: CAP_RATIO, annotationScale: 1 },
    ], { pixelsPerMillimetre: 4, minimumTextHeightMm: 2.5, angleToleranceDegrees: 2 });
    expect(fanIn.some((finding) => finding.ruleId === 'leader-crossing')).toBe(false);

    // A genuine X, endpoints nowhere near each other, is still an error.
    const crossing = publicLintFrame([
      { annotationId: 'x', points: [{ x: 0, y: 0 }, { x: 100, y: 100 }], label: { x: 300, y: 90, width: 80, height: 20 }, fontSize: 20, capHeightRatio: CAP_RATIO, annotationScale: 1 },
      { annotationId: 'y', points: [{ x: 0, y: 100 }, { x: 100, y: 0 }], label: { x: 400, y: 90, width: 80, height: 20 }, fontSize: 20, capHeightRatio: CAP_RATIO, annotationScale: 1 },
    ], { pixelsPerMillimetre: 4, minimumTextHeightMm: 2.5, angleToleranceDegrees: 2 });
    expect(crossing.some((finding) => finding.ruleId === 'leader-crossing')).toBe(true);
  });

  it('refuses to lint a disposed runtime rather than returning a stale frame', () => {
    const leader = new ViewLeader({ boundary: boundary(), adapters: adapters() });
    leader.annotations.create(note('a', -2, 1));
    leader.update();
    leader.dispose();
    expect(() => leader.diagnostics.lintFrame({ pixelsPerMillimetre: 4 })).toThrow();
  });
});

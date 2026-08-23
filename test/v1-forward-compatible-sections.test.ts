/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import {
  ViewLeader,
  validateInk,
  type HostAdapterBundle,
  type InkAnnotation,
} from '../src/index.js';
import { definitionFromJson, validateDefinition, type TypedDefinition } from '../src/definitions.js';
import { normalizeSavedViewDefinition } from '../src/saved-views/neutral-validation.js';
import type { SavedViewDefinition } from '../src/saved-views/neutral-types.js';

function leader(): ViewLeader {
  const boundary = document.createElement('div');
  document.body.appendChild(boundary);
  const adapters: HostAdapterBundle = {
    projection: {
      getViewport: () => ({ width: 800, height: 600, devicePixelRatio: 1 }),
      project: (point) => ({
        point: { x: 400 + point.x * 10, y: 300 - point.y * 10 },
        depth: point.z,
        visible: true,
      }),
    },
  };
  return new ViewLeader({ boundary, adapters });
}

const PLANE = {
  origin: { x: 0, y: 0, z: 0 },
  xAxis: { x: 1, y: 0, z: 0 },
  yAxis: { x: 0, y: 1, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
};

/** An ink stroke this version fully understands, with one unknown field on it and one on its plane. */
function futureInk(): Record<string, unknown> {
  return {
    kind: 'ink',
    id: 'ink-1',
    plane: { ...PLANE, units: 'mm' },
    points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 0 }],
    metadata: {},
    pressure: [0.2, 0.9, 0.4],
  };
}

function futureStyle(): Record<string, unknown> {
  return {
    kind: 'style',
    id: 'custom.style',
    name: 'Custom',
    lineColor: '#ff0000',
    lineWidth: 0.5,
    textColor: '#000000',
    fontFamily: 'Arial',
    fontSize: 12,
    terminatorId: 'builtin.terminator.arrow',
    glow: { radius: 3 },
  };
}

function futureTerminator(): Record<string, unknown> {
  return {
    kind: 'terminator',
    id: 'custom.terminator',
    name: 'Custom terminator',
    bounds: { x: 0, y: -0.5, width: 1, height: 1, depth: 0 },
    attachment: { point: { x: 0, y: 0 }, direction: { x: 1, y: 0 } },
    commands: [
      { command: 'move', to: { x: 0, y: 0 } },
      { command: 'line', to: { x: 1, y: 0.5 }, tension: 1 },
    ],
    fill: 'filled',
  };
}

function futureSavedView(): Record<string, unknown> {
  return {
    id: 'view-1',
    name: 'Level 1',
    viewerState: {
      camera: {
        projection: 'perspective',
        position: { x: 1, y: 2, z: 3 },
        direction: { x: 0, y: 0, z: -1 },
        up: { x: 0, y: 1, z: 0 },
        verticalFieldOfView: 45,
        near: 0.1,
        far: 500,
        rollDegrees: 12,
      },
      modelVisibility: [],
      elementVisibility: [],
      selection: [],
      colorOverrides: [],
      clippingPlanes: [
        { id: 'plane-a', normal: { x: 0, y: 0, z: 1 }, constant: 4, enabled: true, feather: 2 },
      ],
      ambientOcclusion: true,
    },
    annotationOverrides: {},
    thumbnail: 'data:image/png;base64,AAAA',
  };
}

function futureTour(): Record<string, unknown> {
  return {
    id: 'tour-1',
    name: 'Walkthrough',
    steps: [
      { viewId: 'view-1', transitionDurationMs: 100, dwellDurationMs: 200, easing: 'cubic' },
    ],
    loop: true,
  };
}

function annotation(id: string): Record<string, unknown> {
  return {
    id,
    anchors: [{
      id: 'leg-1',
      anchor: { kind: 'world-point', point: { x: 0, y: 0, z: 0 } },
      routing: { kind: 'automatic', mode: 'straight' },
    }],
    content: { kind: 'plain-note', text: id },
    placement: { kind: 'automatic' },
    metadata: {},
  };
}

/** What a colleague on a newer version sends: valid everywhere this version can see. */
function futureDocument(): Record<string, unknown> {
  return {
    schema: 'viewleader.document',
    version: 1,
    annotations: [annotation('alpha'), annotation('beta')],
    metadata: {},
    pluginEnvelopes: [],
    definitions: {
      styles: [futureStyle()],
      templates: [],
      terminators: [futureTerminator()],
      enclosures: [],
    },
    savedViews: [futureSavedView()],
    tours: [futureTour()],
    ink: [futureInk()],
    layers: [{ id: 'layer-1', name: 'Future layer' }],
  };
}

function sectionOnly(section: string): Record<string, unknown> {
  const empty: Record<string, unknown> = {
    schema: 'viewleader.document',
    version: 1,
    annotations: [],
    metadata: {},
    pluginEnvelopes: [],
    definitions: { styles: [], templates: [], terminators: [], enclosures: [] },
    savedViews: [],
    tours: [],
    ink: [],
  };
  switch (section) {
    case 'the document itself':
      return { ...empty, layers: [{ id: 'layer-1' }] };
    case 'an annotation':
      return { ...empty, annotations: [{ ...annotation('alpha'), layerId: 'layer-1' }] };
    case 'an ink stroke':
      return { ...empty, ink: [futureInk()] };
    case 'a style definition':
      return {
        ...empty,
        definitions: { styles: [futureStyle()], templates: [], terminators: [], enclosures: [] },
      };
    default:
      return { ...empty, savedViews: [futureSavedView()] };
  }
}

describe('a document from a newer version opens in every section', () => {
  // The probe table from the ticket. Every row must read "opens".
  for (const section of [
    'the document itself',
    'an annotation',
    'an ink stroke',
    'a style definition',
    'a saved view',
  ]) {
    it(`opens with one unknown field on ${section}`, () => {
      const vl = leader();
      expect(() => vl.documents.replace(sectionOnly(section) as never)).not.toThrow();
    });
  }

  it('round-trips a document with unknown fields in all five places byte-identically', () => {
    const vl = leader();
    const source = JSON.stringify(futureDocument());
    vl.documents.replace(source);
    const first = vl.documents.serialize();
    vl.documents.replace(first);
    expect(vl.documents.serialize()).toBe(first);
    expect(JSON.parse(first)).toMatchObject({
      ink: [{ pressure: [0.2, 0.9, 0.4], plane: { units: 'mm' } }],
      definitions: { styles: [{ glow: { radius: 3 } }] },
      savedViews: [{ thumbnail: 'data:image/png;base64,AAAA' }],
      tours: [{ loop: true }],
    });
  });

  it('keeps every unknown field when the user moves one label and saves', () => {
    const vl = leader();
    vl.documents.replace(futureDocument() as never);
    const before = JSON.parse(vl.documents.serialize()) as Record<string, unknown>;
    vl.annotations.move('alpha', { x: 40, y: 40 });
    const after = JSON.parse(vl.documents.serialize()) as Record<string, unknown>;
    for (const section of ['ink', 'definitions', 'savedViews', 'tours'] as const) {
      expect(JSON.stringify(after[section])).toBe(JSON.stringify(before[section]));
    }
  });
});

describe('editing the section itself does not drop what a newer version wrote to it', () => {
  it('keeps a saved view\'s unknown fields across a views edit', () => {
    const vl = leader();
    vl.documents.replace(futureDocument() as never);
    vl.views.removeTour('tour-1');
    const saved = JSON.parse(vl.documents.serialize()) as { savedViews: readonly unknown[] };
    expect(saved.savedViews[0]).toMatchObject({
      thumbnail: 'data:image/png;base64,AAAA',
      viewerState: {
        ambientOcclusion: true,
        camera: { rollDegrees: 12 },
        clippingPlanes: [{ feather: 2 }],
      },
    });
  });

  it('keeps other definitions\' unknown fields across a definitions edit', () => {
    const vl = leader();
    vl.documents.replace(futureDocument() as never);
    vl.definitions.create({
      kind: 'style',
      id: 'custom.second',
      name: 'Second',
      lineColor: '#00ff00',
      lineWidth: 0.5,
      textColor: '#000000',
      fontFamily: 'Arial',
      fontSize: 12,
      terminatorId: 'builtin.terminator.arrow',
    });
    const saved = JSON.parse(vl.documents.serialize()) as {
      definitions: { styles: readonly Record<string, unknown>[] };
    };
    const carried = saved.definitions.styles.find((style) => style.id === 'custom.style');
    expect(carried).toMatchObject({ glow: { radius: 3 } });
  });

  it('keeps an ink stroke\'s unknown fields across an ink edit', () => {
    const vl = leader();
    vl.documents.replace(futureDocument() as never);
    vl.authoring.markup.updateInk('ink-1', (current) => ({
      ...current,
      points: [{ x: 0, y: 0 }, { x: 3, y: 3 }],
    }));
    const saved = JSON.parse(vl.documents.serialize()) as { ink: readonly unknown[] };
    expect(saved.ink[0]).toMatchObject({
      pressure: [0.2, 0.9, 0.4],
      plane: { units: 'mm' },
      points: [{ x: 0, y: 0 }, { x: 3, y: 3 }],
    });
  });
});

describe('residue is never attached to the wrong record', () => {
  it('keeps nothing rather than something wrong when the normalizer re-sorts an array', () => {
    const vl = leader();
    const view = futureSavedView() as { viewerState: Record<string, unknown> };
    // Arrives out of id order, so the normalizer's sort moves the entry carrying the unknown field.
    view.viewerState.modelVisibility = [
      { modelId: 'model-b', visible: true, tint: '#ff0000' },
      { modelId: 'model-a', visible: false },
    ];
    vl.documents.replace({ ...sectionOnly('a saved view'), savedViews: [view] } as never);
    const saved = JSON.parse(vl.documents.serialize()) as {
      savedViews: readonly { viewerState: { modelVisibility: readonly Record<string, unknown>[] } }[];
    };
    const entries = saved.savedViews[0]!.viewerState.modelVisibility;
    expect(entries.map(({ modelId }) => modelId)).toEqual(['model-a', 'model-b']);
    expect(entries.some((entry) => 'tint' in entry)).toBe(false);
    // The rest of the view's residue is unaffected by one array opting out.
    expect(saved.savedViews[0]).toMatchObject({ thumbnail: 'data:image/png;base64,AAAA' });
  });
});

describe('unrecognised means future, invalid means broken', () => {
  it('refuses an ink stroke with a non-finite coordinate while accepting an unknown field', () => {
    const vl = leader();
    expect(() => vl.documents.replace(sectionOnly('an ink stroke') as never)).not.toThrow();
    const broken = {
      ...sectionOnly('an ink stroke'),
      ink: [{ ...futureInk(), points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 1 }] }],
    };
    expect(() => vl.documents.replace(broken as never)).toThrow();
  });

  it('refuses a style definition with an invalid colour while accepting an unknown field', () => {
    const vl = leader();
    expect(() => vl.documents.replace(sectionOnly('a style definition') as never)).not.toThrow();
    const broken = {
      ...sectionOnly('a style definition'),
      definitions: {
        styles: [{ ...futureStyle(), lineColor: 'not-a-colour' }],
        templates: [],
        terminators: [],
        enclosures: [],
      },
    };
    expect(() => vl.documents.replace(broken as never)).toThrow();
  });

  it('refuses a saved view with a zero-length camera direction while accepting an unknown field', () => {
    const vl = leader();
    expect(() => vl.documents.replace(sectionOnly('a saved view') as never)).not.toThrow();
    const view = futureSavedView() as { viewerState: { camera: Record<string, unknown> } };
    view.viewerState.camera.direction = { x: 0, y: 0, z: 0 };
    expect(() => vl.documents.replace({ ...sectionOnly('a saved view'), savedViews: [view] } as never))
      .toThrow();
  });
});

describe('strict to author is unchanged', () => {
  it('refuses an unknown field on an ink stroke the author validates', () => {
    expect(() => validateInk(futureInk() as unknown as InkAnnotation))
      .toThrow(/contains unsupported fields/u);
  });

  it('refuses an unknown field on a style the author registers, but not on one it loads', () => {
    const vl = leader();
    expect(() => vl.definitions.create(futureStyle() as unknown as TypedDefinition))
      .toThrow(/contains unsupported fields/u);
    expect(() => validateDefinition(futureStyle() as unknown as TypedDefinition))
      .toThrow(/contains unsupported fields/u);
    // The same value, down the load path instead.
    expect(() => definitionFromJson(futureStyle() as never)).not.toThrow();
  });

  it('refuses an unknown field on a saved view the author inserts, but not on one it loads', () => {
    expect(() => normalizeSavedViewDefinition(futureSavedView() as unknown as SavedViewDefinition))
      .toThrow(/contains unsupported fields/u);
    const unrecognized: string[] = [];
    expect(() => normalizeSavedViewDefinition(
      futureSavedView() as unknown as SavedViewDefinition,
      unrecognized,
    )).not.toThrow();
    expect(unrecognized.sort()).toEqual([
      'camera.rollDegrees',
      'clipping plane.feather',
      'saved view.thumbnail',
      'viewer state.ambientOcclusion',
    ]);
  });
});

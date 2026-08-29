import { FONT_STACK } from '../theme.js';

export interface SheetTitleBlock {
  readonly drawingNumber: string;
  readonly scale: string;
  readonly date: string;
}

export interface VectorSheetOptions {
  readonly width?: number;
  readonly height?: number;
  readonly paper?: string;
  /**
   * A picture of the model to draw the annotations on top of — normally the viewer's own canvas,
   * `canvas.toDataURL('image/png')`.
   *
   * It must be a `data:` URI, not an `http(s):` one: the sheet is a standalone file, and a remote
   * reference would be a broken link everywhere it is opened (and would taint the canvas on the
   * raster path). It is placed in the annotations' own coordinate space, so it registers with them
   * whatever sheet size you asked for.
   */
  readonly underlayDataUrl?: string;
  /**
   * How the drawing is fitted into the sheet when the two have different proportions. SVG's own
   * `preserveAspectRatio` vocabulary, passed straight through to the frame the content sits in.
   *
   * Defaults to `'xMidYMid meet'` — the whole drawing, centred, nothing cropped. `'xMidYMid slice'`
   * fills the sheet and crops instead; `'none'` stretches.
   */
  readonly preserveAspectRatio?: string;
  readonly titleBlock?: SheetTitleBlock;
}

export interface VectorSheetResult {
  readonly svg: string;
  readonly width: number;
  readonly height: number;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

function finitePositive(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function numericAttribute(element: Element, name: string): number | undefined {
  const value = Number(element.getAttribute(name));
  return finitePositive(value) ? value : undefined;
}

function resolveSize(source: SVGSVGElement, options: VectorSheetOptions): {
  readonly width: number;
  readonly height: number;
} {
  if (finitePositive(options.width) && finitePositive(options.height)) {
    return { width: options.width, height: options.height };
  }
  const viewBox = source.viewBox?.baseVal;
  if (viewBox && finitePositive(viewBox.width) && finitePositive(viewBox.height)) {
    return { width: options.width ?? viewBox.width, height: options.height ?? viewBox.height };
  }
  const rect = source.getBoundingClientRect?.();
  const rectWidth = rect && finitePositive(rect.width) ? rect.width : undefined;
  const rectHeight = rect && finitePositive(rect.height) ? rect.height : undefined;
  return {
    width: options.width ?? rectWidth ?? numericAttribute(source, 'width') ?? 1_000,
    height: options.height ?? rectHeight ?? numericAttribute(source, 'height') ?? 700,
  };
}

function createSvg(document: Document, name: string): SVGElement {
  return document.createElementNS(SVG_NS, name);
}

function removeConstructionGeometry(root: SVGSVGElement): void {
  // The contract: chrome is marked `data-non-printing` where it is created, in `src/render.ts`. Do
  // not grow this list — a selector here and a renderer there is exactly how it drifted apart
  // before. The rest are host-content defence: nothing the renderer emits writes them, but the
  // overlay is the host's element and the host may have put its own layers in it.
  const selectors = [
    '[data-non-printing]',
    '[data-presentation-layer]',
    '[hidden]',
    '[aria-hidden="true"]',
  ];
  for (const element of root.querySelectorAll(selectors.join(','))) element.remove();
  for (const element of root.querySelectorAll<SVGElement>('[style*="display: none"]')) element.remove();
  for (const selected of root.querySelectorAll<SVGElement>('[data-selected], [data-selection], .viewleader-selected')) {
    selected.removeAttribute('data-selected');
    selected.removeAttribute('data-selection');
    selected.classList.remove('viewleader-selected', 'selected', 'is-selected');
  }
  for (const animated of root.querySelectorAll<SVGElement>('*')) {
    animated.removeAttribute('data-dash-animation');
    animated.removeAttribute('data-dash-phase');
    animated.style.removeProperty('animation');
    animated.style.removeProperty('transition');
  }
  for (const faded of root.querySelectorAll<SVGElement>('[data-occlusion-faded]')) {
    faded.setAttribute('opacity', '1');
    faded.style.opacity = '1';
    faded.removeAttribute('data-occlusion-faded');
  }
}

// Text this file draws itself has to name a family. Nothing sets one for it: the sheet is a
// standalone document, and an SVG `<text>` with no `font-family` renders in the viewer's serif
// default — Times, in every browser and in the raster export.
function replaceEmbeddedHtml(root: SVGSVGElement): void {
  for (const embedded of root.querySelectorAll<SVGElement>('[data-embedded-html]')) {
    const text = createSvg(root.ownerDocument, 'text');
    text.textContent = '[Embedded HTML omitted from sheet]';
    text.setAttribute('x', embedded.getAttribute('x') ?? '0');
    text.setAttribute('y', embedded.getAttribute('y') ?? '0');
    text.setAttribute('font-family', FONT_STACK);
    text.setAttribute('data-export-placeholder', 'embedded-html');
    embedded.replaceWith(text);
  }
}

function prepareMarkdownImages(root: SVGSVGElement): void {
  for (const node of root.querySelectorAll<SVGElement>('[data-markdown-image]')) {
    const exportSource = node.getAttribute('data-export-source');
    const exportSafe = node.getAttribute('data-export-safe') === 'true';
    if (exportSafe && exportSource) {
      node.setAttribute('href', exportSource);
      node.setAttributeNS(XLINK_NS, 'xlink:href', exportSource);
      node.removeAttribute('data-export-safe');
      node.removeAttribute('data-export-source');
      continue;
    }
    const group = createSvg(root.ownerDocument, 'g');
    group.setAttribute('data-export-placeholder', 'markdown-image');
    const rect = createSvg(root.ownerDocument, 'rect');
    for (const attribute of ['x', 'y', 'width', 'height']) {
      rect.setAttribute(attribute, node.getAttribute(attribute) ?? '0');
    }
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', '#b42318');
    rect.setAttribute('stroke-dasharray', '6 4');
    const warning = createSvg(root.ownerDocument, 'text');
    warning.textContent = `Image unavailable for export${node.getAttribute('data-alt') ? `: ${node.getAttribute('data-alt')}` : ''}`;
    warning.setAttribute('x', node.getAttribute('x') ?? '0');
    warning.setAttribute('y', String(Number(node.getAttribute('y') ?? 0) + 16));
    warning.setAttribute('font-family', FONT_STACK);
    group.append(rect, warning);
    node.replaceWith(group);
  }
}

/**
 * Paper is sheet furniture, so it goes on the root at sheet size. The underlay is a picture of the
 * same scene the annotations were laid out over, so it goes inside `frame` at content size — the
 * one place where it registers with them under any fit.
 */
function prependComposition(
  root: SVGSVGElement,
  frame: SVGSVGElement,
  sheet: { readonly width: number; readonly height: number },
  content: { readonly width: number; readonly height: number },
  options: VectorSheetOptions,
): void {
  if (options.underlayDataUrl) {
    const image = createSvg(frame.ownerDocument, 'image');
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', String(content.width));
    image.setAttribute('height', String(content.height));
    // The image box is now the frame's own viewport box, so `meet`, `slice` and `none` all agree on
    // the result. `none` is the one that stays registered when device-pixel rounding makes the two
    // ratios differ in the last decimal.
    image.setAttribute('preserveAspectRatio', 'none');
    // Both spellings: librsvg and Illustrator before CC 2018 read only the xlink one, and
    // `prepareMarkdownImages` already sets both for the same reason.
    image.setAttribute('href', options.underlayDataUrl);
    image.setAttributeNS(XLINK_NS, 'xlink:href', options.underlayDataUrl);
    frame.insertBefore(image, frame.firstChild);
  }
  if (options.paper) {
    const paper = createSvg(root.ownerDocument, 'rect');
    paper.setAttribute('x', '0');
    paper.setAttribute('y', '0');
    paper.setAttribute('width', String(sheet.width));
    paper.setAttribute('height', String(sheet.height));
    paper.setAttribute('fill', options.paper);
    root.insertBefore(paper, root.firstChild);
  }
}

function appendTitleBlock(
  root: SVGSVGElement,
  width: number,
  height: number,
  title: SheetTitleBlock | undefined,
): void {
  if (!title) return;
  const blockWidth = Math.min(280, width * 0.36);
  const blockHeight = Math.min(90, height * 0.18);
  const x = width - blockWidth;
  const y = height - blockHeight;
  const group = createSvg(root.ownerDocument, 'g');
  group.setAttribute('data-title-block', '');
  const rect = createSvg(root.ownerDocument, 'rect');
  rect.setAttribute('x', String(x));
  rect.setAttribute('y', String(y));
  rect.setAttribute('width', String(blockWidth));
  rect.setAttribute('height', String(blockHeight));
  rect.setAttribute('fill', 'white');
  rect.setAttribute('stroke', 'black');
  group.append(rect);
  const rows = [
    `DRAWING ${title.drawingNumber}`,
    `SCALE ${title.scale}`,
    `DATE ${title.date}`,
  ];
  rows.forEach((row, index) => {
    const text = createSvg(root.ownerDocument, 'text');
    text.textContent = row;
    text.setAttribute('x', String(x + 10));
    text.setAttribute('y', String(y + 22 + index * 22));
    text.setAttribute('font-family', FONT_STACK);
    text.setAttribute('font-size', '12');
    group.append(text);
  });
  root.append(group);
}

/**
 * Renders the overlay's current frame as a standalone SVG sheet.
 *
 * Two coordinate spaces, not one. The root is the *sheet*: paper and title block are laid out in
 * it, at whatever `width`/`height` you asked for. The annotations were laid out in the *overlay's*
 * pixels and are worth nothing re-labelled — so they are moved into a nested `<svg>` frame that
 * carries their own viewBox and is fitted to the sheet by `preserveAspectRatio`.
 */
export function exportVectorSheet(
  overlay: SVGSVGElement | undefined,
  options: VectorSheetOptions = {},
): VectorSheetResult {
  if (!overlay || overlay.childElementCount === 0) {
    throw new Error('Cannot export a sheet before ViewLeader has rendered a frame');
  }
  const { width, height } = resolveSize(overlay, options);
  // The overlay's own size, ignoring the requested sheet size — the space the children are in.
  const content = resolveSize(overlay, {});
  const clone = overlay.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  // Wholesale, not `removeAttribute`: this wipes the live root's `position:absolute; inset:0;
  // width:100%; height:100%` (src/render.ts), and `width:100%` would beat the width attribute above.
  clone.setAttribute('style', 'display:block');
  clone.removeAttribute('data-viewleader-overlay');
  removeConstructionGeometry(clone);
  replaceEmbeddedHtml(clone);
  prepareMarkdownImages(clone);
  // ponytail: `overflow:visible` lets a label that overhangs the drawing survive into the sheet.
  // Browsers honour it on a nested viewport; librsvg and resvg are spotty, and the raster path
  // clips at the sheet edge regardless. Clip deliberately with `preserveAspectRatio: 'xMidYMid
  // slice'` if a hard crop is what you want.
  const frame = createSvg(clone.ownerDocument, 'svg') as SVGSVGElement;
  frame.setAttribute('x', '0');
  frame.setAttribute('y', '0');
  frame.setAttribute('width', String(width));
  frame.setAttribute('height', String(height));
  frame.setAttribute('viewBox', `0 0 ${content.width} ${content.height}`);
  frame.setAttribute('preserveAspectRatio', options.preserveAspectRatio ?? 'xMidYMid meet');
  frame.setAttribute('style', 'overflow:visible');
  frame.append(...clone.childNodes);
  clone.append(frame);
  prependComposition(clone, frame, { width, height }, content, options);
  appendTitleBlock(clone, width, height, options.titleBlock);
  const Serializer = clone.ownerDocument.defaultView?.XMLSerializer ?? globalThis.XMLSerializer;
  if (Serializer) return { svg: new Serializer().serializeToString(clone), width, height };
  // Only on the fallback path. `XMLSerializer` writes the declarations itself, from the elements'
  // real namespaces — an `xmlns` set by hand is an ordinary attribute to it, so it lands a second
  // time and the file is a duplicate-attribute XML parse error. HTML serialization writes none of
  // them, so there they have to be spelled out.
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('xmlns:xlink', XLINK_NS);
  return { svg: clone.outerHTML, width, height };
}

export interface RasterSheetResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

/**
 * Rasterizes a sheet from {@link exportVectorSheet} to a PNG blob. Browser only — it needs a real
 * `<canvas>`, and throws directing you back to vector export where there is none.
 *
 * **This does not taint the canvas**, so `toBlob` succeeds even with an underlay. The sheet is
 * loaded from a same-origin `blob:` URL, and a `data:` URI *inside* an SVG is not an external
 * fetch; what would taint it is an `http(s):` underlay, which is why `underlayDataUrl` takes a
 * `data:` URI.
 *
 * `scale` multiplies both dimensions — pass `devicePixelRatio` for a screen-sharp image, or 300/96
 * for something near print resolution.
 */
export async function rasterizeVectorSheet(
  sheet: VectorSheetResult,
  scale = 1,
): Promise<RasterSheetResult> {
  const document = globalThis.document;
  const ImageConstructor = globalThis.Image;
  if (!document || !ImageConstructor || !globalThis.URL?.createObjectURL) {
    throw new Error('Raster sheet export requires browser canvas support; use vector sheet export instead');
  }
  const safeScale = finitePositive(scale) ? scale : 1;
  const width = Math.max(1, Math.round(sheet.width * safeScale));
  const height = Math.max(1, Math.round(sheet.height * safeScale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context || typeof canvas.toBlob !== 'function') {
    throw new Error('Raster sheet export requires browser canvas support; use vector sheet export instead');
  }
  const sourceBlob = new Blob([sheet.svg], { type: 'image/svg+xml' });
  const url = globalThis.URL.createObjectURL(sourceBlob);
  try {
    const image = new ImageConstructor();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Vector sheet could not be decoded for raster export'));
      image.src = url;
    });
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Canvas raster export failed')), 'image/png');
    });
    return { blob, width, height };
  } finally {
    globalThis.URL.revokeObjectURL(url);
    canvas.width = 0;
    canvas.height = 0;
  }
}

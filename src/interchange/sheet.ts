export interface SheetTitleBlock {
  readonly drawingNumber: string;
  readonly scale: string;
  readonly date: string;
}

export interface VectorSheetOptions {
  readonly width?: number;
  readonly height?: number;
  readonly paper?: string;
  readonly underlayDataUrl?: string;
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
  const selectors = [
    '[data-non-printing]',
    '.viewleader-route-hit',
    '.viewleader-guide',
    '.viewleader-route-grip',
    '.viewleader-editor',
    '.viewleader-debug',
    '.viewleader-transition-layer',
    '[data-presentation-layer]',
    '[hidden]',
    '[aria-hidden="true"]',
  ];
  for (const element of root.querySelectorAll(selectors.join(','))) element.remove();
  for (const element of root.querySelectorAll<SVGElement>('[style*="display: none"]')) element.remove();
  for (const selected of root.querySelectorAll<SVGElement>('[data-selected], [data-selection]')) {
    selected.removeAttribute('data-selected');
    selected.removeAttribute('data-selection');
    selected.classList.remove('selected', 'is-selected');
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

function replaceEmbeddedHtml(root: SVGSVGElement): void {
  for (const embedded of root.querySelectorAll<SVGElement>('[data-embedded-html]')) {
    const text = createSvg(root.ownerDocument, 'text');
    text.textContent = '[Embedded HTML omitted from sheet]';
    text.setAttribute('x', embedded.getAttribute('x') ?? '0');
    text.setAttribute('y', embedded.getAttribute('y') ?? '0');
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
    group.append(rect, warning);
    node.replaceWith(group);
  }
}

function prependComposition(
  root: SVGSVGElement,
  width: number,
  height: number,
  options: VectorSheetOptions,
): void {
  const first = root.firstChild;
  if (options.underlayDataUrl) {
    const image = createSvg(root.ownerDocument, 'image');
    image.setAttribute('x', '0');
    image.setAttribute('y', '0');
    image.setAttribute('width', String(width));
    image.setAttribute('height', String(height));
    image.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    image.setAttribute('href', options.underlayDataUrl);
    root.insertBefore(image, first);
  }
  if (options.paper) {
    const paper = createSvg(root.ownerDocument, 'rect');
    paper.setAttribute('x', '0');
    paper.setAttribute('y', '0');
    paper.setAttribute('width', String(width));
    paper.setAttribute('height', String(height));
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
    text.setAttribute('font-size', '12');
    group.append(text);
  });
  root.append(group);
}

export function exportVectorSheet(
  overlay: SVGSVGElement | undefined,
  options: VectorSheetOptions = {},
): VectorSheetResult {
  if (!overlay || overlay.childElementCount === 0) {
    throw new Error('Cannot export a sheet before ViewLeader has rendered a frame');
  }
  const { width, height } = resolveSize(overlay, options);
  const clone = overlay.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('xmlns:xlink', XLINK_NS);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  clone.setAttribute('style', 'display:block;overflow:hidden');
  clone.removeAttribute('data-viewleader-overlay');
  removeConstructionGeometry(clone);
  replaceEmbeddedHtml(clone);
  prepareMarkdownImages(clone);
  prependComposition(clone, width, height, options);
  appendTitleBlock(clone, width, height, options.titleBlock);
  const Serializer = clone.ownerDocument.defaultView?.XMLSerializer ?? globalThis.XMLSerializer;
  const svg = Serializer ? new Serializer().serializeToString(clone) : clone.outerHTML;
  return { svg, width, height };
}

export interface RasterSheetResult {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

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

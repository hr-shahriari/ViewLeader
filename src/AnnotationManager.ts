import * as THREE from 'three'
import type { Annotation, MtextContent, PointAnchor } from './types'
import { Projection } from './core/Projection';

const SVG_NS = 'http://www.w3.org/2000/svg';


export interface AnnotationManagerConfig
{
    scene: THREE.Scene;
    camera: THREE.Camera;
    renderer: THREE.WebGLRenderer
}

export class AnnotationManager
{
    private svg: SVGSVGElement;
    private annotations= new Map<string, Annotation>()
    private projector: Projection
    private requestId = 0

    constructor (cfg: AnnotationManagerConfig)
    {
        this.svg = document.createElementNS(SVG_NS, 'svg')
        this.svg.style.cssText= 'position:absolute; inset:0; width:100%; height:100%; pointer-events:none;'
        cfg.renderer.domElement.parentElement!.appendChild(this.svg)
        this.projector = new Projection(cfg.camera, cfg.renderer)
        this.start()
    }

    addAnnotation(data: {anchor: PointAnchor, content: MtextContent, styleId?: string}): Annotation
    {
        const ann: Annotation={
            id: crypto.randomUUID(),
            anchor: data.anchor,
            content: data.content,
            styleId: data.styleId ?? 'standard',
            visible: true
        }
        this.annotations.set(ann.id, ann)
        return ann
    }

    private start(): void
    {
        if (this.requestId) return;
        const frame = () => {
            this.render();
            this.requestId = requestAnimationFrame(frame)
        }
        frame();
    }

    private render(): void
    {
    this.svg.innerHTML = '';
    for (const ann of this.annotations.values()) {
        if (!ann.visible) continue;
        const anchor = this.projector.toScreen(ann.anchor.position)
        if (!anchor) continue;
        const offset = ann.offset ?? {x:40, y:-30}
        const label = {x: anchor.x + offset.x, y: anchor.y + offset.y}

        const group = document.createElementNS(SVG_NS, 'g')
        group.dataset.annotationId = ann.id

        const line = document.createElementNS(SVG_NS, 'line')
        line.setAttribute('x1', String(anchor.x))
        line.setAttribute('y1', String(anchor.y))
        line.setAttribute('x2', String(label.x))
        line.setAttribute('y2', String(label.y))
        line.setAttribute('stroke', '#d0d3dc')
        line.setAttribute('stroke-width','1.2')
        group.appendChild(line)

        const text = document.createElementNS(SVG_NS, 'text')
        text.setAttribute('x', String(label.x));
        text.setAttribute('y', String(label.y));
        text.setAttribute('fill', '#e8eaf0');
        text.setAttribute('font-family', 'Inter, sans-serif');
        text.setAttribute('font-size', '12');
        text.textContent = ann.content.text;

        group.appendChild(text)

        this.svg.appendChild(group)    

    }
}

}
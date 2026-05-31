import * as THREE from 'three'
import type { Annotation, MtextContent, PointAnchor } from './types'

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
    private annotations= new Map<string, Annotation>();

    constructor (cfg: AnnotationManagerConfig)
    {
        this.svg = document.createElementNS(SVG_NS, 'svg')
        this.svg.style.cssText= 'position:absolute; inset:0; width:100%; height:100%; pointer-events:none;'
        cfg.renderer.domElement.parentElement!.appendChild(this.svg)
        this.render()
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
        this.render()
        return ann
    }

    private render(): void
    {
        this.svg.innerHTML = ''
        for (const ann of this.annotations.values())
        {
            const text = document.createElementNS(SVG_NS, 'text')
            text.setAttribute('x','400')
            text.setAttribute('y','300')
            text.setAttribute('fill', '#FAF8F4')
                  text.setAttribute('font-size', '14');
      text.textContent = ann.content.text;
      this.svg.appendChild(text);
        }
    }

}
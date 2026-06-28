import type { Annotation, Vector2d } from "../types";

interface DragState {
    id: string
    startMouse: Vector2d
    startOffset: Vector2d
}

type AnnotationLookup = (id: string) => Annotation | undefined
type AnchorScreenLookup = (id: string) => Vector2d | null
type SetOffset = (id: string, offset: Vector2d) => void


export class DragHandler
{
    private state: DragState | null = null

        private onMove = (e: PointerEvent): void =>
    {
        if (!this.state) return
        const dx = e.clientX - this.state.startMouse.x
        const dy = e.clientY - this.state.startMouse.y
        this.setOffset(this.state.id,
            {
                x: this.state.startOffset.x + dx,
                y: this.state.startOffset.y + dy
            }
        )
    }

    constructor
    (
        private getAnnotation: AnnotationLookup,
        private getAnchorScreen: AnchorScreenLookup,
        private setOffset: SetOffset  
    ){}

    attach(g: SVGGElement, id: string): void
    {
        g.addEventListener('pointerdown', (e) => this.onDown(e, id , g))
    }

    private onDown(e: PointerEvent, id: string, g: SVGGElement): void
    {
        const ann = this.getAnnotation(id)
        if (!ann || ann.locked) return
        if (!this.getAnchorScreen(id)) return
        e.stopPropagation()

        this.state = {
            id,
            startMouse: {x: e.clientX, y: e.clientY},
            startOffset: ann.offset ?? {x:30, y: -30}
        }

        g.setPointerCapture(e.pointerId)
        g.addEventListener('pointermove', this.onMove)
        g.addEventListener('pointerup',()=> this.onUp(g, e.pointerId), {once:true})
    }



    private onUp(g:SVGGElement, pointerId: number): void
    {
        g.releasePointerCapture(pointerId)
        g.removeEventListener('pointermove',this.onMove)
        this.state = null
    }


}
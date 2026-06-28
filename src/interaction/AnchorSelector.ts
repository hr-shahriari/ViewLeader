import * as THREE from 'three'
import type {Vector3d} from '../types'


export class AnchorSelector
{
    private raycaster = new THREE.Raycaster()
    private mouse = new THREE.Vector2()

    constructor(
        private camera: THREE.Camera,
        private canvas: HTMLCanvasElement,
        private bObjects : THREE.Object3D[]
    ){}
    setCamera(c: THREE.Camera): void
    {
        this.camera = c
    }

    select(event: {cx:number, cy:number}): Vector3d | null
    {
        const rect = this.canvas.getBoundingClientRect()
        this.mouse.x = ((event.cx - rect.left) / rect.width) * 2 - 1
        this.mouse.y = -((event.cy - rect.top) / rect.height) * 2 + 1
        this.raycaster.setFromCamera(this.mouse, this.camera)
        const hits = this.raycaster.intersectObjects(this.bObjects, true)
        if (!hits.length) return null
        const p = hits[0].point
        return {x: p.x, y: p.y, z:p.z}
    }
}
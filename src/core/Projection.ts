import * as THREE from 'three'
import type { Vector3d, Vector2d } from '../types'

export class Projection
{
    private pt = new THREE.Vector3();

    constructor(public camera: THREE.Camera, public renderer: THREE.WebGLRenderer) 
    {
    }

    setCamera(camera: THREE.Camera) : void
    {
        this.camera = camera
    }

    toScreen(p: Vector3d): Vector2d | null
    {
        this.pt.set(p.x,p.y,p.z).project(this.camera)
        if (this.pt.z > 1) return null;
        const rect = this.renderer.domElement.getBoundingClientRect()
        let vec2d : Vector2d= {x: ((this.pt.x + 1) / 2) * rect.width, y: ((-this.pt.y + 1)/2) * rect.height}
        return vec2d;
    }

    



}
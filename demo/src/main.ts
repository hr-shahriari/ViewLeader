import * as THREE from 'three'
import { createScene } from './scene'
import type {Annotation} from 'viewleader'
import { AnnotationManager } from 'viewleader'
import { renderGroup } from 'three/tsl'
const viewport = document.getElementById('viewport')!
const ctx = createScene(viewport)

const sample: Annotation = 
{
    id: 'demo',
    anchor: {type: 'point', position: {x: 0, y: 5, z:0}},
    content: {type: 'mtext', text: 'heloo'},
    styleId: 'standard',
    visible: true
}

console.log('annotation shape:', sample)

const VIEWS = {
  front: { pos: new THREE.Vector3(0, 5, 22),    target: new THREE.Vector3(1.5, 5, 0) },
  top:   { pos: new THREE.Vector3(1.5, 30, 0.01), target: new THREE.Vector3(1.5, 0, 0) },
  side:  { pos: new THREE.Vector3(22, 5, 0),    target: new THREE.Vector3(0, 5, 0) },
  iso:   { pos: new THREE.Vector3(14, 10, 14),  target: new THREE.Vector3(1.5, 4, 0) },
};

window.addEventListener('keydown', (e) => {
  const v = VIEWS[e.key === '1' ? 'front' : e.key === '2' ? 'top' : e.key === '3' ? 'side' : e.key === '4' ? 'iso' : 'iso'];
  if (['1','2','3','4'].includes(e.key)) {
    ctx.camera.position.copy(v.pos);
    ctx.controls.target.copy(v.target);
    ctx.controls.update();
  }
});

const manager = new AnnotationManager({
    scene: ctx.scene,
    camera: ctx.activeCamera,
    renderer: ctx.renderer
})

manager.addAnnotation({
  anchor: { type: 'point', position: { x: 0, y: 5, z: 0 } },
  content: { type: 'mtext', text: 'Hello' },
});

function animate()
{
    requestAnimationFrame(animate);
    ctx.controls.update();
    ctx.renderer.render(ctx.scene, ctx.camera)
}

animate();
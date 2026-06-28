import * as THREE from 'three'
import { createScene } from './scene'
import { AnnotationManager } from 'viewleader'
const viewport = document.getElementById('viewport')!
const ctx = createScene(viewport)

const VIEWS = {
  front: { pos: new THREE.Vector3(0, 5, 22), target: new THREE.Vector3(1.5, 5, 0) },
  top: { pos: new THREE.Vector3(1.5, 30, 0.01), target: new THREE.Vector3(1.5, 0, 0) },
  side: { pos: new THREE.Vector3(22, 5, 0), target: new THREE.Vector3(0, 5, 0) },
  iso: { pos: new THREE.Vector3(14, 10, 14), target: new THREE.Vector3(1.5, 4, 0) },
};

window.addEventListener('keydown', (e) => {
  const v = VIEWS[e.key === '1' ? 'front' : e.key === '2' ? 'top' : e.key === '3' ? 'side' : e.key === '4' ? 'iso' : 'iso'];
  if (['1', '2', '3', '4'].includes(e.key)) {
    ctx.camera.position.copy(v.pos);
    ctx.controls.target.copy(v.target);
    ctx.controls.update();
  }
});

const manager = new AnnotationManager({
  scene: ctx.scene,
  camera: ctx.activeCamera,
  renderer: ctx.renderer,
  bObjects: [ctx.buildingGroup],
})

manager.addAnnotation({
  anchor: { type: 'point', position: { x: -1, y: 9.3, z: 0 } },
  content: { type: 'mtext', text: 'Roof Slab' },
});
manager.addAnnotation({
  anchor: { type: 'point', position: { x: -3.05, y: 5, z: 0 } },
  content: { type: 'mtext', text: 'Curtain Wall' },
});
manager.addAnnotation({
  anchor: { type: 'point', position: { x: 4, y: 5.2, z: 0 } },
  content: { type: 'mtext', text: 'Wing B' },
});

let pickMode = false
document.addEventListener('keydown', (e) => { if (e.key === 'p') pickMode = true })
document.addEventListener('keyup', (e) => { if (e.key === 'p') pickMode = false })

  ctx.renderer.domElement.addEventListener('click',(e) =>
  {
    if (!pickMode) return
    manager.pickAnchor({cx: e.clientX, cy: e.clientY})
  })


function animate() {
  requestAnimationFrame(animate);
  ctx.controls.update();
  ctx.renderer.render(ctx.scene, ctx.camera)
}

animate();
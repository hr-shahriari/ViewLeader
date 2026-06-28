import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface SceneContext
{
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    orthoCamera: THREE.OrthographicCamera
    activeCamera : THREE.Camera;
    renderer: THREE.WebGLRenderer;
    controls: OrbitControls;
    buildingGroup: THREE.Group;
    setProjection(mode: 'perspective' | 'orthographic'): THREE.Camera
}

const mat = 
{
    concrete : new THREE.MeshStandardMaterial({
        color: "#8891a0", roughness: 0.75, metalness: 0.05
    }),
    glass:    new THREE.MeshStandardMaterial({ color: '#6aabcc', roughness: 0.1, metalness: 0.6, transparent: true, opacity: 0.55 }),
    steel:    new THREE.MeshStandardMaterial({ color: '#5a6070', roughness: 0.3, metalness: 0.85 }),
    roof:     new THREE.MeshStandardMaterial({ color: '#4a5568', roughness: 0.6, metalness: 0.3 }),
    dark: new THREE.MeshStandardMaterial({ color: '#3a3e4a', roughness: 0.8, metalness: 0.1 }),
    accent: new THREE.MeshStandardMaterial({ color: '#e07040', roughness: 0.5, metalness: 0.2 })
}
export function createScene(viewport: HTMLElement): SceneContext
{
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(viewport.clientWidth,viewport.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    viewport.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#1C2541")
    scene.fog = new THREE.Fog("#1C2541", 10, 50);

    const camera = new THREE.PerspectiveCamera(
        50,
        viewport.clientWidth / viewport.clientHeight,
        0.1,
        100
    );
    camera.position.set(14, 10, 14);
    // const distance = camera.position.distanceTo()
  const aspect = viewport.clientWidth / viewport.clientHeight;
  const frustumSize = 18;
  const orthoCamera = new THREE.OrthographicCamera(
    -frustumSize * aspect / 2, frustumSize * aspect / 2,
    frustumSize / 2, -frustumSize / 2,
    0.1, 200,
  );
  orthoCamera.position.copy(camera.position);

  let activeCamera: THREE.Camera = camera;

  function setProjection(mode: 'perspective' | 'orthographic'): THREE.Camera {
    if (mode === 'orthographic') {
      orthoCamera.position.copy(camera.position);
      orthoCamera.quaternion.copy(camera.quaternion);
      const a = viewport.clientWidth / viewport.clientHeight;
      orthoCamera.left = -frustumSize * a / 2;
      orthoCamera.right = frustumSize * a / 2;
      orthoCamera.top = frustumSize / 2;
      orthoCamera.bottom = -frustumSize / 2;
      orthoCamera.updateProjectionMatrix();
      controls.object = orthoCamera;
      activeCamera = orthoCamera;
    } else {
      camera.position.copy(orthoCamera.position);
      camera.quaternion.copy(orthoCamera.quaternion);
      controls.object = camera;
      activeCamera = camera;
    }
    controls.update();
    return activeCamera;
  }
    


    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(0, 1, 0);
    var sun = new THREE.DirectionalLight("#ffeedd", 1.8);
    var ambientLight = new THREE.AmbientLight("#fff", 0.5);
    sun.castShadow = true;
    sun.shadow.mapSize.setScalar(2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60
    sun.shadow.camera.left = -20;
    sun.shadow.camera.top = 20;
    sun.position.set(10, 20, 8);
    scene.add(sun, ambientLight);

     const fillLight = new THREE.DirectionalLight('#99bbff', 0.4);
  fillLight.position.set(-8, 6, -4);
  scene.add(fillLight);
    const ground = new THREE.Mesh(
        new THREE.PlaneGeometry(100, 100),
        new THREE.MeshStandardMaterial({ color: "#1B998B" })
    );
    ground.rotateX(-Math.PI / 2);
    ground.receiveShadow = true;
    scene.add(ground);

    const grid = new THREE.GridHelper(100, 100, '#EAEAEA', '#EAEAEA');
    grid.name = 'grid'
    grid.translateY(0.01);
    scene.add(grid);

    const buildingGroup = createBuildingModel(scene);

    window.addEventListener("resize", () => {
        camera.aspect = viewport.clientWidth / viewport.clientHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(viewport.clientWidth, viewport.clientHeight);
    });

 return {
    scene, camera, orthoCamera, renderer, controls, buildingGroup, setProjection,
    get activeCamera() { return activeCamera; },
  };
}

export function createBuildingModel(scene: THREE.Scene): THREE.Group
{
    const group = new THREE.Group();
    group.name = "Building"

 const wingA = box(4, 9, 6, mat.concrete);
  wingA.position.set(-1, 4.5, 0);
  wingA.name = 'Wing A - Main Structure';
  group.add(wingA);

  const wingB = box(6, 5, 6, mat.concrete);
  wingB.position.set(4, 2.5, 0);
  wingB.name = 'Wing B - Extension';
  group.add(wingB);

  const curtainWall = box(0.1, 7, 5, mat.glass);
  curtainWall.position.set(-3.05, 4, 0);
  curtainWall.name = 'Curtain Wall';
  group.add(curtainWall);

  for (let i = 0; i < 3; i++) {
    const panel = box(0.08, 3.5, 1.4, mat.glass);
    panel.position.set(7.04, 2.5, -1.8 + i * 1.8);
    panel.name = `Glass Panel ${i + 1}`;
    group.add(panel);
  }

  const colPositions: [number, number, number][] = [
    [-3, 0, -2.5], [-3, 0, 2.5],
    [ 1, 0, -2.5], [ 1, 0, 2.5],
    [ 4, 0, -2.5], [ 4, 0, 2.5],
    [ 7, 0, -2.5], [ 7, 0, 2.5],
  ];
  colPositions.forEach(([x, _y, z], i) => {
    const col = box(0.3, 9, 0.3, mat.steel);
    col.position.set(x, 4.5, z);
    col.name = `Column ${i + 1}`;
    group.add(col);
  });

  const roofSlab = box(12, 0.3, 7, mat.roof);
  roofSlab.position.set(1.5, 9.15, 0);
  roofSlab.name = 'Roof Slab';
  group.add(roofSlab);


   const mech = box(2, 1.5, 2, mat.dark);
  mech.position.set(-1, 10, 0);
  mech.name = 'Mechanical Room';
  group.add(mech);

  const elevator = box(1.2, 9.5, 1.2, mat.dark);
  elevator.position.set(0.8, 4.75, -1.8);
  elevator.name = 'Elevator Shaft';
  group.add(elevator);

  // Entrance canopy + supports
  const canopy = box(3, 0.15, 2.5, mat.steel);
  canopy.position.set(-3, 3.5, 0);
  canopy.name = 'Entrance Canopy';
  group.add(canopy);

  for (const z of [-1, 1]) {
    const s = box(0.1, 1.5, 0.1, mat.steel);
    s.position.set(-4.4, 2.8, z);
    group.add(s);
  }

  // Orange balcony + railing
  const balcony = box(0.6, 0.15, 4, mat.accent);
  balcony.position.set(-3.3, 6.5, 0);
  balcony.name = 'Balcony';
  group.add(balcony);

  const railing = box(0.05, 0.9, 4, mat.steel);
  railing.position.set(-3.65, 7, 0);
  group.add(railing);

  // Foundation strip
  const foundation = box(12.5, 0.4, 7, mat.dark);
  foundation.position.set(1.5, 0.2, 0);
  foundation.name = 'Foundation';
  group.add(foundation);


  group.traverse(
    (child) => {
        if (child instanceof THREE.Mesh)
        {
            child.castShadow = true;
            child.receiveShadow = true;
        }
    }
  )

  scene.add(group);
  return group;

}

function box(x:number, y:number, z:number, material: THREE.Material): THREE.Mesh
{
    return new THREE.Mesh(new THREE.BoxGeometry(x,y,z), material);

}


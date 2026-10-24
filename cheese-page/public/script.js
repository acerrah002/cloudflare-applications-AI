import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(4.5, 3, 5.5);

// Lights
scene.add(new THREE.AmbientLight(0xffffff, 0.7));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(5, 8, 5);
scene.add(sun);
const fill = new THREE.PointLight(0xffd27a, 1.2, 30);
fill.position.set(-5, -2, 4);
scene.add(fill);

// Cheese texture (procedural speckles)
function makeCheeseTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#f7c948';
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 4000; i++) {
    const light = Math.random() > 0.5;
    g.fillStyle = light ? 'rgba(255,236,150,0.35)' : 'rgba(200,140,20,0.25)';
    g.beginPath();
    g.arc(Math.random() * 512, Math.random() * 512, Math.random() * 2.2 + 0.3, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SIZE = { x: 3, y: 2, z: 2 };
const cheese = new THREE.Group();
scene.add(cheese);

const block = new THREE.Mesh(
  new THREE.BoxGeometry(SIZE.x, SIZE.y, SIZE.z),
  new THREE.MeshStandardMaterial({ map: makeCheeseTexture(), roughness: 0.55, metalness: 0.0 })
);
cheese.add(block);

// Holes on every face
const faces = [
  { n: [1, 0, 0],  u: [0, 1, 0], v: [0, 0, 1], hn: 1.5, hu: 1,   hv: 1 },
  { n: [-1, 0, 0], u: [0, 1, 0], v: [0, 0, 1], hn: 1.5, hu: 1,   hv: 1 },
  { n: [0, 1, 0],  u: [1, 0, 0], v: [0, 0, 1], hn: 1,   hu: 1.5, hv: 1 },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1], hn: 1,   hu: 1.5, hv: 1 },
  { n: [0, 0, 1],  u: [1, 0, 0], v: [0, 1, 0], hn: 1,   hu: 1.5, hv: 1 },
  { n: [0, 0, -1], u: [1, 0, 0], v: [0, 1, 0], hn: 1,   hu: 1.5, hv: 1 },
];

const rimMat = new THREE.MeshStandardMaterial({ color: 0xe0a020, roughness: 0.8 });
const holeMat = new THREE.MeshStandardMaterial({ color: 0x9a6208, roughness: 1 });

faces.forEach(f => {
  const count = 4 + Math.floor(Math.random() * 3);
  for (let i = 0; i < count; i++) {
    const r = 0.1 + Math.random() * 0.2;
    const a = (Math.random() * 2 - 1) * (f.hu - r - 0.05);
    const b = (Math.random() * 2 - 1) * (f.hv - r - 0.05);
    const n = new THREE.Vector3(...f.n);
    const u = new THREE.Vector3(...f.u);
    const v = new THREE.Vector3(...f.v);
    const pos = n.clone().multiplyScalar(f.hn)
      .add(u.clone().multiplyScalar(a))
      .add(v.clone().multiplyScalar(b));

    const rim = new THREE.Mesh(new THREE.CircleGeometry(r * 1.15, 32), rimMat);
    rim.position.copy(pos).add(n.clone().multiplyScalar(0.003));
    rim.lookAt(rim.position.clone().add(n));
    cheese.add(rim);

    const hole = new THREE.Mesh(new THREE.CircleGeometry(r * 0.85, 32), holeMat);
    hole.position.copy(pos).add(n.clone().multiplyScalar(0.006));
    hole.lookAt(hole.position.clone().add(n));
    cheese.add(hole);
  }
});

// Controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 4;
controls.maxDistance = 14;
controls.autoRotate = true;
controls.autoRotateSpeed = 1.5;

let idleTimer;
controls.addEventListener('start', () => {
  controls.autoRotate = false;
  clearTimeout(idleTimer);
});
controls.addEventListener('end', () => {
  idleTimer = setTimeout(() => (controls.autoRotate = true), 3000);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

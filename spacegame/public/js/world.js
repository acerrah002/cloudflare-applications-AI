import * as THREE from "three";
import { GLTFLoader } from "../vendor/loaders/GLTFLoader.js";

// Your Blender model goes in:  public/spaceship player/spaceship.glb
const MODEL_URL = encodeURI("/spaceship player/spaceship.glb");
const MODEL_LENGTH = 6;          // ship length in game units
const MODEL_ROTATE_Y = Math.PI;  // change to 0 if your ship flies backwards
export const COLORS = { me: 0x35e0ff, foe: 0xff5a3c };
export const LASER_SPEED = 170;

export function mulberry(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rndDir() {
  const v = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
  if (v.lengthSq() < 1e-4) v.set(1, 0, 0);
  return v.normalize();
}

export class World {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.1, 3000);
    this.camera.position.set(0, 40, 170);
    this.lasers = [];
    this.particles = [];
    this.asteroids = [];
    this.asteroidMeshes = [];
    this.shake = 0;
    this.idleAngle = 0;
    this.template = null;
    this.laserGeo = new THREE.CylinderGeometry(0.1, 0.1, 3.4, 6);
    this.glowGeo = new THREE.CylinderGeometry(0.3, 0.3, 3.8, 8);
    this.partGeo = new THREE.SphereGeometry(1, 6, 4);
    this.mats = {};
    [["me", COLORS.me], ["foe", COLORS.foe]].forEach((e) => {
      this.mats[e[0]] = {
        core: new THREE.MeshBasicMaterial({ color: 0xffffff }),
        glow: new THREE.MeshBasicMaterial({ color: e[1], transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false }),
        part: new THREE.MeshBasicMaterial({ color: e[1] }),
      };
    });
    this.hotMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
    this.whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.buildSky();
    this.buildLights();
    this.buildPlanet();
    this.buildBoundary();
    this.resize();
    window.addEventListener("resize", () => this.resize());
    this.ready = new Promise((resolve) => this.loadModel(resolve));
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildSky() {
    const c = document.createElement("canvas");
    c.width = 2048; c.height = 1024;
    const g = c.getContext("2d");
    g.fillStyle = "#03050d";
    g.fillRect(0, 0, 2048, 1024);
    [["#3b1d6e", 300, 500, 460], ["#0f4a7a", 1300, 300, 420], ["#6e1d4a", 1750, 720, 380], ["#0b3d5c", 760, 820, 340]].forEach((b) => {
      const gr = g.createRadialGradient(b[1], b[2], 0, b[1], b[2], b[3]);
      gr.addColorStop(0, b[0] + "cc");
      gr.addColorStop(1, b[0] + "00");
      g.fillStyle = gr;
      g.fillRect(0, 0, 2048, 1024);
    });
    for (let i = 0; i < 1800; i++) {
      g.fillStyle = "rgba(255,255,255," + (0.25 + Math.random() * 0.75).toFixed(2) + ")";
      const s = Math.random() < 0.06 ? 2.2 : 1.2;
      g.fillRect(Math.random() * 2048, Math.random() * 1024, s, s);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(1500, 32, 16),
      new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, depthWrite: false, fog: false })
    );
    this.scene.add(this.sky);

    // drifting dust gives a sense of speed
    const n = 1400, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = rndDir().multiplyScalar(60 + Math.random() * 260);
      pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    this.dust = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x9fb8ff, size: 0.8, sizeAttenuation: true, transparent: true, opacity: 0.7, depthWrite: false }));
    this.scene.add(this.dust);
  }

  buildLights() {
    this.scene.add(new THREE.HemisphereLight(0x7f9dff, 0x2a1530, 0.9));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));
    const sun = new THREE.DirectionalLight(0xfff0dd, 2.6);
    sun.position.set(250, 180, 120);
    this.scene.add(sun);
  }

  buildPlanet() {
    const c = document.createElement("canvas");
    c.width = 512; c.height = 256;
    const g = c.getContext("2d");
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, "#c98a5a");
    gr.addColorStop(0.35, "#8a4f3a");
    gr.addColorStop(0.6, "#d8b48a");
    gr.addColorStop(1, "#6b3b2e");
    g.fillStyle = gr;
    g.fillRect(0, 0, 512, 256);
    for (let i = 0; i < 40; i++) {
      g.fillStyle = "rgba(255,255,255," + (Math.random() * 0.08).toFixed(3) + ")";
      g.fillRect(0, Math.random() * 256, 512, 2 + Math.random() * 10);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const planet = new THREE.Mesh(new THREE.SphereGeometry(150, 48, 32), new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0 }));
    planet.position.set(-420, 130, -700);
    this.scene.add(planet);
    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(158, 32, 20),
      new THREE.MeshBasicMaterial({ color: 0xff9a5a, transparent: true, opacity: 0.12, side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    halo.position.copy(planet.position);
    this.scene.add(halo);
    this.planet = planet;
  }

  buildBoundary() {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(130, 32, 20),
      new THREE.MeshBasicMaterial({ color: 0x2a6fff, wireframe: true, transparent: true, opacity: 0.07, depthWrite: false })
    );
    this.scene.add(m);
  }

  loadModel(done) {
    try {
      new GLTFLoader().load(MODEL_URL, (gltf) => {
        const m = gltf.scene;
        const box = new THREE.Box3().setFromObject(m);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const s = MODEL_LENGTH / Math.max(size.x, size.y, size.z, 0.0001);
        m.position.sub(center);
        const holder = new THREE.Group();
        holder.add(m);
        holder.scale.setScalar(s);
        holder.rotation.y = MODEL_ROTATE_Y;
        const wrap = new THREE.Group();
        wrap.add(holder);
        this.template = wrap;
        done();
      }, undefined, () => done());
    } catch (e) {
      done();
    }
  }
  proceduralShip(color) {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0xb9c4d6, metalness: 0.6, roughness: 0.35, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x2a3142, metalness: 0.5, roughness: 0.5, flatShading: true });
    const accent = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, metalness: 0.3, roughness: 0.4 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x9fe8ff, emissive: 0x2a7a99, emissiveIntensity: 0.7, metalness: 0.2, roughness: 0.1 });
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.85, 5.2, 8), hull);
    body.rotation.x = -Math.PI / 2;
    g.add(body);
    const wl = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.12, 1.6), hull);
    wl.position.set(-1.7, -0.05, 1.0);
    wl.rotation.y = 0.45;
    g.add(wl);
    const wr = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.12, 1.6), hull);
    wr.position.set(1.7, -0.05, 1.0);
    wr.rotation.y = -0.45;
    g.add(wr);
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 1.3), accent);
    tl.position.set(-2.9, -0.05, 1.5);
    tl.rotation.y = 0.45;
    g.add(tl);
    const tr = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 1.3), accent);
    tr.position.set(2.9, -0.05, 1.5);
    tr.rotation.y = -0.45;
    g.add(tr);
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.3, 1.2), accent);
    fin.position.set(0, 0.75, 1.8);
    g.add(fin);
    const cockpit = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), glass);
    cockpit.scale.set(1, 0.7, 1.8);
    cockpit.position.set(0, 0.45, -0.6);
    g.add(cockpit);
    [-0.7, 0.7].forEach((x) => {
      const e = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.4, 1.0, 10), dark);
      e.rotation.x = Math.PI / 2;
      e.position.set(x, 0, 2.2);
      g.add(e);
    });
    return g;
  }

  makeShip(color) {
    const root = new THREE.Group();
    root.rotation.order = "YXZ";
    const vis = new THREE.Group();
    root.add(vis);
    vis.add(this.template ? this.template.clone(true) : this.proceduralShip(color));
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.5, 3, 10),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    flame.rotation.x = Math.PI / 2;
    vis.add(flame);
    const light = new THREE.PointLight(color, 30, 22, 2);
    light.position.set(0, 0, 3.2);
    vis.add(light);
    this.scene.add(root);
    const ship = { root, vis, flame };
    this.setFlame(ship, 0.5);
    return ship;
  }

  place(ship, pos, yaw, pitch, roll) {
    ship.root.position.copy(pos);
    ship.root.rotation.set(pitch, yaw, 0, "YXZ");
    ship.vis.rotation.z = roll;
  }

  setFlame(ship, level) {
    const len = 0.5 + level * 1.5 + Math.random() * 0.15;
    ship.flame.scale.set(1, len, 1);
    ship.flame.position.set(0, 0, 2.6 + 1.5 * len);
  }

  setAsteroids(seed, avoid) {
    this.asteroidMeshes.forEach((m) => { this.scene.remove(m); m.geometry.dispose(); });
    this.asteroidMeshes = [];
    const rnd = mulberry(seed);
    const out = [];
    let guard = 0;
    while (out.length < 14 && guard++ < 600) {
      const r = 4 + rnd() * 7;
      const p = new THREE.Vector3((rnd() * 2 - 1) * 100, (rnd() * 2 - 1) * 60, (rnd() * 2 - 1) * 100);
      if (p.length() > 105) continue;
      let ok = true;
      avoid.forEach((s) => { if (p.distanceTo(s) < r + 30) ok = false; });
      out.forEach((q) => { if (p.distanceTo(q.p) < r + q.r + 6) ok = false; });
      if (ok) out.push({ p, r });
    }
    this.asteroids = out;
    if (!this.rockMat) this.rockMat = new THREE.MeshStandardMaterial({ color: 0x7d746b, roughness: 0.95, metalness: 0.05, flatShading: true });
    out.forEach((a) => {
      const geo = new THREE.IcosahedronGeometry(1, 1);
      const k1 = rnd() * 6, k2 = rnd() * 6, k3 = rnd() * 6;
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        const f = 0.82 + 0.18 * Math.sin(x * 4.1 + k1) * Math.cos(y * 3.3 + k2) + 0.12 * Math.sin(z * 5.7 + k3);
        pos.setXYZ(i, x * f, y * f, z * f);
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, this.rockMat);
      m.position.copy(a.p);
      m.scale.setScalar(a.r);
      m.rotation.set(rnd() * 6, rnd() * 6, rnd() * 6);
      m.userData.spin = (rnd() - 0.5) * 0.3;
      this.scene.add(m);
      this.asteroidMeshes.push(m);
    });
  }

  spawnLaser(origin, dir, owner, id) {
    const key = owner === "foe" ? "foe" : "me";
    const grp = new THREE.Group();
    grp.add(new THREE.Mesh(this.laserGeo, this.mats[key].core));
    grp.add(new THREE.Mesh(this.glowGeo, this.mats[key].glow));
    grp.position.copy(origin);
    const d = dir.clone().normalize();
    grp.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
    this.scene.add(grp);
    const L = { mesh: grp, pos: origin.clone(), prev: origin.clone(), dir: d, life: 1.5, owner, id };
    this.lasers.push(L);
    return L;
  }

  removeLaser(L) {
    this.scene.remove(L.mesh);
    const i = this.lasers.indexOf(L);
    if (i >= 0) this.lasers.splice(i, 1);
  }

  clearLasers() {
    this.lasers.slice().forEach((L) => this.removeLaser(L));
  }

  addParticle(pos, vel, life, size, mat, flash) {
    const m = new THREE.Mesh(this.partGeo, mat);
    m.position.copy(pos);
    m.scale.setScalar(size);
    this.scene.add(m);
    this.particles.push({ m, vel, life, max: life, size, flash: !!flash });
  }

  spark(pos, owner, n) {
    const key = owner === "foe" ? "foe" : "me";
    for (let i = 0; i < (n || 8); i++) {
      this.addParticle(pos, rndDir().multiplyScalar(6 + Math.random() * 10), 0.3, 0.22, this.mats[key].part);
    }
  }

  explode(pos, owner) {
    const key = owner === "foe" ? "foe" : "me";
    const fm = new THREE.MeshBasicMaterial({ color: 0xffe2a8, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    this.addParticle(pos, new THREE.Vector3(), 0.5, 1, fm, true);
    for (let i = 0; i < 42; i++) {
      const mat = i % 3 === 0 ? this.mats[key].part : (i % 3 === 1 ? this.hotMat : this.whiteMat);
      this.addParticle(pos, rndDir().multiplyScalar(8 + Math.random() * 30), 0.7 + Math.random() * 0.8, 0.25 + Math.random() * 0.5, mat);
    }
    this.shake = Math.max(this.shake, 0.9);
  }

  update(dt) {
    this.asteroidMeshes.forEach((m) => {
      m.rotation.y += m.userData.spin * dt;
      m.rotation.x += m.userData.spin * 0.6 * dt;
    });
    for (let i = this.lasers.length - 1; i >= 0; i--) {
      const L = this.lasers[i];
      L.prev.copy(L.pos);
      L.pos.addScaledVector(L.dir, LASER_SPEED * dt);
      L.mesh.position.copy(L.pos);
      L.life -= dt;
      let dead = L.life <= 0;
      if (!dead) {
        for (let k = 0; k < this.asteroids.length; k++) {
          const a = this.asteroids[k];
          if (L.pos.distanceToSquared(a.p) < a.r * a.r * 0.8) {
            dead = true;
            this.spark(L.pos, L.owner, 6);
            break;
          }
        }
      }
      if (dead) this.removeLaser(L);
    }
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.m);
        if (p.flash) p.m.material.dispose();
        this.particles.splice(i, 1);
        continue;
      }
      const k = p.life / p.max;
      p.m.position.addScaledVector(p.vel, dt);
      p.vel.multiplyScalar(Math.max(0, 1 - dt * 1.6));
      if (p.flash) {
        p.m.scale.setScalar(p.size * (1 + (1 - k) * 9));
        p.m.material.opacity = k;
      } else {
        p.m.scale.setScalar(Math.max(0.01, p.size * k));
      }
    }
    if (this.planet) this.planet.rotation.y += dt * 0.01;
  }

  follow(pos, yaw, pitch, dt, snap) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, "YXZ"));
    const want = new THREE.Vector3(0, 2.6, 9.5).applyQuaternion(q).add(pos);
    const k = snap ? 1 : 1 - Math.exp(-dt * 14);
    this.camera.position.lerp(want, k);
    if (this.shake > 0) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
    const look = new THREE.Vector3(0, 0, -45).applyQuaternion(q).add(pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(look);
  }

  idleCamera(dt) {
    this.idleAngle += dt * 0.08;
    this.camera.position.set(Math.cos(this.idleAngle) * 170, 35, Math.sin(this.idleAngle) * 170);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
  }

  toScreen(v) {
    const cam = this.camera;
    cam.updateMatrixWorld();
    const local = v.clone().applyMatrix4(cam.matrixWorldInverse);
    const behind = local.z > 0;
    const p = v.clone().project(cam);
    let x = p.x, y = p.y;
    if (behind) { x = -x; y = -y; }
    return { x, y, behind };
  }

  render() {
    this.sky.position.copy(this.camera.position);
    this.renderer.render(this.scene, this.camera);
  }
}
// end of file
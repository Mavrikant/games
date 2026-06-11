// Three.js rendering. The ONLY module that imports three. Renderer creation
// is guarded (yildizlararasi pattern): when WebGL is unavailable (headless
// smoke test, ancient devices) every function here no-ops and the simulation
// + HUD keep running. The render loop body lives in the entry inside a
// try/catch that halts drawing on error, so a lost context can never spam
// console.error.

import * as THREE from 'three';
import {
  CAM_BACK,
  CAM_EASE,
  CAM_UP,
  CLOUD_Y,
  CRAFT_R,
  FOG_FAR,
  FOG_NEAR,
  HOVER_H,
  SHAKE_LEAD_S,
  SKY,
} from './constants';
import { effTop, liveOf } from './world';
import type { World } from './types';

let webglOk = false;
let canvasEl: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;

let arenaGroup: THREE.Group | null = null;
let craftsGroup: THREE.Group | null = null;
let orbsGroup: THREE.Group | null = null;

interface CraftView {
  group: THREE.Group;
  ring: THREE.Mesh;
  shadow: THREE.Mesh;
  rope: THREE.Line;
  ropePos: THREE.BufferAttribute;
}

let islandMeshes: THREE.Mesh[] = [];
let craftViews = new Map<string, CraftView>();
let orbMeshes: THREE.Mesh[] = [];
let reticle: THREE.Mesh | null = null;

const raycaster = new THREE.Raycaster();
const aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -HOVER_H);
const scratchNdc = new THREE.Vector2();
const scratchHit = new THREE.Vector3();
const scratchCam = new THREE.Vector3();
const scratchLook = new THREE.Vector3();

export function isWebglOk(): boolean {
  return webglOk;
}

export function initScene(canvas: HTMLCanvasElement, isCoarse: boolean): boolean {
  canvasEl = canvas;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isCoarse ? 1.5 : 2));
    scene = new THREE.Scene();
    scene.background = new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, FOG_NEAR, FOG_FAR);
    camera = new THREE.PerspectiveCamera(55, 1, 0.1, 320);
    camera.position.set(0, 44, 64);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const dir = new THREE.DirectionalLight(0xfff2dd, 1.0);
    dir.position.set(40, 70, 30);
    scene.add(dir);

    // Cloud deck: two flat translucent discs under the arena sell the void.
    const cloudMat = new THREE.MeshBasicMaterial({
      color: '#46587a',
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
    });
    const cloud = new THREE.Mesh(new THREE.CircleGeometry(260, 28), cloudMat);
    cloud.rotation.x = -Math.PI / 2;
    cloud.position.y = CLOUD_Y;
    scene.add(cloud);
    const cloud2 = new THREE.Mesh(
      new THREE.CircleGeometry(300, 24),
      new THREE.MeshBasicMaterial({ color: '#394a68', transparent: true, opacity: 0.8, depthWrite: false }),
    );
    cloud2.rotation.x = -Math.PI / 2;
    cloud2.position.y = CLOUD_Y - 5;
    scene.add(cloud2);

    arenaGroup = new THREE.Group();
    craftsGroup = new THREE.Group();
    orbsGroup = new THREE.Group();
    scene.add(arenaGroup, craftsGroup, orbsGroup);

    reticle = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.07, 6, 20),
      new THREE.MeshBasicMaterial({ color: '#7dd3fc', transparent: true, opacity: 0.85 }),
    );
    reticle.rotation.x = -Math.PI / 2;
    reticle.visible = false;
    scene.add(reticle);

    resize();
    webglOk = true;
  } catch {
    webglOk = false;
    renderer = null;
  }
  return webglOk;
}

export function resize(): void {
  if (!renderer || !camera || !canvasEl) return;
  const w = Math.max(1, canvasEl.clientWidth);
  const h = Math.max(1, canvasEl.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/** Client coords → ground point at the local player's hover plane. */
export function toWorld(clientX: number, clientY: number): { x: number; z: number } | null {
  if (!camera || !canvasEl) return null;
  const r = canvasEl.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  scratchNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(scratchNdc, camera);
  if (raycaster.ray.intersectPlane(aimPlane, scratchHit)) {
    return { x: scratchHit.x, z: scratchHit.z };
  }
  return null;
}

// ---- arena construction --------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = Math.floor(seed * 100000) >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function disposeGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else if (mat) mat.dispose();
    });
  }
}

const ISLAND_H = 7;

function makeIslandMesh(r: number, seed: number): THREE.Mesh {
  const geo = new THREE.CylinderGeometry(r, r * 0.45, ISLAND_H, 9, 1);
  // Roughen the silhouette: jitter each vertex ring radially with seeded noise
  // so every island reads as a distinct rock. The PHYSICS radius stays `r`
  // (the jitter is within ±12%, visually inside the fog-softened rim).
  const rand = mulberry32(seed);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const len = Math.hypot(x, z);
    if (len > 0.01) {
      const k = 0.94 + rand() * 0.12;
      pos.setX(i, x * k);
      pos.setZ(i, z * k);
    }
    if (pos.getY(i) > ISLAND_H / 2 - 0.01 && len > 0.01) {
      pos.setY(i, ISLAND_H / 2 + (rand() - 0.5) * 0.8);
    }
  }
  geo.computeVertexNormals();
  const side = new THREE.MeshStandardMaterial({ color: '#5d544c', flatShading: true });
  const top = new THREE.MeshStandardMaterial({ color: '#6f8f6a', flatShading: true });
  const bottom = new THREE.MeshStandardMaterial({ color: '#4a423b', flatShading: true });
  return new THREE.Mesh(geo, [side, top, bottom]);
}

function makeCraftView(hue: number): CraftView {
  const group = new THREE.Group();
  const color = new THREE.Color().setHSL(hue / 360, 0.65, 0.55);
  const hull = new THREE.Mesh(
    new THREE.OctahedronGeometry(CRAFT_R, 0),
    new THREE.MeshStandardMaterial({ color, flatShading: true }),
  );
  hull.scale.set(1.0, 0.45, 1.25);
  group.add(hull);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.35, 0.55),
    new THREE.MeshStandardMaterial({ color: '#1c2430', flatShading: true }),
  );
  cabin.position.y = 0.35;
  group.add(cabin);
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(CRAFT_R * 1.05, 0.09, 6, 18),
    new THREE.MeshBasicMaterial({
      color: new THREE.Color().setHSL(hue / 360, 0.9, 0.65),
      transparent: true,
      opacity: 0.9,
    }),
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -0.05;
  group.add(ring);

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(CRAFT_R * 1.2, 16),
    new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.3, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  group.add(shadow); // re-parented position set per frame (world space below)

  const ropeGeo = new THREE.BufferGeometry();
  const ropePos = new THREE.BufferAttribute(new Float32Array(12 * 3), 3);
  ropeGeo.setAttribute('position', ropePos);
  const rope = new THREE.Line(
    ropeGeo,
    new THREE.LineBasicMaterial({ color: '#67e8f9', transparent: true, opacity: 0.9 }),
  );
  rope.visible = false;
  rope.frustumCulled = false;

  return { group, ring, shadow, rope, ropePos };
}

/** (Re)build island/craft/orb objects for the given world. */
export function buildArena(world: World): void {
  if (!webglOk || !arenaGroup || !craftsGroup || !orbsGroup || !scene) return;

  disposeGroup(arenaGroup);
  islandMeshes = [];
  for (const isl of world.islands) {
    const mesh = makeIslandMesh(isl.r, isl.seed);
    mesh.position.set(isl.x, isl.topY - ISLAND_H / 2, isl.z);
    arenaGroup.add(mesh);
    islandMeshes.push(mesh);
  }

  disposeGroup(craftsGroup);
  craftViews = new Map();
  for (const c of world.crafts) {
    const view = makeCraftView(c.hue);
    craftsGroup.add(view.group);
    craftsGroup.add(view.shadow);
    craftsGroup.add(view.rope);
    craftViews.set(c.id, view);
  }

  disposeGroup(orbsGroup);
  orbMeshes = [];
  for (let i = 0; i < world.orbs.length; i++) {
    const orb = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.55, 0),
      new THREE.MeshStandardMaterial({
        color: '#f59e0b',
        emissive: '#b45309',
        emissiveIntensity: 0.9,
        flatShading: true,
      }),
    );
    orbsGroup.add(orb);
    orbMeshes.push(orb);
  }
}

// ---- per-frame sync ---------------------------------------------------------------

let camInit = false;
let menuAngle = 0;

export function resetCamera(): void {
  camInit = false;
}

/**
 * Sync meshes from the world and draw. `myId` picks the camera target;
 * `aim` (world point) positions the reticle while playing.
 */
export function render(
  world: World,
  dt: number,
  myId: string,
  aim: { x: number; z: number } | null,
): void {
  if (!webglOk || !renderer || !scene || !camera) return;
  const now = performance.now() / 1000;

  // Islands: sink + shrink from the same live numbers physics uses.
  for (let i = 0; i < world.islands.length; i++) {
    const isl = world.islands[i]!;
    const mesh = islandMeshes[i];
    if (!mesh) continue;
    const live = liveOf(isl, world.t);
    mesh.visible = live > 0.01;
    mesh.scale.set(Math.max(0.02, live), 1, Math.max(0.02, live));
    let sx = isl.x;
    let sz = isl.z;
    const until = isl.collapseAt - world.t;
    if (until > 0 && until < SHAKE_LEAD_S) {
      const sh = 0.12 * (1 - until / SHAKE_LEAD_S);
      sx += Math.sin(now * 37 + i) * sh;
      sz += Math.cos(now * 41 + i) * sh;
    }
    mesh.position.set(sx, effTop(isl, world.t) - ISLAND_H / 2, sz);
  }

  // Crafts.
  let me: { x: number; y: number; z: number; vx: number; vz: number } | null = null;
  for (const c of world.crafts) {
    const view = craftViews.get(c.id);
    if (!view) continue;
    view.group.visible = c.alive;
    view.shadow.visible = c.alive;
    if (c.alive) {
      view.group.position.set(c.x, c.y, c.z);
      view.group.rotation.y = c.yaw;
      // Lean into velocity for a hovercraft feel.
      view.group.rotation.x = Math.max(-0.3, Math.min(0.3, c.vz * 0.012));
      view.group.rotation.z = Math.max(-0.3, Math.min(0.3, -c.vx * 0.012));
      // Spawn protection: ring pulses hard.
      const prot = c.protectIn > 0;
      view.ring.scale.setScalar(prot ? 1 + Math.sin(now * 12) * 0.25 : 1);
      (view.ring.material as THREE.MeshBasicMaterial).opacity = prot ? 0.45 + Math.sin(now * 12) * 0.3 : 0.9;
      // Fake shadow on the surface below.
      const idx = islandUnder(world, c.x, c.z);
      if (idx >= 0) {
        const top = effTop(world.islands[idx]!, world.t);
        view.shadow.position.set(c.x, top + 0.06, c.z);
        const h = Math.max(0, c.y - top);
        (view.shadow.material as THREE.MeshBasicMaterial).opacity = Math.max(0.05, 0.32 - h * 0.04);
        view.shadow.visible = true;
      } else {
        view.shadow.visible = false;
      }
    }
    // Rope.
    if (c.alive && c.hook) {
      view.rope.visible = true;
      fillRope(view.ropePos, c.x, c.y, c.z, c.hook.x, c.hook.y, c.hook.z);
    } else {
      view.rope.visible = false;
    }
    if (c.id === myId) me = { x: c.x, y: c.y, z: c.z, vx: c.vx, vz: c.vz };
  }

  // Orbs bob + spin (render-only flourish).
  for (let i = 0; i < world.orbs.length; i++) {
    const orb = world.orbs[i]!;
    const mesh = orbMeshes[i];
    if (!mesh) continue;
    mesh.position.set(orb.x, orb.y + Math.sin(now * 2.2 + i * 1.7) * 0.18, orb.z);
    mesh.rotation.y = now * 1.4 + i;
  }

  // Reticle.
  if (reticle) {
    if (aim && world.status === 'playing') {
      reticle.visible = true;
      reticle.position.set(aim.x, (me ? me.y : HOVER_H) - 0.7, aim.z);
    } else {
      reticle.visible = false;
    }
  }

  // Camera: tilted chase follow in a match; slow orbit in the menu.
  const k = 1 - Math.exp(-CAM_EASE * dt);
  if (world.status === 'menu' || !me) {
    menuAngle += dt * 0.08;
    scratchCam.set(Math.sin(menuAngle) * 58, 40, Math.cos(menuAngle) * 58);
    camera.position.lerp(scratchCam, camInit ? Math.min(1, dt * 0.8) : 1);
    camera.lookAt(0, 0, 0);
  } else {
    scratchCam.set(me.x, me.y + CAM_UP, me.z + CAM_BACK);
    if (!camInit) camera.position.copy(scratchCam);
    else camera.position.lerp(scratchCam, k);
    scratchLook.set(me.x + me.vx * 0.3, me.y, me.z + me.vz * 0.3);
    camera.lookAt(scratchLook);
    aimPlane.constant = -me.y; // keep pointer aim on the player's hover plane
  }
  camInit = true;

  renderer.render(scene, camera);
}

function islandUnder(world: World, x: number, z: number): number {
  // Render-side lookup mirrors world.islandAt but tolerates the dead margin
  // (shadow fades at the rim rather than popping).
  for (let i = 0; i < world.islands.length; i++) {
    const isl = world.islands[i]!;
    const live = liveOf(isl, world.t);
    if (live <= 0.02) continue;
    const dx = x - isl.x;
    const dz = z - isl.z;
    const r = isl.r * live;
    if (dx * dx + dz * dz < r * r) return i;
  }
  return -1;
}

function fillRope(
  attr: THREE.BufferAttribute,
  x0: number,
  y0: number,
  z0: number,
  x1: number,
  y1: number,
  z1: number,
): void {
  const n = 12;
  const dist = Math.hypot(x1 - x0, y1 - y0, z1 - z0);
  const sag = Math.min(1.6, dist * 0.05);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * sag;
    const z = z0 + (z1 - z0) * t;
    attr.setXYZ(i, x, y, z);
  }
  attr.needsUpdate = true;
}

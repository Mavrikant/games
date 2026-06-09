// Three.js scene: starfield, the destination planet, a galaxy portal, the 3D
// player/partner avatars and the glowing memory item. WebGL creation is guarded
// so a context failure (e.g. a locked-down environment) degrades to "no 3D"
// without ever throwing or console.error-ing — the DOM scenes stay playable and
// the headless smoke gate stays green.

import * as THREE from 'three';
import { buildAvatar, disposeAvatar } from './avatar3d';
import { PLANETS } from './data';
import { gen } from './state';
import type { Character } from './types';

export type SceneMode = 'space' | 'avatar' | 'final';

export const ITEM3D = { x: -3.2, z: 0.6 };
export const PORTAL3D = { x: 3.6, z: -3.2 };
export const START3D = { x: 0, z: 4.6 };

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let canvasEl: HTMLCanvasElement | null = null;
let webglOk = false;
let running = false;
let lastT = 0;
let mode: SceneMode = 'space';
let frameCb: ((dt: number) => void) | null = null;

let stars: THREE.Points | null = null;
let planet: THREE.Mesh | null = null;
let ground: THREE.Mesh | null = null;
let ambient: THREE.AmbientLight | null = null;
let portal: THREE.Group | null = null;
let item: THREE.Sprite | null = null;
let player: THREE.Group | null = null;
let partner: THREE.Group | null = null;
let avatarPreview: THREE.Group | null = null;
let orbit: { s: THREE.Sprite; r: number; sp: number; ph: number }[] = [];

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

export function isWebglOk(): boolean {
  return webglOk;
}

export function init(canvas: HTMLCanvasElement): boolean {
  canvasEl = canvas;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#0B0C10');
    camera = new THREE.PerspectiveCamera(52, 1, 0.1, 200);
    camera.position.set(0, 4.2, 9);
    camera.lookAt(0, 1, -1);
    buildBase();
    resize();
    webglOk = true;
  } catch {
    webglOk = false;
    renderer = null;
  }
  return webglOk;
}

function buildBase(): void {
  if (!scene) return;
  ambient = new THREE.AmbientLight(0xffffff, 0.55);
  const dir = new THREE.DirectionalLight(0xffffff, 0.9);
  dir.position.set(4, 8, 6);
  scene.add(ambient, dir);

  // Starfield
  const N = 900;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 40 + Math.random() * 50;
    const t = Math.random() * Math.PI * 2;
    const p = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(p) * Math.cos(t);
    pos[i * 3 + 1] = r * Math.cos(p);
    pos[i * 3 + 2] = r * Math.sin(p) * Math.sin(t);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  stars = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xfff7d0, size: 0.5, sizeAttenuation: true, transparent: true }));
  scene.add(stars);

  // Destination planet (background)
  planet = new THREE.Mesh(
    new THREE.SphereGeometry(4.2, 36, 24),
    new THREE.MeshStandardMaterial({ color: 0x8d8a99, roughness: 0.9, metalness: 0.1 }),
  );
  planet.position.set(-7, 5, -16);
  scene.add(planet);

  // Ground disc
  ground = new THREE.Mesh(
    new THREE.CircleGeometry(12, 48),
    new THREE.MeshStandardMaterial({ color: 0x2b3340, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0;
  scene.add(ground);

  buildPortal();
}

function buildPortal(): void {
  if (!scene) return;
  portal = new THREE.Group();
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.05, 0.34, 16, 40),
    new THREE.MeshBasicMaterial({ color: 0x00bcd4, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending }),
  );
  const inner = new THREE.Mesh(
    new THREE.CircleGeometry(0.95, 36),
    new THREE.MeshBasicMaterial({ color: 0xff4081, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
  );
  portal.add(inner, ring);
  portal.position.set(PORTAL3D.x, 1.25, PORTAL3D.z);
  portal.visible = false;
  scene.add(portal);
}

function emojiTexture(glyph: string): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 128;
  const ctx = cv.getContext('2d');
  if (ctx) {
    ctx.font = '96px serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, 64, 70);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

export function setFrameCallback(cb: ((dt: number) => void) | null): void {
  frameCb = cb;
}

export function setMode(m: SceneMode): void {
  mode = m;
  if (!scene || !camera) return;
  const space = m === 'space';
  if (planet) planet.visible = space;
  if (player) player.visible = space;
  if (avatarPreview) avatarPreview.visible = m === 'avatar';
  if (item) item.visible = space && item.userData.active === true;
  if (portal) portal.visible = space && portalReadyFlag;
  if (m === 'avatar') {
    camera.position.set(0, 1.42, 2.9);
    camera.lookAt(0, 1.12, 0);
    scene.background = new THREE.Color('#15131f');
  } else if (m === 'final') {
    camera.position.set(0, 3.2, 8);
    camera.lookAt(0, 1.2, -1);
  } else {
    camera.position.set(0, 4.2, 9);
    camera.lookAt(0, 1, -1);
    applyPlanetLook();
  }
}

let portalReadyFlag = false;
export function setPortalReady(v: boolean): void {
  portalReadyFlag = v;
  if (portal) portal.visible = mode === 'space' && v;
}

let planetIdx = 0;
function applyPlanetLook(): void {
  if (!scene || !planet || !ground || !ambient) return;
  const p = PLANETS[planetIdx]!;
  scene.background = new THREE.Color(p.gradBot);
  (planet.material as THREE.MeshStandardMaterial).color.set(p.planetColor);
  (ground.material as THREE.MeshStandardMaterial).color.set(p.ground);
  ambient.intensity = 0.5 + p.brightness * 0.5;
  if (stars) (stars.material as THREE.PointsMaterial).opacity = 1 - p.brightness * 0.9;
}

export function setPlanet(idx: number): void {
  planetIdx = idx;
  if (mode === 'space') applyPlanetLook();
}

export function setPlayer(c: Character): void {
  if (!scene) return;
  if (player) {
    scene.remove(player);
    disposeAvatar(player);
  }
  player = buildAvatar(c);
  player.position.set(START3D.x, 0, START3D.z);
  player.visible = mode === 'space';
  scene.add(player);
}

export function setPartner(c: Character): void {
  if (!scene) return;
  if (partner) {
    scene.remove(partner);
    disposeAvatar(partner);
  }
  partner = buildAvatar(c);
  partner.visible = false;
  scene.add(partner);
}

export function setAvatarPreview(c: Character): void {
  if (!scene) return;
  if (avatarPreview) {
    scene.remove(avatarPreview);
    disposeAvatar(avatarPreview);
  }
  avatarPreview = buildAvatar(c);
  avatarPreview.position.set(0, 0, 0);
  avatarPreview.visible = mode === 'avatar';
  scene.add(avatarPreview);
}

export function placePlayerStart(): void {
  if (player) {
    player.position.set(START3D.x, 0, START3D.z);
    player.rotation.y = 0;
  }
}

export function setPlayerPos(x: number, z: number, faceDx = 0, faceDz = 0): void {
  if (!player) return;
  player.position.x = x;
  player.position.z = z;
  if (faceDx !== 0 || faceDz !== 0) player.rotation.y = Math.atan2(faceDx, faceDz);
}

export function playerPos(): { x: number; z: number } {
  return player ? { x: player.position.x, z: player.position.z } : { ...START3D };
}

export function spawnItem(glyph: string): void {
  if (!scene) return;
  clearItem();
  const tex = emojiTexture(glyph);
  item = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true }));
  item.scale.set(1.1, 1.1, 1.1);
  item.position.set(ITEM3D.x, 1.2, ITEM3D.z);
  item.userData.active = true;
  item.visible = mode === 'space';
  scene.add(item);
}

export function clearItem(): void {
  if (item && scene) {
    scene.remove(item);
    const m = item.material as THREE.SpriteMaterial;
    m.map?.dispose();
    m.dispose();
  }
  item = null;
}

export function pointerToGround(clientX: number, clientY: number): { x: number; z: number } | null {
  if (!camera || !canvasEl) return null;
  const r = canvasEl.getBoundingClientRect();
  const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(groundPlane, hit)) return { x: hit.x, z: hit.z };
  return null;
}

// Earth reunion 3D scene: bright sky + green meadow, partner centered, the
// player nearby, and the collected items orbiting the partner.
export function buildFinal(glyphs: string[]): void {
  if (!scene || !ground) return;
  scene.background = new THREE.Color('#9fdcff');
  (ground.material as THREE.MeshStandardMaterial).color.set('#5fb85f');
  if (ambient) ambient.intensity = 1.0;
  if (stars) (stars.material as THREE.PointsMaterial).opacity = 0;
  if (partner) {
    partner.position.set(0, 0, -1);
    partner.rotation.y = 0;
    partner.visible = true;
  }
  if (player) {
    player.position.set(-1.3, 0, 1.1);
    player.rotation.y = 0.5;
    player.visible = true;
  }
  clearOrbit();
  glyphs.forEach((glyph, i) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: emojiTexture(glyph), transparent: true }));
    s.scale.set(0.7, 0.7, 0.7);
    orbit.push({ s, r: 1.5 + (i % 2) * 0.6, sp: 0.6 + i * 0.05, ph: (i / Math.max(glyphs.length, 1)) * Math.PI * 2 });
    scene!.add(s);
  });
}

function clearOrbit(): void {
  for (const o of orbit) {
    scene?.remove(o.s);
    const m = o.s.material as THREE.SpriteMaterial;
    m.map?.dispose();
    m.dispose();
  }
  orbit = [];
}

function frame(t: number, myGen: number): void {
  if (!running || !gen.isCurrent(myGen) || !renderer || !scene || !camera) return;
  const dt = Math.min(0.05, (t - lastT) / 1000 || 0);
  lastT = t;
  try {
    if (stars) stars.rotation.y += dt * 0.02;
    if (planet && planet.visible) planet.rotation.y += dt * 0.05;
    if (portal && portal.visible) {
      portal.rotation.z += dt * 1.2;
      (portal.children[0] as THREE.Mesh).rotation.z -= dt * 2.0;
    }
    if (item && item.visible) {
      item.position.y = 1.2 + Math.sin(t * 0.004) * 0.18;
      const s = 1.1 + Math.sin(t * 0.006) * 0.12;
      item.scale.set(s, s, s);
    }
    if (avatarPreview && avatarPreview.visible) avatarPreview.rotation.y += dt * 0.7;
    if (mode === 'final') {
      for (const o of orbit) {
        const a = t * 0.001 * o.sp + o.ph;
        o.s.position.set(Math.cos(a) * o.r, 1.3 + Math.sin(a * 1.4) * 0.3, -1 + Math.sin(a) * o.r);
      }
    }
    if (frameCb) frameCb(dt);
    renderer.render(scene, camera);
  } catch {
    running = false;
    return;
  }
  requestAnimationFrame((n) => frame(n, myGen));
}

export function startLoop(): void {
  if (running || !webglOk) return;
  running = true;
  lastT = performance.now();
  const myGen = gen.current();
  requestAnimationFrame((t) => frame(t, myGen));
}

export function stopLoop(): void {
  running = false;
}

export function restartLoop(): void {
  running = false;
  startLoop();
}

export function resize(): void {
  if (!renderer || !camera || !canvasEl) return;
  const w = Math.max(1, canvasEl.clientWidth);
  const h = Math.max(1, canvasEl.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

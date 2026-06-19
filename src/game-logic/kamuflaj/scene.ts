// Three.js rendering. The ONLY module that imports three. Renderer creation is
// guarded (yildizlararasi pattern): when WebGL is unavailable (headless smoke
// test, ancient devices) every function here no-ops and the simulation + HUD
// keep running. The render loop body in the entry wraps render() in try/catch
// so a lost context can never spam console.error.
//
// First-person: when a match is live the camera sits at the local player's eye
// and looks along (yaw, pitch); the local body is hidden. Otherwise an elevated
// orbit shows the whole multi-room map behind the menu/lobby.
//
// Look & feel: real-time shadow mapping, procedurally textured walls/floor with
// baseboards, cornices, corner pillars and door lintels (so no seams gap to the
// sky), lamp glow, drifting dust, a starlit dusk sky and atmospheric fog.

import * as THREE from 'three';
import {
  DOOR_H,
  DOOR_W,
  FLOOR_HUE,
  FOG_FAR,
  FOG_NEAR,
  GRID_COLS,
  GRID_ROWS,
  MAP_HD,
  MAP_HW,
  MOVE_SPEED,
  PROP_HUES,
  ROOM,
  SKY,
  WALL_H,
  WALL_HUE,
  WALL_T,
} from './constants';
import { buildDoorways } from './world';
import type { Player, PropSpec, WallSeg, World } from './types';

let webglOk = false;
let canvasEl: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;

let arenaGroup: THREE.Group | null = null;
let actorsGroup: THREE.Group | null = null;
let keyLight: THREE.DirectionalLight | null = null;
let lampLights: THREE.PointLight[] = [];
let motes: THREE.Points | null = null;

interface ActorView {
  group: THREE.Group;
  skin: THREE.MeshStandardMaterial;
  torso: THREE.Mesh; // breathing / bob
  legs: THREE.Group[]; // 2 hip-pivot groups (walk swing)
  arms: THREE.Group[]; // 2 shoulder-pivot groups
  shadow: THREE.Mesh;
  tongue: THREE.Mesh;
  tongueTip: THREE.Mesh;
  phase: number;
  isSeeker: boolean;
  // render-side smoothing + walk animation state
  rx: number;
  rz: number;
  ryaw: number;
  prevX: number;
  prevZ: number;
  walk: number;
  init: boolean;
}

let actorViews = new Map<string, ActorView>();

const scratchEye = new THREE.Vector3();
const scratchLook = new THREE.Vector3();
const scratchCam = new THREE.Vector3();

const MAX_LAMP_LIGHTS = 6;
const BASEBOARD_H = 0.55;
const CORNICE_H = 0.4;
const PILLAR_T = WALL_T * 1.9;

// First/third-person camera + render-smoothing tuning.
const FIG_SCALE = 0.7; // overall mini-figure size (smaller relative to the rooms)
const TP_DIST = 3.8; // third-person follow distance (hiders)
const TP_PIVOT_Y = 1.0; // height the follow camera orbits / looks at
const TAU_POS = 0.05; // render position smoothing time-constant (s)
const TAU_YAW = 0.07; // render yaw smoothing time-constant (s)
const FIG_EYE = 1.1; // first-person eye height (seekers), matched to FIG_SCALE
const TONGUE_Y = 0.85; // chest height the seeker's reach is thrown from

export function isWebglOk(): boolean {
  return webglOk;
}

// ---- procedural textures ----------------------------------------------------

function hsl(hue: number, s: number, l: number): THREE.Color {
  return new THREE.Color().setHSL((((hue % 360) + 360) % 360) / 360, s, l);
}
function hslCss(hue: number, s: number, l: number): string {
  return `hsl(${(((hue % 360) + 360) % 360).toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;
}

function newCanvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  return [c, ctx];
}

function tx(c: HTMLCanvasElement, repeat: number, srgb: boolean): THREE.Texture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = 4;
  return t;
}

function makeGradientTexture(top: string, mid: string, bottom: string): THREE.Texture | null {
  const made = newCanvas(8);
  if (!made) return null;
  const [c, ctx] = made;
  const g = ctx.createLinearGradient(0, 0, 0, 8);
  g.addColorStop(0, top);
  g.addColorStop(0.55, mid);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Warm wooden floor: planks + grout + worn speckle, with a matching bump map.
function makeFloorTextures(): { map: THREE.Texture; bump: THREE.Texture } | null {
  const made = newCanvas(512);
  if (!made) return null;
  const [c, ctx] = made;
  ctx.fillStyle = hslCss(FLOOR_HUE, 0.34, 0.36);
  ctx.fillRect(0, 0, 512, 512);
  const planks = 8;
  const ph = 512 / planks;
  for (let i = 0; i < planks; i++) {
    const shade = 0.3 + ((i * 37) % 9) / 100;
    ctx.fillStyle = hslCss(FLOOR_HUE + ((i * 13) % 7) - 3, 0.34, shade);
    ctx.fillRect(0, i * ph, 512, ph - 1);
    // grain streaks
    for (let g = 0; g < 26; g++) {
      ctx.strokeStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.05})`;
      ctx.lineWidth = 1;
      const y = i * ph + Math.random() * ph;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(160, y + (Math.random() * 6 - 3), 360, y + (Math.random() * 6 - 3), 512, y);
      ctx.stroke();
    }
  }
  // grout lines between planks
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  for (let i = 1; i < planks; i++) ctx.fillRect(0, i * ph - 1.5, 512, 2.5);
  // stagger short vertical seams
  for (let i = 0; i < planks; i++) {
    const x = ((i * 191) % 512);
    ctx.fillRect(x, i * ph, 2.5, ph);
  }
  // worn highlights
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = `rgba(255,240,210,${Math.random() * 0.05})`;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 1.5, 1.5);
  }

  const bumpMade = newCanvas(512);
  let bump: THREE.Texture;
  if (bumpMade) {
    const [bc, bctx] = bumpMade;
    bctx.fillStyle = '#808080';
    bctx.fillRect(0, 0, 512, 512);
    bctx.fillStyle = '#202020';
    for (let i = 1; i < planks; i++) bctx.fillRect(0, i * ph - 1.5, 512, 2.5);
    for (let i = 0; i < planks; i++) bctx.fillRect((i * 191) % 512, i * ph, 2.5, ph);
    bump = tx(bc, 6, false);
  } else {
    bump = tx(c, 6, false);
  }
  return { map: tx(c, 6, true), bump };
}

// Plaster wall with faint panel lines + a bump map for relief.
function makeWallTextures(): { map: THREE.Texture; bump: THREE.Texture } | null {
  const made = newCanvas(256);
  if (!made) return null;
  const [c, ctx] = made;
  ctx.fillStyle = hslCss(WALL_HUE, 0.16, 0.42);
  ctx.fillRect(0, 0, 256, 256);
  // mottled plaster
  for (let i = 0; i < 2600; i++) {
    const v = Math.random();
    ctx.fillStyle = `rgba(${v > 0.5 ? '255,255,255' : '0,0,0'},${Math.random() * 0.05})`;
    ctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
  // subtle vertical panel seams
  ctx.strokeStyle = 'rgba(0,0,0,0.18)';
  ctx.lineWidth = 1.5;
  for (const x of [64, 128, 192]) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  const bumpMade = newCanvas(256);
  let bump: THREE.Texture;
  if (bumpMade) {
    const [bc, bctx] = bumpMade;
    bctx.fillStyle = '#7a7a7a';
    bctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2200; i++) {
      const v = Math.random() > 0.5 ? 255 : 40;
      bctx.fillStyle = `rgba(${v},${v},${v},0.06)`;
      bctx.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }
    bctx.strokeStyle = 'rgba(20,20,20,0.6)';
    for (const x of [64, 128, 192]) {
      bctx.beginPath();
      bctx.moveTo(x, 0);
      bctx.lineTo(x, 256);
      bctx.stroke();
    }
    bump = tx(bc, 1, false);
    bump.repeat.set(1, 1);
  } else {
    bump = tx(c, 1, false);
  }
  const map = tx(c, 1, true);
  map.repeat.set(1, 1);
  return { map, bump };
}

let scaleBump: THREE.Texture | null = null;
function getScaleBump(): THREE.Texture | null {
  if (scaleBump) return scaleBump;
  const made = newCanvas(128);
  if (!made) return null;
  const [c, ctx] = made;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, 128, 128);
  // scaly cells
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const cx = x * 8 + (y % 2) * 4 + 4;
      const cy = y * 8 + 4;
      const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, 4.5);
      g.addColorStop(0, 'rgba(255,255,255,0.6)');
      g.addColorStop(1, 'rgba(60,60,60,0.6)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  scaleBump = new THREE.CanvasTexture(c);
  scaleBump.wrapS = scaleBump.wrapT = THREE.RepeatWrapping;
  scaleBump.repeat.set(3, 4);
  return scaleBump;
}

let blobTexture: THREE.Texture | null = null;
function getBlobTexture(): THREE.Texture | null {
  if (blobTexture) return blobTexture;
  const made = newCanvas(64);
  if (!made) return null;
  const [c, ctx] = made;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  blobTexture = new THREE.CanvasTexture(c);
  return blobTexture;
}

let floorTex: { map: THREE.Texture; bump: THREE.Texture } | null = null;
let wallTex: { map: THREE.Texture; bump: THREE.Texture } | null = null;

// ---- init -------------------------------------------------------------------

export function initScene(canvas: HTMLCanvasElement, isCoarse: boolean): boolean {
  canvasEl = canvas;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isCoarse ? 1.5 : 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    scene = new THREE.Scene();
    const bg = makeGradientTexture('#1b2740', '#222a3a', '#0a0d14');
    scene.background = bg ?? new THREE.Color(SKY);
    scene.fog = new THREE.Fog(0x10141c, FOG_NEAR, FOG_FAR);

    camera = new THREE.PerspectiveCamera(72, 1, 0.05, 320);
    camera.position.set(0, 30, 30);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.HemisphereLight(0xb9c7ff, 0x2a2118, 0.62));

    keyLight = new THREE.DirectionalLight(0xe6edff, 1.55);
    keyLight.position.set(34, 60, 24);
    keyLight.castShadow = true;
    const sm = isCoarse ? 1024 : 2048;
    keyLight.shadow.mapSize.set(sm, sm);
    keyLight.shadow.camera.near = 2;
    keyLight.shadow.camera.far = 160;
    keyLight.shadow.camera.left = -MAP_HW - 6;
    keyLight.shadow.camera.right = MAP_HW + 6;
    keyLight.shadow.camera.top = MAP_HD + 6;
    keyLight.shadow.camera.bottom = -MAP_HD - 6;
    keyLight.shadow.bias = -0.0004;
    keyLight.shadow.normalBias = 0.7;
    scene.add(keyLight);
    scene.add(keyLight.target);

    const fill = new THREE.DirectionalLight(0x8fa6ff, 0.3);
    fill.position.set(-28, 22, -22);
    scene.add(fill);

    arenaGroup = new THREE.Group();
    actorsGroup = new THREE.Group();
    scene.add(arenaGroup, actorsGroup);

    lampLights = [];
    for (let i = 0; i < MAX_LAMP_LIGHTS; i++) {
      const pl = new THREE.PointLight(0xffd9a0, 0, 22, 2);
      pl.visible = false;
      scene.add(pl);
      lampLights.push(pl);
    }

    addStars(isCoarse ? 320 : 700);

    const moteN = isCoarse ? 90 : 180;
    const mpos = new Float32Array(moteN * 3);
    for (let i = 0; i < moteN; i++) {
      mpos[i * 3] = (Math.random() * 2 - 1) * MAP_HW;
      mpos[i * 3 + 1] = 0.5 + Math.random() * (WALL_H + 1);
      mpos[i * 3 + 2] = (Math.random() * 2 - 1) * MAP_HD;
    }
    const mgeo = new THREE.BufferGeometry();
    mgeo.setAttribute('position', new THREE.BufferAttribute(mpos, 3));
    motes = new THREE.Points(
      mgeo,
      new THREE.PointsMaterial({ color: 0xfff3d6, size: 0.09, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    scene.add(motes);

    resize();
    webglOk = true;
  } catch {
    webglOk = false;
    renderer = null;
  }
  return webglOk;
}

function addStars(n: number): void {
  if (!scene) return;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = 180 + Math.random() * 60;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.random() * Math.PI * 0.5; // upper hemisphere
    pos[i * 3] = Math.cos(th) * Math.sin(ph + 0.1) * r;
    pos[i * 3 + 1] = Math.cos(ph) * r * 0.7 + 20;
    pos[i * 3 + 2] = Math.sin(th) * Math.sin(ph + 0.1) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const stars = new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: 0xdfe8ff, size: 1.1, sizeAttenuation: true, transparent: true, opacity: 0.9, depthWrite: false, fog: false }),
  );
  scene.add(stars);
}

export function resize(): void {
  if (!renderer || !camera || !canvasEl) return;
  const w = Math.max(1, canvasEl.clientWidth);
  const h = Math.max(1, canvasEl.clientHeight);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---- builders ---------------------------------------------------------------

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

function jitter(seed: number): () => number {
  let a = (seed | 0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addBlob(group: THREE.Group, r: number): void {
  const tex = getBlobTexture();
  if (!tex) return;
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(r * 2.6, r * 2.6),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.5 }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.y = 0.03;
  group.add(blob);
}

function shadeMesh(mesh: THREE.Mesh, cast: boolean, receive: boolean): THREE.Mesh {
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

function makeProp(p: PropSpec): THREE.Object3D {
  const color = hsl(p.hue, 0.52, 0.5);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.05, flatShading: true });
  const grp = new THREE.Group();
  grp.position.set(p.x, 0, p.z);
  const rnd = jitter(p.seed);

  if (p.kind === 'barrel') {
    const body = shadeMesh(new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 0.92, p.h, 18), mat), true, true);
    body.position.y = p.h / 2;
    grp.add(body);
    const bandMat = new THREE.MeshStandardMaterial({ color: '#3a3128', roughness: 0.5, metalness: 0.5 });
    for (const fy of [0.22, 0.78]) {
      const band = shadeMesh(new THREE.Mesh(new THREE.TorusGeometry(p.r * 1.01, 0.06, 6, 20), bandMat), true, false);
      band.rotation.x = Math.PI / 2;
      band.position.y = p.h * fy;
      grp.add(band);
    }
  } else if (p.kind === 'rock') {
    const geo = new THREE.DodecahedronGeometry(p.r, 0);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const k = 0.82 + rnd() * 0.36;
      pos.setXYZ(i, pos.getX(i) * k, Math.max(0, pos.getY(i)) * k * 0.85, pos.getZ(i) * k);
    }
    geo.computeVertexNormals();
    const rock = shadeMesh(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true })), true, true);
    rock.position.y = p.r * 0.5;
    grp.add(rock);
  } else if (p.kind === 'plant') {
    const pot = shadeMesh(
      new THREE.Mesh(
        new THREE.CylinderGeometry(p.r * 0.6, p.r * 0.45, p.h * 0.35, 12),
        new THREE.MeshStandardMaterial({ color: '#8a5a3a', roughness: 0.85, flatShading: true }),
      ),
      true,
      true,
    );
    pot.position.y = p.h * 0.175;
    grp.add(pot);
    for (let i = 0; i < 6; i++) {
      const leafMat = new THREE.MeshStandardMaterial({ color: hsl(p.hue, 0.5, 0.42 + rnd() * 0.18), roughness: 0.65, flatShading: true });
      const leaf = shadeMesh(new THREE.Mesh(new THREE.ConeGeometry(p.r * 0.42, p.h * (0.7 + rnd() * 0.5), 5), leafMat), true, false);
      const a = (i / 6) * Math.PI * 2 + rnd();
      leaf.position.set(Math.cos(a) * p.r * 0.3, p.h * 0.55, Math.sin(a) * p.r * 0.3);
      leaf.rotation.set(0.5 - rnd(), a, 0.6 - rnd());
      grp.add(leaf);
    }
  } else if (p.kind === 'lamp') {
    const post = shadeMesh(
      new THREE.Mesh(
        new THREE.CylinderGeometry(p.r * 0.16, p.r * 0.24, p.h, 10),
        new THREE.MeshStandardMaterial({ color: '#2c2f37', roughness: 0.4, metalness: 0.7, flatShading: true }),
      ),
      true,
      true,
    );
    post.position.y = p.h / 2;
    grp.add(post);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(p.r * 0.5, 16, 12),
      new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.8, roughness: 0.25 }),
    );
    bulb.position.y = p.h + p.r * 0.3;
    grp.add(bulb);
  } else if (p.kind === 'bush') {
    const leafMat = new THREE.MeshStandardMaterial({ color: hsl(p.hue, 0.5, 0.4), roughness: 0.88, flatShading: true });
    const clumps = 8;
    for (let i = 0; i < clumps; i++) {
      const a = (i / clumps) * Math.PI * 2 + rnd();
      const rad = p.r * (0.25 + rnd() * 0.5);
      const cl = shadeMesh(new THREE.Mesh(new THREE.IcosahedronGeometry(p.r * (0.4 + rnd() * 0.3), 0), leafMat), true, true);
      cl.position.set(Math.cos(a) * rad, p.h * (0.35 + rnd() * 0.4), Math.sin(a) * rad);
      cl.rotation.set(rnd() * 3, rnd() * 3, rnd() * 3);
      grp.add(cl);
    }
    const crown = shadeMesh(new THREE.Mesh(new THREE.IcosahedronGeometry(p.r * 0.55, 0), leafMat), true, true);
    crown.position.y = p.h * 0.8;
    grp.add(crown);
  } else if (p.kind === 'column') {
    const stoneMat = new THREE.MeshStandardMaterial({ color: hsl(p.hue, 0.16, 0.58), roughness: 0.85, flatShading: false });
    const shaft = shadeMesh(new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.62, p.r * 0.7, p.h, 16), stoneMat), true, true);
    shaft.position.y = p.h / 2;
    grp.add(shaft);
    const base = shadeMesh(new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r, 0.45, 16), stoneMat), true, true);
    base.position.y = 0.22;
    grp.add(base);
    const capital = shadeMesh(new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.95, p.r * 0.78, 0.5, 16), stoneMat), true, false);
    capital.position.y = p.h - 0.25;
    grp.add(capital);
  } else if (p.kind === 'shelf') {
    const woodMat = new THREE.MeshStandardMaterial({ color: hsl(p.hue, 0.42, 0.36), roughness: 0.72, flatShading: true });
    const w = p.r * 1.8;
    const d = p.r * 1.05;
    const carcass = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(w, p.h, d), woodMat), true, true);
    carcass.position.set(0, p.h / 2, 0);
    grp.add(carcass);
    const slatMat = new THREE.MeshStandardMaterial({ color: hsl(p.hue, 0.3, 0.24), roughness: 0.7 });
    for (let s = 1; s <= 3; s++) {
      const slat = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.1, d + 0.08), slatMat), true, false);
      slat.position.set(0, (p.h * s) / 4, 0);
      grp.add(slat);
    }
    for (let b = 0; b < 4; b++) {
      const bk = shadeMesh(
        new THREE.Mesh(
          new THREE.BoxGeometry(0.16 + rnd() * 0.1, 0.4 + rnd() * 0.25, d * 0.6),
          new THREE.MeshStandardMaterial({ color: hsl(PROP_HUES[Math.floor(rnd() * PROP_HUES.length)]!, 0.5, 0.5), roughness: 0.6 }),
        ),
        true,
        false,
      );
      const shelfY = (p.h * (1 + Math.floor(rnd() * 3))) / 4 + 0.27;
      bk.position.set(-w / 2 + 0.3 + b * (w / 4.5), shelfY, 0);
      grp.add(bk);
    }
  } else if (p.kind === 'urn') {
    const clayMat = new THREE.MeshStandardMaterial({ color: hsl(p.hue, 0.42, 0.46), roughness: 0.78, metalness: 0.05 });
    const pts: THREE.Vector2[] = [
      new THREE.Vector2(0.02, 0),
      new THREE.Vector2(p.r * 0.5, 0),
      new THREE.Vector2(p.r * 0.92, p.h * 0.28),
      new THREE.Vector2(p.r, p.h * 0.46),
      new THREE.Vector2(p.r * 0.62, p.h * 0.72),
      new THREE.Vector2(p.r * 0.5, p.h * 0.86),
      new THREE.Vector2(p.r * 0.72, p.h * 0.96),
      new THREE.Vector2(p.r * 0.6, p.h),
    ];
    const urn = shadeMesh(new THREE.Mesh(new THREE.LatheGeometry(pts, 20), clayMat), true, true);
    grp.add(urn);
  } else if (p.kind === 'statue') {
    const stoneMat = new THREE.MeshStandardMaterial({ color: hsl(p.hue, 0.1, 0.6), roughness: 0.92, flatShading: true });
    const ped = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(p.r * 1.5, p.h * 0.24, p.r * 1.5), stoneMat), true, true);
    ped.position.y = p.h * 0.12;
    grp.add(ped);
    const robe = shadeMesh(new THREE.Mesh(new THREE.ConeGeometry(p.r * 0.72, p.h * 0.58, 12), stoneMat), true, true);
    robe.position.y = p.h * 0.24 + p.h * 0.29;
    grp.add(robe);
    const headS = shadeMesh(new THREE.Mesh(new THREE.SphereGeometry(p.r * 0.34, 14, 12), stoneMat), true, false);
    headS.position.y = p.h * 0.24 + p.h * 0.58 + p.r * 0.28;
    grp.add(headS);
  } else if (p.kind === 'table') {
    const woodMat = new THREE.MeshStandardMaterial({ color: hsl(p.hue, 0.4, 0.4), roughness: 0.7, flatShading: true });
    const w = p.r * 1.9;
    const d = p.r * 1.35;
    const top = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(w, 0.18, d), woodMat), true, true);
    top.position.y = p.h;
    grp.add(top);
    const legGeo = new THREE.CylinderGeometry(0.1, 0.09, p.h, 8);
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) {
      const leg = shadeMesh(new THREE.Mesh(legGeo, woodMat), true, false);
      leg.position.set(sx * (w / 2 - 0.18), p.h / 2, sz * (d / 2 - 0.18));
      grp.add(leg);
    }
  } else {
    const box = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(p.r * 1.7, p.h, p.r * 1.7), mat), true, true);
    box.position.y = p.h / 2;
    grp.add(box);
    const frameMat = new THREE.MeshStandardMaterial({ color: hsl(p.hue, 0.45, 0.32), roughness: 0.75, flatShading: true });
    const w = p.r * 1.74;
    for (const fy of [0.08, p.h - 0.08]) {
      const f = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, w), frameMat), true, false);
      f.position.y = fy;
      grp.add(f);
    }
  }

  addBlob(grp, p.r * 1.1);
  return grp;
}

// Wall built as a base box + baseboard + cornice cap, all casting/receiving.
function makeWall(group: THREE.Group, w: WallSeg): void {
  const vertical = w.ax === w.bx;
  const len = (vertical ? Math.abs(w.bz - w.az) : Math.abs(w.bx - w.ax)) + WALL_T;
  const mid = new THREE.Vector3((w.ax + w.bx) / 2, 0, (w.az + w.bz) / 2);
  const dimX = vertical ? WALL_T : len;
  const dimZ = vertical ? len : WALL_T;

  const wallMat = new THREE.MeshStandardMaterial({
    color: hsl(WALL_HUE, 0.2, 0.46),
    roughness: 0.94,
    metalness: 0.02,
    map: wallTex?.map ?? null,
    bumpMap: wallTex?.bump ?? null,
    bumpScale: 0.04,
  });
  // Sink the base slightly below the floor (y0 = -0.12) so no wall face is
  // coplanar with the floor plane (pitfall: z-fighting-at-wall-base).
  const y0 = -0.12;
  const bodyH = WALL_H - y0;
  const body = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(dimX, bodyH, dimZ), wallMat), true, true);
  body.position.set(mid.x, y0 + bodyH / 2, mid.z);
  group.add(body);

  const baseMat = new THREE.MeshStandardMaterial({ color: hsl(WALL_HUE, 0.18, 0.26), roughness: 0.85 });
  const baseH = BASEBOARD_H - y0;
  const base = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(dimX + 0.16, baseH, dimZ + 0.16), baseMat), true, true);
  base.position.set(mid.x, y0 + baseH / 2, mid.z);
  group.add(base);

  const capMat = new THREE.MeshStandardMaterial({ color: hsl(WALL_HUE, 0.16, 0.58), roughness: 0.7 });
  const cap = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(dimX + 0.2, CORNICE_H, dimZ + 0.2), capMat), true, false);
  cap.position.set(mid.x, WALL_H - CORNICE_H / 2, mid.z);
  group.add(cap);
}

// Square corner pillar at every grid-line intersection — hides wall seams and
// gives the rooms architectural structure.
function makePillar(group: THREE.Group, x: number, z: number): void {
  const mat = new THREE.MeshStandardMaterial({
    color: hsl(WALL_HUE, 0.22, 0.4),
    roughness: 0.9,
    map: wallTex?.map ?? null,
    bumpMap: wallTex?.bump ?? null,
    bumpScale: 0.04,
  });
  const shaftH = WALL_H + 0.3 + 0.12;
  const shaft = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(PILLAR_T, shaftH, PILLAR_T), mat), true, true);
  shaft.position.set(x, -0.12 + shaftH / 2, z);
  group.add(shaft);
  const capMat = new THREE.MeshStandardMaterial({ color: hsl(WALL_HUE, 0.16, 0.6), roughness: 0.6 });
  const cap = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(PILLAR_T + 0.3, 0.45, PILLAR_T + 0.3), capMat), true, false);
  cap.position.set(x, WALL_H + 0.3 + 0.1, z);
  group.add(cap);
}

// Lintel above a doorway so the opening reads as a doorway and nothing gaps to
// the sky over the passage.
function makeLintel(group: THREE.Group, x: number, z: number, horizontal: boolean): void {
  const h = WALL_H - DOOR_H;
  const mat = new THREE.MeshStandardMaterial({
    color: hsl(WALL_HUE, 0.2, 0.44),
    roughness: 0.94,
    map: wallTex?.map ?? null,
    bumpMap: wallTex?.bump ?? null,
    bumpScale: 0.04,
  });
  // The lintel overlaps the flanking wall segments; make it slightly THINNER
  // than the wall so its side faces nest inside the wall faces instead of
  // sitting coplanar (pitfall: z-fighting-over-doorway).
  const thin = WALL_T * 0.82;
  const dimX = horizontal ? DOOR_W + 0.4 : thin;
  const dimZ = horizontal ? thin : DOOR_W + 0.4;
  const lintel = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(dimX, h, dimZ), mat), true, true);
  lintel.position.set(x, DOOR_H + h / 2, z);
  group.add(lintel);
  // a slim header beam under the lintel for trim
  const beamMat = new THREE.MeshStandardMaterial({ color: hsl(WALL_HUE, 0.18, 0.3), roughness: 0.7 });
  const beam = shadeMesh(
    new THREE.Mesh(new THREE.BoxGeometry(dimX + 0.1, 0.22, dimZ + 0.1), beamMat),
    true,
    false,
  );
  beam.position.set(x, DOOR_H - 0.05, z);
  group.add(beam);
}

// A stylised mini-figure person. All body parts live in a `body` sub-group
// scaled by FIG_SCALE so the whole figure is small relative to the rooms; the
// tongue/tag reach stays on the unscaled group so its length still matches the
// simulation. The outfit shares the recolouring `skin` material so a hider
// blends/fades as one; only the eyes (and the seeker's red cap) stay fixed.
function makeFigure(hue: number, isSeeker: boolean): ActorView {
  const group = new THREE.Group();
  const body = new THREE.Group();
  const bump = getScaleBump();
  const skin = new THREE.MeshStandardMaterial({
    color: hsl(hue, 0.6, 0.52),
    roughness: 0.55,
    metalness: 0.04,
    transparent: true,
    opacity: 1,
    // depthWrite keeps a faded hider a coherent ghost instead of letting its own
    // inner faces blend through (pitfall: transparent-self-overlap).
    depthWrite: true,
    bumpMap: bump ?? null,
    bumpScale: 0.01,
  });

  const legH = 0.72;
  const hipY = 0.78;
  const shoulderY = 1.22;

  // Pelvis + torso (slightly tapered).
  const pelvis = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.26, 0.3), skin), false, true);
  pelvis.position.y = hipY + 0.04;
  body.add(pelvis);
  const torso = shadeMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.27, 0.23, 0.5, 12), skin), false, true);
  torso.scale.z = 0.78;
  torso.position.y = 1.02;
  body.add(torso);
  const chest = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.14, 0.32), skin), false, true);
  chest.position.y = shoulderY - 0.04;
  body.add(chest);
  const collar = shadeMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.12, 10), skin), false, false);
  collar.position.y = shoulderY + 0.05;
  body.add(collar);

  // Head + face.
  const head = shadeMesh(new THREE.Mesh(new THREE.SphereGeometry(0.22, 18, 16), skin), false, true);
  head.scale.set(1, 1.08, 1);
  head.position.y = 1.55;
  body.add(head);
  const eyeMat = new THREE.MeshBasicMaterial({ color: '#15181f' });
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 8), eyeMat);
    eye.position.set(sx * 0.082, 1.57, 0.2);
    body.add(eye);
  }
  if (isSeeker) {
    const capMat = new THREE.MeshStandardMaterial({ color: '#ef4444', roughness: 0.5 });
    const cap = shadeMesh(new THREE.Mesh(new THREE.SphereGeometry(0.235, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.5), capMat), true, false);
    cap.position.y = 1.6;
    body.add(cap);
    const brim = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.22), capMat), true, false);
    brim.position.set(0, 1.59, 0.2);
    body.add(brim);
  }

  // Arms — shoulder-pivot groups so they swing.
  const arms: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const sh = new THREE.Group();
    sh.position.set(sx * 0.34, shoulderY, 0);
    const upper = shadeMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.075, 0.42, 8), skin), false, false);
    upper.position.y = -0.21;
    sh.add(upper);
    const fore = shadeMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.065, 0.36, 8), skin), false, false);
    fore.position.y = -0.55;
    sh.add(fore);
    const hand = shadeMesh(new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 8), skin), false, false);
    hand.position.y = -0.74;
    sh.add(hand);
    sh.rotation.z = sx * 0.12;
    body.add(sh);
    arms.push(sh);
  }

  // Legs — hip-pivot groups so they stride.
  const legs: THREE.Group[] = [];
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(sx * 0.15, hipY, 0);
    const thigh = shadeMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, legH * 0.55, 8), skin), false, true);
    thigh.position.y = -legH * 0.27;
    hip.add(thigh);
    const calf = shadeMesh(new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.08, legH * 0.5, 8), skin), false, true);
    calf.position.y = -legH * 0.74;
    hip.add(calf);
    const foot = shadeMesh(new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.12, 0.3), skin), false, true);
    foot.position.set(0, -legH + 0.02, 0.06);
    hip.add(foot);
    body.add(hip);
    legs.push(hip);
  }

  body.scale.setScalar(FIG_SCALE);
  group.add(body);

  // Contact shadow sits on the unscaled group, sized to the scaled footprint.
  const blobTex = getBlobTexture();
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.5 * FIG_SCALE, 1.5 * FIG_SCALE),
    new THREE.MeshBasicMaterial({ map: blobTex ?? undefined, color: 0x000000, transparent: true, opacity: 0.42, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  group.add(shadow);

  // Seeker's "tag" reach (kept from the tongue mechanic) — stays at world scale
  // so its length matches the simulation's reach.
  const tongue = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 1, 6),
    new THREE.MeshBasicMaterial({ color: '#f43f5e' }),
  );
  tongue.visible = false;
  group.add(tongue);
  const tongueTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.14, 10, 10),
    new THREE.MeshStandardMaterial({ color: '#fb7185', emissive: '#f43f5e', emissiveIntensity: 0.5 }),
  );
  tongueTip.visible = false;
  group.add(tongueTip);

  return {
    group,
    skin,
    torso,
    legs,
    arms,
    shadow,
    tongue,
    tongueTip,
    phase: Math.random() * Math.PI * 2,
    isSeeker,
    rx: 0,
    rz: 0,
    ryaw: 0,
    prevX: 0,
    prevZ: 0,
    walk: 0,
    init: false,
  };
}

/** Distance from (px,pz) along a unit ray (dx,dz) to the nearest wall, for the
 *  third-person camera to avoid clipping through walls. Infinity if clear. */
function rayWallDist(world: World, px: number, pz: number, dx: number, dz: number): number {
  let best = Infinity;
  for (const w of world.walls) {
    if (w.ax === w.bx) {
      if (dx === 0) continue;
      const t = (w.ax - px) / dx;
      if (t <= 0) continue;
      const zh = pz + dz * t;
      if (zh >= Math.min(w.az, w.bz) - WALL_T && zh <= Math.max(w.az, w.bz) + WALL_T) best = Math.min(best, t);
    } else {
      if (dz === 0) continue;
      const t = (w.az - pz) / dz;
      if (t <= 0) continue;
      const xh = px + dx * t;
      if (xh >= Math.min(w.ax, w.bx) - WALL_T && xh <= Math.max(w.ax, w.bx) + WALL_T) best = Math.min(best, t);
    }
  }
  return best;
}

export function buildArena(world: World): void {
  if (!webglOk || !arenaGroup || !actorsGroup) return;
  if (!floorTex) floorTex = makeFloorTextures();
  if (!wallTex) wallTex = makeWallTextures();

  disposeGroup(arenaGroup);

  const floorMat = new THREE.MeshStandardMaterial({
    map: floorTex?.map ?? null,
    bumpMap: floorTex?.bump ?? null,
    bumpScale: 0.03,
    color: floorTex ? 0xffffff : hsl(FLOOR_HUE, 0.32, 0.4),
    roughness: 0.92,
    metalness: 0.02,
  });
  const floor = shadeMesh(new THREE.Mesh(new THREE.PlaneGeometry(MAP_HW * 2, MAP_HD * 2), floorMat), false, true);
  floor.rotation.x = -Math.PI / 2;
  arenaGroup.add(floor);

  for (const w of world.walls) makeWall(arenaGroup, w);
  for (let cx = 0; cx <= GRID_COLS; cx++) {
    for (let cz = 0; cz <= GRID_ROWS; cz++) {
      makePillar(arenaGroup, -MAP_HW + ROOM * cx, -MAP_HD + ROOM * cz);
    }
  }
  for (const d of buildDoorways()) makeLintel(arenaGroup, d.x, d.z, d.horizontal);

  for (const p of world.props) arenaGroup.add(makeProp(p));

  const lamps = world.props.filter((p) => p.kind === 'lamp');
  for (let i = 0; i < lampLights.length; i++) {
    const pl = lampLights[i]!;
    const lp = lamps[i];
    if (lp) {
      pl.visible = true;
      pl.color.copy(hsl(lp.hue, 0.5, 0.6));
      pl.intensity = 16;
      pl.position.set(lp.x, lp.h + lp.r * 0.3, lp.z);
    } else {
      pl.visible = false;
      pl.intensity = 0;
    }
  }

  disposeGroup(actorsGroup);
  actorViews = new Map();
  for (const p of world.players) {
    const view = makeFigure(p.bodyHue, p.role === 'seeker');
    actorsGroup.add(view.group);
    actorViews.set(p.id, view);
  }
}

// ---- per-frame sync ---------------------------------------------------------

let camInit = false;
let menuAngle = 0;

export function resetCamera(): void {
  camInit = false;
}

export function render(
  world: World,
  dt: number,
  myId: string,
  look: { yaw: number; pitch: number },
): void {
  if (!webglOk || !renderer || !scene || !camera) return;
  const now = performance.now() / 1000;
  if (motes) motes.rotation.y += dt * 0.012;

  const playing = world.status === 'prep' || world.status === 'hunt';
  let me: Player | null = null;
  let meView: ActorView | null = null;
  for (const p of world.players) if (p.id === myId) me = p;
  const fpvSelf = playing && !!me && me.role === 'seeker';

  const aPos = 1 - Math.exp(-dt / TAU_POS);
  const aYaw = 1 - Math.exp(-dt / TAU_YAW);

  for (const p of world.players) {
    const view = actorViews.get(p.id);
    if (!view) continue;
    const isMe = p.id === myId;
    if (isMe) meView = view;

    // Initialise / advance the smoothed render transform (frame-rate
    // independent) so motion stays fluid on any refresh rate and remote
    // players glide between sparse snapshots (pitfall: stepped-remote-motion).
    if (!view.init) {
      view.rx = p.x;
      view.rz = p.z;
      view.ryaw = p.yaw;
      view.prevX = p.x;
      view.prevZ = p.z;
      view.init = true;
    }
    view.rx += (p.x - view.rx) * aPos;
    view.rz += (p.z - view.rz) * aPos;
    const dyaw = ((p.yaw - view.ryaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    view.ryaw += dyaw * aYaw;

    const hideSelf = isMe && fpvSelf;
    view.group.visible = !hideSelf;
    if (hideSelf) {
      view.prevX = view.rx;
      view.prevZ = view.rz;
      continue;
    }

    // Walk cycle driven by actual (rendered) speed → arms/legs swing, body bobs.
    const spd = Math.hypot(view.rx - view.prevX, view.rz - view.prevZ) / Math.max(dt, 1e-3);
    view.prevX = view.rx;
    view.prevZ = view.rz;
    const moveAmt = Math.min(1, spd / MOVE_SPEED);
    view.walk += (0.9 + moveAmt * 9) * dt;
    const swing = Math.sin(view.walk) * (0.15 + 0.55 * moveAmt);
    view.legs[0]!.rotation.x = swing;
    view.legs[1]!.rotation.x = -swing;
    view.arms[0]!.rotation.x = -swing * 0.8;
    view.arms[1]!.rotation.x = swing * 0.8;
    const bob = Math.abs(Math.sin(view.walk)) * 0.06 * moveAmt;
    view.torso.scale.y = 1 + (1 - moveAmt) * Math.sin((now + view.phase) * 2) * 0.03;

    view.group.position.set(view.rx, p.caught ? 0.1 : bob, view.rz);
    view.group.rotation.y = view.ryaw;
    view.group.rotation.z = p.caught ? Math.PI * 0.42 : 0;

    view.skin.color.copy(hsl(p.bodyHue, p.role === 'seeker' ? 0.5 : 0.62, p.caught ? 0.3 : 0.52));
    if (p.role === 'hider' && !p.caught) {
      view.skin.emissive.copy(hsl(p.bodyHue, 0.7, 0.5));
      view.skin.emissiveIntensity = 0.03 + Math.max(0, 0.1 * (1 - p.visible)) * (0.6 + 0.4 * Math.sin((now + view.phase) * 5));
    } else {
      view.skin.emissiveIntensity = 0;
    }

    let opacity = 1;
    if (p.role === 'hider' && !p.caught) opacity = Math.max(0.12, p.visible);
    view.skin.opacity = opacity;
    (view.shadow.material as THREE.MeshBasicMaterial).opacity = 0.4 * Math.max(0.25, opacity);

    if (view.isSeeker && p.tongue && !p.caught) {
      const len = Math.max(0.01, p.tongue.len);
      const ang = Math.atan2(p.tongue.dx, p.tongue.dz) - view.ryaw;
      const cx = Math.sin(ang);
      const cz = Math.cos(ang);
      view.tongue.visible = true;
      view.tongue.position.set(cx * (len / 2), TONGUE_Y, cz * (len / 2));
      view.tongue.scale.set(1, len, 1);
      view.tongue.rotation.set(Math.PI / 2, 0, -ang);
      view.tongueTip.visible = true;
      view.tongueTip.position.set(cx * len, TONGUE_Y, cz * len);
    } else {
      view.tongue.visible = false;
      view.tongueTip.visible = false;
    }
  }

  const cp = Math.cos(look.pitch);
  if (playing && me && me.role === 'seeker') {
    // First-person: camera at the seeker's eye.
    scratchEye.set(me.x, FIG_EYE, me.z);
    scratchLook.set(me.x + Math.sin(look.yaw) * cp, FIG_EYE + Math.sin(look.pitch), me.z + Math.cos(look.yaw) * cp);
    camera.position.copy(scratchEye);
    camera.lookAt(scratchLook);
    camInit = true;
  } else if (playing && me && meView) {
    // Third-person: follow the hider from behind, pulling in past walls.
    const px = meView.rx;
    const pz = meView.rz;
    const fx = Math.sin(look.yaw) * cp;
    const fy = Math.sin(look.pitch);
    const fz = Math.cos(look.yaw) * cp;
    const backHit = rayWallDist(world, px, pz, -Math.sin(look.yaw), -Math.cos(look.yaw));
    const dist = Math.min(TP_DIST, Math.max(1.6, backHit - 0.4));
    camera.position.set(px - fx * dist, Math.max(0.5, TP_PIVOT_Y - fy * dist + 0.25), pz - fz * dist);
    camera.lookAt(px + fx * 1.4, TP_PIVOT_Y + fy * 1.4, pz + fz * 1.4);
    camInit = true;
  } else {
    menuAngle += dt * 0.09;
    const rad = Math.max(MAP_HW, MAP_HD) * 1.35;
    scratchCam.set(Math.sin(menuAngle) * rad, Math.max(MAP_HW, MAP_HD) * 0.95, Math.cos(menuAngle) * rad);
    camera.position.lerp(scratchCam, camInit ? Math.min(1, dt * 0.8) : 1);
    camera.lookAt(0, 0.5, 0);
    camInit = true;
  }

  renderer.render(scene, camera);
}

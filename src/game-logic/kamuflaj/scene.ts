// Three.js rendering. The ONLY module that imports three. Renderer creation is
// guarded (yildizlararasi pattern): when WebGL is unavailable (headless smoke
// test, ancient devices) every function here no-ops and the simulation + HUD
// keep running. The render loop body in the entry wraps render() in try/catch
// so a lost context can never spam console.error.

import * as THREE from 'three';
import {
  ARENA_R,
  CAM_BACK,
  CAM_EASE,
  CAM_UP,
  FLOOR_HUE,
  FOG_FAR,
  FOG_NEAR,
  SKY,
  WALL_H,
  WALL_HUE,
} from './constants';
import type { Player, PropSpec, World } from './types';

let webglOk = false;
let canvasEl: HTMLCanvasElement | null = null;
let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;

let arenaGroup: THREE.Group | null = null;
let actorsGroup: THREE.Group | null = null;
let lampLights: THREE.PointLight[] = [];
let motes: THREE.Points | null = null;

interface ActorView {
  group: THREE.Group;
  skin: THREE.MeshStandardMaterial;
  body: THREE.Mesh;
  tail: THREE.Group;
  eyes: THREE.Group[];
  ring: THREE.Mesh;
  shadow: THREE.Mesh;
  tongue: THREE.Mesh;
  tongueTip: THREE.Mesh;
  phase: number; // idle-animation offset
  isSeeker: boolean;
}

let actorViews = new Map<string, ActorView>();
let reticle: THREE.Mesh | null = null;

const raycaster = new THREE.Raycaster();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const scratchNdc = new THREE.Vector2();
const scratchHit = new THREE.Vector3();
const scratchCam = new THREE.Vector3();
const scratchLook = new THREE.Vector3();

const MAX_LAMP_LIGHTS = 4;

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

function makeGradientTexture(top: string, bottom: string): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeFloorTexture(): THREE.Texture | null {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  // Warm radial base.
  const g = ctx.createRadialGradient(256, 256, 40, 256, 256, 256);
  g.addColorStop(0, hslCss(FLOOR_HUE, 0.32, 0.42));
  g.addColorStop(1, hslCss(FLOOR_HUE + 6, 0.34, 0.26));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 512, 512);
  // Plank seams.
  ctx.strokeStyle = 'rgba(0,0,0,0.13)';
  ctx.lineWidth = 2;
  for (let i = 1; i < 12; i++) {
    const y = (512 / 12) * i;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  }
  // Subtle grain speckle.
  ctx.fillStyle = 'rgba(255,240,210,0.05)';
  for (let i = 0; i < 600; i++) {
    ctx.fillRect(Math.random() * 512, Math.random() * 512, 1.5, 1.5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let blobTexture: THREE.Texture | null = null;
function getBlobTexture(): THREE.Texture | null {
  if (blobTexture) return blobTexture;
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(0,0,0,0.5)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  blobTexture = new THREE.CanvasTexture(c);
  return blobTexture;
}

// ---- init -------------------------------------------------------------------

export function initScene(canvas: HTMLCanvasElement, isCoarse: boolean): boolean {
  canvasEl = canvas;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isCoarse ? 1.5 : 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;

    scene = new THREE.Scene();
    const bg = makeGradientTexture('#222a3a', '#0c0f16');
    scene.background = bg ?? new THREE.Color(SKY);
    scene.fog = new THREE.Fog(SKY, FOG_NEAR, FOG_FAR);

    camera = new THREE.PerspectiveCamera(54, 1, 0.1, 240);
    camera.position.set(0, 30, 34);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x3a2f28, 0.85));
    const key = new THREE.DirectionalLight(0xfff0d6, 1.05);
    key.position.set(26, 40, 18);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x6f8cff, 0.4);
    rim.position.set(-28, 18, -22);
    scene.add(rim);

    arenaGroup = new THREE.Group();
    actorsGroup = new THREE.Group();
    scene.add(arenaGroup, actorsGroup);

    // Reusable lamp point lights (added to scene once, repositioned per arena).
    lampLights = [];
    for (let i = 0; i < MAX_LAMP_LIGHTS; i++) {
      const pl = new THREE.PointLight(0xffd9a0, 0, 22, 2);
      pl.visible = false;
      scene.add(pl);
      lampLights.push(pl);
    }

    // Drifting dust motes for atmosphere.
    const moteN = isCoarse ? 90 : 180;
    const mpos = new Float32Array(moteN * 3);
    for (let i = 0; i < moteN; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * ARENA_R;
      mpos[i * 3] = Math.cos(a) * r;
      mpos[i * 3 + 1] = 0.5 + Math.random() * (WALL_H + 2);
      mpos[i * 3 + 2] = Math.sin(a) * r;
    }
    const mgeo = new THREE.BufferGeometry();
    mgeo.setAttribute('position', new THREE.BufferAttribute(mpos, 3));
    motes = new THREE.Points(
      mgeo,
      new THREE.PointsMaterial({
        color: 0xfff3d6,
        size: 0.12,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
    );
    scene.add(motes);

    reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.74, 28),
      new THREE.MeshBasicMaterial({
        color: '#fda4af',
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
      }),
    );
    reticle.rotation.x = -Math.PI / 2;
    reticle.position.y = 0.06;
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

export function toWorld(clientX: number, clientY: number): { x: number; z: number } | null {
  if (!camera || !canvasEl) return null;
  const r = canvasEl.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  scratchNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(scratchNdc, camera);
  if (raycaster.ray.intersectPlane(groundPlane, scratchHit)) {
    return { x: scratchHit.x, z: scratchHit.z };
  }
  return null;
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

function addBlob(group: THREE.Group, r: number, x: number, z: number): void {
  const tex = getBlobTexture();
  if (!tex) return;
  const blob = new THREE.Mesh(
    new THREE.PlaneGeometry(r * 2.6, r * 2.6),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.6 }),
  );
  blob.rotation.x = -Math.PI / 2;
  blob.position.set(x, 0.03, z);
  group.add(blob);
}

function makeProp(p: PropSpec): THREE.Object3D {
  const color = hsl(p.hue, 0.52, 0.5);
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.05, flatShading: true });
  const grp = new THREE.Group();
  grp.position.set(p.x, 0, p.z);
  const rnd = jitter(p.seed);

  if (p.kind === 'barrel') {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(p.r, p.r * 0.92, p.h, 16), mat);
    body.position.y = p.h / 2;
    grp.add(body);
    const bandMat = new THREE.MeshStandardMaterial({ color: '#3a3128', roughness: 0.6, metalness: 0.4 });
    for (const fy of [0.25, 0.75]) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(p.r * 1.01, 0.06, 6, 18), bandMat);
      band.rotation.x = Math.PI / 2;
      band.position.y = p.h * fy;
      grp.add(band);
    }
    const lid = new THREE.Mesh(new THREE.CylinderGeometry(p.r * 0.88, p.r * 0.88, 0.12, 16), mat);
    lid.position.y = p.h + 0.02;
    grp.add(lid);
  } else if (p.kind === 'rock') {
    const geo = new THREE.DodecahedronGeometry(p.r, 0);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const k = 0.82 + rnd() * 0.36;
      pos.setXYZ(i, pos.getX(i) * k, Math.max(0, pos.getY(i)) * k * 0.85, pos.getZ(i) * k);
    }
    geo.computeVertexNormals();
    const rock = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.95, flatShading: true }));
    rock.position.y = p.r * 0.5;
    grp.add(rock);
  } else if (p.kind === 'plant') {
    const pot = new THREE.Mesh(
      new THREE.CylinderGeometry(p.r * 0.6, p.r * 0.45, p.h * 0.35, 10),
      new THREE.MeshStandardMaterial({ color: '#8a5a3a', roughness: 0.85, flatShading: true }),
    );
    pot.position.y = p.h * 0.175;
    grp.add(pot);
    for (let i = 0; i < 5; i++) {
      const leafMat = new THREE.MeshStandardMaterial({
        color: hsl(p.hue, 0.5, 0.42 + rnd() * 0.18),
        roughness: 0.7,
        flatShading: true,
      });
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(p.r * 0.42, p.h * (0.7 + rnd() * 0.5), 5), leafMat);
      const a = (i / 5) * Math.PI * 2 + rnd();
      leaf.position.set(Math.cos(a) * p.r * 0.3, p.h * 0.55, Math.sin(a) * p.r * 0.3);
      leaf.rotation.set(0.5 - rnd(), a, 0.6 - rnd());
      grp.add(leaf);
    }
  } else if (p.kind === 'lamp') {
    const post = new THREE.Mesh(
      new THREE.CylinderGeometry(p.r * 0.16, p.r * 0.24, p.h, 8),
      new THREE.MeshStandardMaterial({ color: '#2c2f37', roughness: 0.5, metalness: 0.6, flatShading: true }),
    );
    post.position.y = p.h / 2;
    grp.add(post);
    const bulb = new THREE.Mesh(
      new THREE.SphereGeometry(p.r * 0.52, 14, 10),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 1.4,
        roughness: 0.3,
      }),
    );
    bulb.position.y = p.h + p.r * 0.3;
    bulb.userData.lamp = true;
    grp.add(bulb);
    grp.userData.lampY = p.h + p.r * 0.3;
  } else {
    // crate: planked box with a frame + corner studs.
    const box = new THREE.Mesh(new THREE.BoxGeometry(p.r * 1.7, p.h, p.r * 1.7), mat);
    box.position.y = p.h / 2;
    grp.add(box);
    const frameMat = new THREE.MeshStandardMaterial({ color: hsl(p.hue, 0.45, 0.34), roughness: 0.8, flatShading: true });
    const w = p.r * 1.74;
    for (const fy of [0.08, p.h - 0.08]) {
      const f = new THREE.Mesh(new THREE.BoxGeometry(w, 0.14, w), frameMat);
      f.position.y = fy;
      grp.add(f);
    }
    const diag = new THREE.Mesh(new THREE.BoxGeometry(p.r * 2.2, 0.12, 0.12), frameMat);
    diag.position.set(0, p.h / 2, p.r * 0.86);
    diag.rotation.z = 0.7;
    grp.add(diag);
  }

  addBlob(grp, p.r * 1.1, 0, 0);
  return grp;
}

/** A stylised chameleon: tapered body, dorsal crest, turret eyes, a curled tail
 *  and four gripping feet. Every "skin" part shares one material so a colour
 *  change repaints the whole animal in one assignment. */
function makeChameleon(hue: number, isSeeker: boolean): ActorView {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    color: hsl(hue, 0.6, 0.52),
    roughness: 0.55,
    metalness: 0.05,
    flatShading: true,
    transparent: true,
    opacity: 1,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.6, 14, 12), skin);
  body.scale.set(0.95, 0.82, 1.55);
  body.position.y = 0.6;
  group.add(body);

  // Dorsal crest: a row of little spikes along the spine.
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    const spike = new THREE.Mesh(
      new THREE.ConeGeometry(0.1, 0.26 - t * 0.12, 4),
      isSeeker ? new THREE.MeshStandardMaterial({ color: '#ef4444', flatShading: true }) : skin,
    );
    spike.position.set(0, 1.02 - t * 0.18, 0.5 - t * 0.95);
    group.add(spike);
  }

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 14, 12), skin);
  head.scale.set(1, 0.92, 1.12);
  head.position.set(0, 0.78, 1.0);
  group.add(head);

  // Casque (the chameleon's helmet ridge).
  const casque = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.4, 5), skin);
  casque.position.set(0, 1.08, 0.86);
  casque.rotation.x = -0.5;
  group.add(casque);

  // Turret eyes: a cone turret + dark eyeball + bright pupil, grouped so they
  // can swivel idly.
  const eyes: THREE.Group[] = [];
  const eyeMat = new THREE.MeshStandardMaterial({ color: '#15181f', roughness: 0.4, flatShading: true });
  const pupilMat = new THREE.MeshBasicMaterial({ color: isSeeker ? '#fca5a5' : '#fde68a' });
  for (const sx of [-1, 1]) {
    const eg = new THREE.Group();
    eg.position.set(0.3 * sx, 0.92, 0.98);
    const turret = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 10), skin);
    eg.add(turret);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 10), eyeMat);
    ball.position.set(0.12 * sx, 0, 0.02);
    eg.add(ball);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), pupilMat);
    pupil.position.set(0.19 * sx, 0, 0.04);
    eg.add(pupil);
    group.add(eg);
    eyes.push(eg);
  }

  // Curled tail from a spiral of shrinking segments, in its own group so it can
  // sway.
  const tail = new THREE.Group();
  tail.position.set(0, 0.55, -0.95);
  for (let i = 0; i < 8; i++) {
    const seg = new THREE.Mesh(new THREE.SphereGeometry(0.2 - i * 0.022, 8, 7), skin);
    const a = i * 0.6;
    const rad = 0.55 - i * 0.05;
    seg.position.set(Math.sin(a) * rad * 0.4, Math.sin(a * 0.5) * 0.12, -i * 0.16 + (1 - Math.cos(a)) * rad * 0.5);
    tail.add(seg);
  }
  group.add(tail);

  // Four stubby gripping feet.
  const legGeo = new THREE.CylinderGeometry(0.1, 0.07, 0.55, 6);
  for (const [lx, lz] of [[-0.46, 0.52], [0.46, 0.52], [-0.46, -0.42], [0.46, -0.42]] as const) {
    const leg = new THREE.Mesh(legGeo, skin);
    leg.position.set(lx, 0.24, lz);
    leg.rotation.z = lx < 0 ? 0.3 : -0.3;
    group.add(leg);
  }

  // "You" marker ring on the floor.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.92, 1.12, 26),
    new THREE.MeshBasicMaterial({ color: '#fde047', transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.05;
  ring.visible = false;
  group.add(ring);

  // Blob shadow (separate so its opacity tracks the body height/visibility).
  const blobTex = getBlobTexture();
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.0, 2.0),
    new THREE.MeshBasicMaterial({
      map: blobTex ?? undefined,
      color: 0x000000,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.04;
  group.add(shadow);

  // Seeker tongue + sticky tip.
  const tongue = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.07, 1, 6),
    new THREE.MeshBasicMaterial({ color: '#f43f5e' }),
  );
  tongue.visible = false;
  group.add(tongue);
  const tongueTip = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 8, 8),
    new THREE.MeshBasicMaterial({ color: '#fb7185' }),
  );
  tongueTip.visible = false;
  group.add(tongueTip);

  return {
    group,
    skin,
    body,
    tail,
    eyes,
    ring,
    shadow,
    tongue,
    tongueTip,
    phase: Math.random() * Math.PI * 2,
    isSeeker,
  };
}

export function buildArena(world: World): void {
  if (!webglOk || !arenaGroup || !actorsGroup) return;

  disposeGroup(arenaGroup);
  // Floor.
  const floorTex = makeFloorTexture();
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(ARENA_R, 64),
    new THREE.MeshStandardMaterial({
      map: floorTex ?? undefined,
      color: floorTex ? 0xffffff : hsl(FLOOR_HUE, 0.32, 0.4),
      roughness: 0.92,
      flatShading: false,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  arenaGroup.add(floor);

  // Wall ring with a baseboard + top trim.
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA_R, ARENA_R, WALL_H, 64, 1, true),
    new THREE.MeshStandardMaterial({
      color: hsl(WALL_HUE, 0.26, 0.36),
      roughness: 0.9,
      side: THREE.BackSide,
    }),
  );
  wall.position.y = WALL_H / 2;
  arenaGroup.add(wall);
  const trimMat = new THREE.MeshStandardMaterial({ color: hsl(WALL_HUE, 0.3, 0.26), roughness: 0.8, side: THREE.DoubleSide });
  for (const ty of [0.2, WALL_H - 0.2]) {
    const trim = new THREE.Mesh(new THREE.CylinderGeometry(ARENA_R - 0.05, ARENA_R - 0.05, 0.4, 64, 1, true), trimMat);
    trim.position.y = ty;
    arenaGroup.add(trim);
  }

  for (const p of world.props) arenaGroup.add(makeProp(p));

  // Position lamp point lights over the brightest lamp props.
  const lamps = world.props.filter((p) => p.kind === 'lamp');
  for (let i = 0; i < lampLights.length; i++) {
    const pl = lampLights[i]!;
    const lp = lamps[i];
    if (lp) {
      pl.visible = true;
      pl.color.copy(hsl(lp.hue, 0.5, 0.55));
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
    const view = makeChameleon(p.bodyHue, p.role === 'seeker');
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
  aim: { x: number; z: number } | null,
): void {
  if (!webglOk || !renderer || !scene || !camera) return;
  const now = performance.now() / 1000;

  if (motes) motes.rotation.y += dt * 0.02;

  let me: Player | null = null;
  for (const p of world.players) {
    const view = actorViews.get(p.id);
    if (!view) continue;
    if (p.id === myId) me = p;
    const isMe = p.id === myId;

    view.group.position.set(p.x, 0, p.z);
    view.group.rotation.y = p.yaw;

    // Idle animation: breathing + tail sway + eye darts.
    const t = now + view.phase;
    view.body.scale.y = 0.82 + Math.sin(t * 2.4) * 0.025;
    view.tail.rotation.y = Math.sin(t * 1.3) * 0.25;
    const dart = Math.sin(t * 0.7) * 0.5;
    view.eyes[0]!.rotation.y = dart;
    view.eyes[1]!.rotation.y = -dart;

    // Skin colour follows the (painted) body hue; caught bodies desaturate.
    view.skin.color.copy(
      hsl(p.bodyHue, p.role === 'seeker' ? 0.55 : 0.62, p.caught ? 0.3 : 0.54),
    );
    // Paint shimmer: emissive pulse for hiders mid-blend.
    if (p.role === 'hider' && !p.caught) {
      view.skin.emissive.copy(hsl(p.bodyHue, 0.7, 0.5));
      view.skin.emissiveIntensity = 0.04 + Math.max(0, 0.12 * (1 - p.visible)) * (0.6 + 0.4 * Math.sin(t * 5));
    } else {
      view.skin.emissiveIntensity = 0;
    }

    // Opacity: hiders fade as they blend; seekers/caught stay solid. You always
    // see yourself clearly.
    let opacity = 1;
    if (p.role === 'hider' && !p.caught) {
      opacity = isMe ? Math.max(0.6, p.visible) : Math.max(0.12, p.visible);
    }
    view.skin.opacity = opacity;
    view.group.rotation.z = p.caught ? Math.PI * 0.12 : 0;
    view.body.position.y = p.caught ? 0.4 : 0.6;

    view.ring.visible = isMe && world.status !== 'menu';
    (view.shadow.material as THREE.MeshBasicMaterial).opacity = 0.45 * Math.max(0.25, opacity);

    // Tongue: extend from the head along the stored direction (group-local).
    if (view.isSeeker && p.tongue && !p.caught) {
      const len = Math.max(0.01, p.tongue.len);
      const ang = Math.atan2(p.tongue.dx, p.tongue.dz) - p.yaw;
      const cx = Math.sin(ang);
      const cz = Math.cos(ang);
      view.tongue.visible = true;
      view.tongue.position.set(cx * (len / 2), 0.78, cz * (len / 2));
      view.tongue.scale.set(1, len, 1);
      view.tongue.rotation.set(Math.PI / 2, 0, -ang);
      view.tongueTip.visible = true;
      view.tongueTip.position.set(cx * len, 0.78, cz * len);
    } else {
      view.tongue.visible = false;
      view.tongueTip.visible = false;
    }
  }

  // Reticle (local seeker aim).
  if (reticle) {
    if (aim && me?.role === 'seeker' && world.status === 'hunt') {
      reticle.visible = true;
      reticle.position.set(aim.x, 0.06, aim.z);
      reticle.scale.setScalar(1 + Math.sin(now * 6) * 0.06);
    } else {
      reticle.visible = false;
    }
  }

  // Camera: chase the local player; slow orbit in the menu / lobby.
  const k = 1 - Math.exp(-CAM_EASE * dt);
  if (world.status === 'menu' || world.status === 'waiting' || world.status === 'connecting' || !me) {
    menuAngle += dt * 0.12;
    scratchCam.set(Math.sin(menuAngle) * 30, 22, Math.cos(menuAngle) * 30);
    camera.position.lerp(scratchCam, camInit ? Math.min(1, dt * 0.8) : 1);
    camera.lookAt(0, 1.2, 0);
  } else {
    const back = Math.cos(me.yaw) * CAM_BACK;
    const side = Math.sin(me.yaw) * CAM_BACK;
    scratchCam.set(me.x - side, CAM_UP, me.z - back);
    if (!camInit) camera.position.copy(scratchCam);
    else camera.position.lerp(scratchCam, k);
    scratchLook.set(me.x, 0.7, me.z);
    camera.lookAt(scratchLook);
  }
  camInit = true;

  renderer.render(scene, camera);
}

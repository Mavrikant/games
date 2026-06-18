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

interface ActorView {
  group: THREE.Group;
  skin: THREE.MeshStandardMaterial;
  ring: THREE.Mesh;
  tongue: THREE.Mesh;
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
    camera = new THREE.PerspectiveCamera(56, 1, 0.1, 220);
    camera.position.set(0, 40, 40);
    camera.lookAt(0, 0, 0);

    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const dir = new THREE.DirectionalLight(0xfff1da, 0.95);
    dir.position.set(24, 46, 18);
    scene.add(dir);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.35);
    fill.position.set(-30, 20, -20);
    scene.add(fill);

    arenaGroup = new THREE.Group();
    actorsGroup = new THREE.Group();
    scene.add(arenaGroup, actorsGroup);

    reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.72, 22),
      new THREE.MeshBasicMaterial({ color: '#fca5a5', transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    reticle.rotation.x = -Math.PI / 2;
    reticle.position.y = 0.05;
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

/** Client coords → point on the floor (y = 0). */
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

// ---- helpers ----------------------------------------------------------------

function hsl(hue: number, s: number, l: number): THREE.Color {
  return new THREE.Color().setHSL((((hue % 360) + 360) % 360) / 360, s, l);
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

function makeProp(p: PropSpec): THREE.Mesh | THREE.Group {
  const color = hsl(p.hue, 0.5, 0.5);
  const mat = new THREE.MeshStandardMaterial({ color, flatShading: true });
  let geo: THREE.BufferGeometry;
  switch (p.kind) {
    case 'barrel':
      geo = new THREE.CylinderGeometry(p.r, p.r, p.h, 12);
      break;
    case 'rock':
      geo = new THREE.DodecahedronGeometry(p.r, 0);
      break;
    case 'plant': {
      const grp = new THREE.Group();
      const trunk = new THREE.Mesh(
        new THREE.CylinderGeometry(p.r * 0.22, p.r * 0.28, p.h * 0.5, 7),
        new THREE.MeshStandardMaterial({ color: hsl(28, 0.4, 0.35), flatShading: true }),
      );
      trunk.position.y = p.h * 0.25;
      grp.add(trunk);
      const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(p.r, 0), mat);
      leaves.position.y = p.h * 0.6;
      grp.add(leaves);
      grp.position.set(p.x, 0, p.z);
      return grp;
    }
    case 'lamp': {
      const grp = new THREE.Group();
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(p.r * 0.25, p.r * 0.3, p.h, 8),
        new THREE.MeshStandardMaterial({ color: '#33373f', flatShading: true }),
      );
      post.position.y = p.h * 0.5;
      grp.add(post);
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(p.r * 0.55, 10, 8),
        new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.7, flatShading: true }),
      );
      bulb.position.y = p.h + p.r * 0.2;
      grp.add(bulb);
      grp.position.set(p.x, 0, p.z);
      return grp;
    }
    case 'crate':
    default:
      geo = new THREE.BoxGeometry(p.r * 1.7, p.h, p.r * 1.7);
      break;
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(p.x, p.h / 2, p.z);
  return mesh;
}

/** A stylised chameleon: rounded body, turret eyes, curled tail, four legs.
 *  Every "skin" part shares one material so a colour change repaints the whole
 *  animal in one assignment. */
function makeChameleon(hue: number, isSeeker: boolean): ActorView {
  const group = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({
    color: hsl(hue, 0.6, 0.55),
    flatShading: true,
    transparent: true,
    opacity: 1,
  });

  const body = new THREE.Mesh(new THREE.SphereGeometry(0.62, 12, 10), skin);
  body.scale.set(1.0, 0.8, 1.5);
  body.position.y = 0.55;
  group.add(body);

  // Back crest ridge.
  const crest = new THREE.Mesh(
    new THREE.ConeGeometry(0.16, 0.5, 4),
    isSeeker ? new THREE.MeshStandardMaterial({ color: '#ef4444', flatShading: true }) : skin,
  );
  crest.position.set(0, 1.05, -0.1);
  group.add(crest);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 10), skin);
  head.scale.set(1, 0.95, 1.1);
  head.position.set(0, 0.72, 0.95);
  group.add(head);

  // Turret eyes (dark with a bright pupil dot) on each side of the head.
  const eyeMat = new THREE.MeshStandardMaterial({ color: '#1b1f29', flatShading: true });
  const pupilMat = new THREE.MeshBasicMaterial({ color: isSeeker ? '#fca5a5' : '#fde68a' });
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), eyeMat);
    eye.position.set(0.28 * sx, 0.86, 0.92);
    group.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 6), pupilMat);
    pupil.position.set(0.28 * sx + 0.13 * sx, 0.86, 1.04);
    group.add(pupil);
  }

  // Curled tail from a few shrinking segments.
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Mesh(new THREE.SphereGeometry(0.22 - i * 0.035, 8, 6), skin);
    const a = i * 0.7;
    seg.position.set(Math.sin(a) * 0.25, 0.5 + i * 0.04, -1.0 - i * 0.18 + Math.sin(a) * 0.1);
    group.add(seg);
  }

  // Four stubby legs.
  const legGeo = new THREE.CylinderGeometry(0.1, 0.08, 0.5, 6);
  for (const [lx, lz] of [[-0.45, 0.5], [0.45, 0.5], [-0.45, -0.4], [0.45, -0.4]] as const) {
    const leg = new THREE.Mesh(legGeo, skin);
    leg.position.set(lx, 0.22, lz);
    group.add(leg);
  }

  // "You" marker ring on the floor.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1.05, 24),
    new THREE.MeshBasicMaterial({ color: '#fef08a', transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  ring.visible = false;
  group.add(ring);

  // Seeker tongue (thin red cylinder, scaled per frame along +z of a pivot).
  const tongue = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 1, 6),
    new THREE.MeshBasicMaterial({ color: '#f43f5e' }),
  );
  tongue.visible = false;
  group.add(tongue);

  return { group, skin, ring, tongue, isSeeker };
}

export function buildArena(world: World): void {
  if (!webglOk || !arenaGroup || !actorsGroup) return;

  disposeGroup(arenaGroup);
  // Floor.
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(ARENA_R, 48),
    new THREE.MeshStandardMaterial({ color: hsl(FLOOR_HUE, 0.32, 0.4), flatShading: true }),
  );
  floor.rotation.x = -Math.PI / 2;
  arenaGroup.add(floor);
  // Wall ring.
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(ARENA_R, ARENA_R, WALL_H, 48, 1, true),
    new THREE.MeshStandardMaterial({
      color: hsl(WALL_HUE, 0.28, 0.42),
      flatShading: true,
      side: THREE.BackSide,
    }),
  );
  wall.position.y = WALL_H / 2;
  arenaGroup.add(wall);
  for (const p of world.props) arenaGroup.add(makeProp(p));

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

  let me: Player | null = null;
  for (const p of world.players) {
    const view = actorViews.get(p.id);
    if (!view) continue;
    if (p.id === myId) me = p;

    view.group.position.set(p.x, 0, p.z);
    view.group.rotation.y = p.yaw;

    // Skin colour follows the (painted) body hue.
    view.skin.color.copy(hsl(p.bodyHue, p.role === 'seeker' ? 0.55 : 0.62, p.caught ? 0.3 : 0.55));

    // Opacity: hiders fade as they blend; seekers and caught bodies are solid.
    let opacity = 1;
    if (p.role === 'hider' && !p.caught) {
      const isMe = p.id === myId;
      // You always see yourself clearly; others see your detectability.
      opacity = isMe ? Math.max(0.55, p.visible) : Math.max(0.12, p.visible);
    }
    view.skin.opacity = opacity;
    if (p.caught) {
      view.group.rotation.z = Math.PI * 0.12; // toppled over
    } else {
      view.group.rotation.z = 0;
    }

    view.ring.visible = p.id === myId && world.status !== 'menu';

    // Tongue: extend from the head along the stored direction.
    if (view.isSeeker && p.tongue && !p.caught) {
      const t = p.tongue;
      const len = Math.max(0.01, t.len);
      view.tongue.visible = true;
      // Position/scale the cylinder in world space (added to group, so undo yaw).
      const ang = Math.atan2(t.dx, t.dz) - p.yaw;
      view.tongue.position.set(Math.sin(ang) * (len / 2), 0.72, Math.cos(ang) * (len / 2));
      view.tongue.scale.set(1, len, 1);
      view.tongue.rotation.set(Math.PI / 2, 0, -ang);
    } else {
      view.tongue.visible = false;
    }
  }

  // Reticle (local seeker aim).
  if (reticle) {
    const meIsSeeker = me?.role === 'seeker';
    if (aim && meIsSeeker && (world.status === 'hunt')) {
      reticle.visible = true;
      reticle.position.set(aim.x, 0.05, aim.z);
    } else {
      reticle.visible = false;
    }
  }

  // Camera: chase the local player in a match; slow orbit in the menu.
  const k = 1 - Math.exp(-CAM_EASE * dt);
  if (world.status === 'menu' || !me) {
    menuAngle += dt * 0.1;
    scratchCam.set(Math.sin(menuAngle) * 34, 26, Math.cos(menuAngle) * 34);
    camera.position.lerp(scratchCam, camInit ? Math.min(1, dt * 0.8) : 1);
    camera.lookAt(0, 0.5, 0);
  } else {
    const back = Math.cos(me.yaw) * CAM_BACK;
    const side = Math.sin(me.yaw) * CAM_BACK;
    scratchCam.set(me.x - side, CAM_UP, me.z - back);
    if (!camInit) camera.position.copy(scratchCam);
    else camera.position.lerp(scratchCam, k);
    scratchLook.set(me.x, 0.6, me.z);
    camera.lookAt(scratchLook);
  }
  camInit = true;

  renderer.render(scene, camera);
}

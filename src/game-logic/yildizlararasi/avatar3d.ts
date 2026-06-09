// Builds a low-poly 3D avatar (THREE.Group) from a Character. Parameterized by
// hair type/color (incl. curly + bald), eye color, skin tone, clothing color and
// an optional accessory. Feet rest at y=0; total height ~1.7 units.

import * as THREE from 'three';

function mat(color: string, opts: { rough?: number; metal?: number } = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    roughness: opts.rough ?? 0.7,
    metalness: opts.metal ?? 0.05,
  });
}

function addHair(group: THREE.Group, c: { hairType: string; hairColor: string }): void {
  if (c.hairType === 'kel') return;
  const hm = mat(c.hairColor, { rough: 0.85 });
  if (c.hairType === 'kivircik') {
    // Curly: a cluster of small spheres around the upper head.
    const puff = new THREE.SphereGeometry(0.12, 8, 8);
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2;
      const m = new THREE.Mesh(puff, hm);
      m.position.set(Math.cos(a) * 0.24, 1.46 + Math.sin(i * 1.7) * 0.06, Math.sin(a) * 0.24);
      group.add(m);
    }
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), hm);
    top.position.set(0, 1.58, 0);
    group.add(top);
    return;
  }
  // Cap covering the top of the head.
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.32, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), hm);
  cap.position.set(0, 1.4, 0);
  group.add(cap);
  if (c.hairType === 'uzun') {
    const back = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.7, 12, 1, true), hm);
    back.position.set(0, 1.1, -0.16);
    group.add(back);
  } else if (c.hairType === 'toplu') {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.13, 12, 12), hm);
    bun.position.set(0, 1.7, -0.02);
    group.add(bun);
  }
}

function addAccessory(group: THREE.Group, accessory: string): void {
  if (accessory === 'gozluk') {
    const gm = mat('#1c1c22', { rough: 0.4, metal: 0.3 });
    const ring = new THREE.TorusGeometry(0.08, 0.018, 8, 16);
    for (const x of [-0.12, 0.12]) {
      const r = new THREE.Mesh(ring, gm);
      r.position.set(x, 1.36, 0.27);
      group.add(r);
    }
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.02, 0.02), gm);
    bridge.position.set(0, 1.36, 0.27);
    group.add(bridge);
  } else if (accessory === 'sapka') {
    const hm = mat('#4527A0', { rough: 0.6 });
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.03, 20), hm);
    brim.position.set(0, 1.52, 0);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.22, 20), hm);
    top.position.set(0, 1.64, 0);
    group.add(brim, top);
  } else if (accessory === 'tac') {
    const cm = mat('#FFEB3B', { rough: 0.25, metal: 0.7 });
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.1, 18, 1, true), cm);
    band.position.set(0, 1.56, 0);
    group.add(band);
    const spike = new THREE.ConeGeometry(0.06, 0.16, 8);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const s = new THREE.Mesh(spike, cm);
      s.position.set(Math.cos(a) * 0.3, 1.66, Math.sin(a) * 0.3);
      group.add(s);
    }
  }
}

export function buildAvatar(c: {
  hairType: string;
  hairColor: string;
  eyeColor: string;
  skinColor: string;
  clothingColor: string;
  accessory: string;
}): THREE.Group {
  const group = new THREE.Group();
  const skin = mat(c.skinColor);

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.42, 0.95, 18), mat(c.clothingColor));
  body.position.y = 0.48;
  group.add(body);

  const arm = new THREE.CylinderGeometry(0.07, 0.07, 0.5, 10);
  for (const x of [-0.34, 0.34]) {
    const a = new THREE.Mesh(arm, skin);
    a.position.set(x, 0.62, 0);
    a.rotation.z = x < 0 ? 0.28 : -0.28;
    group.add(a);
  }

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.12, 10), skin);
  neck.position.y = 1.02;
  group.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.3, 20, 16), skin);
  head.position.y = 1.28;
  group.add(head);

  const eye = new THREE.SphereGeometry(0.045, 8, 8);
  const eyeMat = mat(c.eyeColor, { rough: 0.3 });
  for (const x of [-0.11, 0.11]) {
    const e = new THREE.Mesh(eye, eyeMat);
    e.position.set(x, 1.31, 0.27);
    group.add(e);
  }

  addHair(group, c);
  addAccessory(group, c.accessory);
  return group;
}

export function disposeAvatar(group: THREE.Group): void {
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mm = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mm)) mm.forEach((x) => x.dispose());
    else if (mm) mm.dispose();
  });
}

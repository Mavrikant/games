// Procedural audio — synthesized SFX + a soft ambient music loop. No assets,
// no deps. Modeled on seker-esle/audio.ts: lazy init on first user gesture,
// AudioContext+webkit fallback, suspend when tab hidden, EVERYTHING wrapped in
// try/catch so it can never throw or console.error (the smoke gate fails on
// any console.error; smoke never triggers a gesture so this never inits there).

import type { Kind } from './types';

type Ctx = AudioContext;

let ctx: Ctx | null = null;
let master: GainNode | null = null;
let musicGain: GainNode | null = null;
let initialized = false;
let sfxOn = true;
let musicOn = true;
let voices = 0;
const MAX_VOICES = 18;

let droneNodes: OscillatorNode[] = [];
let musicTimer: number | null = null;
let musicToken = 0;

export function setSfxEnabled(v: boolean): void {
  sfxOn = v;
}

export function setMusicEnabled(v: boolean): void {
  musicOn = v;
  if (!initialized) return;
  if (v) startMusic();
  else stopMusic();
}

export function ensureAudio(): void {
  if (initialized) return;
  initialized = true;
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.0;
    musicGain.connect(master);
    document.addEventListener('visibilitychange', () => {
      if (!ctx) return;
      try {
        if (document.hidden) ctx.suspend();
        else ctx.resume();
      } catch {
        /* ignore */
      }
    });
    if (musicOn) startMusic();
  } catch {
    ctx = null;
  }
}

function now(): number {
  return ctx ? ctx.currentTime : 0;
}

function tone(
  freq: number,
  dur: number,
  type: OscillatorType,
  gain: number,
  whenOffset = 0,
  glideTo?: number,
): void {
  if (!ctx || !master || !sfxOn) return;
  if (voices >= MAX_VOICES) return;
  try {
    const t0 = now() + whenOffset;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, glideTo), t0 + dur);
    }
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    voices++;
    osc.onended = () => {
      voices = Math.max(0, voices - 1);
      try {
        g.disconnect();
      } catch {
        /* ignore */
      }
    };
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  } catch {
    /* ignore */
  }
}

function noise(dur: number, gain: number, filterFreq: number, whenOffset = 0): void {
  if (!ctx || !master || !sfxOn) return;
  if (voices >= MAX_VOICES) return;
  try {
    const t0 = now() + whenOffset;
    const frames = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = filterFreq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(lp);
    lp.connect(g);
    g.connect(master);
    voices++;
    src.onended = () => {
      voices = Math.max(0, voices - 1);
      try {
        g.disconnect();
      } catch {
        /* ignore */
      }
    };
    src.start(t0);
    src.stop(t0 + dur + 0.02);
  } catch {
    /* ignore */
  }
}

// ---- SFX recipes ----
export function sfxLaunch(power = 0.6): void {
  noise(0.18, 0.25, 1400);
  tone(220 + power * 120, 0.22, 'sawtooth', 0.12, 0, 90);
}

export function sfxImpact(speed: number): void {
  const hard = Math.min(1, speed / 700);
  noise(0.07, 0.12 + hard * 0.16, 800 + hard * 600);
  tone(90 + hard * 60, 0.1, 'sine', 0.1 + hard * 0.1, 0, 60);
}

export function sfxBreak(kind: Kind): void {
  if (kind === 'glass') {
    tone(1400, 0.12, 'triangle', 0.1, 0, 2200);
    tone(1900, 0.1, 'triangle', 0.07, 0.02);
  } else if (kind === 'iron') {
    tone(420, 0.16, 'square', 0.09, 0, 300);
    tone(640, 0.14, 'square', 0.06, 0.01, 480);
  } else if (kind === 'wood') {
    noise(0.09, 0.14, 1800);
    tone(180, 0.09, 'square', 0.08, 0, 120);
  } else {
    noise(0.12, 0.18, 700);
    tone(120, 0.12, 'sine', 0.1, 0, 70);
  }
}

export function sfxExplode(big = false): void {
  noise(big ? 0.5 : 0.34, big ? 0.38 : 0.3, big ? 500 : 700);
  tone(big ? 70 : 90, big ? 0.45 : 0.32, 'sine', 0.22, 0, 36);
}

export function sfxSupply(): void {
  tone(660, 0.09, 'triangle', 0.12);
  tone(990, 0.12, 'triangle', 0.12, 0.07);
}

export function sfxTarget(): void {
  tone(520, 0.1, 'sawtooth', 0.12, 0, 300);
  noise(0.18, 0.14, 1200, 0.02);
}

export function sfxStar(i: number): void {
  tone(523 * Math.pow(2, i / 12) * (1 + i * 0.18), 0.18, 'triangle', 0.14, i * 0.02);
}

export function sfxWin(): void {
  const seq = [523, 659, 784, 1047];
  seq.forEach((f, i) => tone(f, 0.26, 'triangle', 0.16, i * 0.12));
}

export function sfxFail(): void {
  tone(300, 0.4, 'sawtooth', 0.14, 0, 120);
}

export function sfxUi(): void {
  tone(440, 0.05, 'square', 0.06, 0, 520);
}

// ---- Ambient music: slow drone + sparse arpeggio ----
const SCALE = [196, 220, 262, 294, 349, 392, 440]; // G minor-ish pentatonic flavor

function startMusic(): void {
  if (!ctx || !musicGain) return;
  if (droneNodes.length) return;
  try {
    musicGain.gain.cancelScheduledValues(now());
    musicGain.gain.setValueAtTime(0.0001, now());
    musicGain.gain.linearRampToValueAtTime(0.5, now() + 2.5);
    for (const f of [98, 147]) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      g.gain.value = 0.06;
      osc.connect(g);
      g.connect(musicGain);
      osc.start();
      droneNodes.push(osc);
    }
    musicToken++;
    scheduleArp(musicToken);
  } catch {
    /* ignore */
  }
}

function scheduleArp(token: number): void {
  if (!ctx || !musicGain) return;
  if (token !== musicToken || !musicOn) return;
  try {
    const f = SCALE[Math.floor(Math.random() * SCALE.length)]!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = f * 2;
    const t0 = now();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.4);
    osc.connect(g);
    g.connect(musicGain);
    osc.start(t0);
    osc.stop(t0 + 1.5);
  } catch {
    /* ignore */
  }
  musicTimer = window.setTimeout(
    () => scheduleArp(token),
    1100 + Math.random() * 1400,
  );
}

function stopMusic(): void {
  musicToken++;
  if (musicTimer !== null) {
    clearTimeout(musicTimer);
    musicTimer = null;
  }
  try {
    if (musicGain && ctx) {
      musicGain.gain.cancelScheduledValues(now());
      musicGain.gain.setValueAtTime(musicGain.gain.value, now());
      musicGain.gain.linearRampToValueAtTime(0.0001, now() + 0.6);
    }
    for (const o of droneNodes) {
      try {
        o.stop(now() + 0.7);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  droneNodes = [];
}

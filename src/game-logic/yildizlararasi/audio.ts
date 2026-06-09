// Procedural audio — synthesized ambient + SFX. No assets, no deps. Modeled on
// kusatma/audio.ts: lazy init on first user gesture, AudioContext+webkit
// fallback, suspend when tab hidden, EVERYTHING wrapped in try/catch so it can
// never throw or console.error (the smoke gate fails on any console.error;
// smoke never triggers a gesture, so this never inits there).

type Theme = 'space' | 'earth';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let musicGain: GainNode | null = null;
let initialized = false;
let sfxOn = true;
let musicOn = true;
let voices = 0;
const MAX_VOICES = 16;

let theme: Theme = 'space';
let droneNodes: OscillatorNode[] = [];
let melodyTimer: number | null = null;
let melodyToken = 0;

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
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + 0.01);
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

function noise(dur: number, gain: number, filterFreq: number, glideTo?: number): void {
  if (!ctx || !master || !sfxOn) return;
  if (voices >= MAX_VOICES) return;
  try {
    const t0 = now();
    const frames = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(filterFreq, t0);
    if (glideTo !== undefined) lp.frequency.exponentialRampToValueAtTime(Math.max(80, glideTo), t0 + dur);
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

// ---- SFX ----
export function sfxClick(): void {
  // soft water-drop: quick downward sine glide + tiny tick
  tone(680, 0.12, 'sine', 0.1, 0, 320);
  noise(0.04, 0.04, 2200);
}

export function sfxPickup(): void {
  // magical chime: ascending triangle arpeggio
  [660, 990, 1320].forEach((f, i) => tone(f, 0.18, 'triangle', 0.13, i * 0.07));
}

export function sfxPortal(): void {
  // whoosh: lowpass-swept noise + descending sawtooth
  noise(0.7, 0.26, 240, 2600);
  tone(420, 0.7, 'sawtooth', 0.12, 0, 90);
  tone(840, 0.5, 'sine', 0.06, 0.05, 220);
}

export function sfxFail(): void {
  // gentle descending "try again" cue
  tone(330, 0.28, 'sawtooth', 0.12, 0, 150);
  tone(247, 0.3, 'sine', 0.09, 0.08);
}

// ---- Ambient music ----
const SPACE_DRONE = [98, 147];
const SPACE_SCALE = [196, 220, 262, 294, 349, 392, 440]; // calm pentatonic-ish
const EARTH_DRONE = [131, 196]; // C / G — major, warm
const EARTH_MELODY = [392, 440, 494, 523, 587, 523, 494, 440]; // happy motif

export function setTheme(next: Theme): void {
  if (next === theme && droneNodes.length) return;
  theme = next;
  if (!initialized) return;
  stopMusic();
  if (musicOn) startMusic();
}

function startMusic(): void {
  if (!ctx || !musicGain) return;
  if (droneNodes.length) return;
  try {
    const drones = theme === 'earth' ? EARTH_DRONE : SPACE_DRONE;
    musicGain.gain.cancelScheduledValues(now());
    musicGain.gain.setValueAtTime(0.0001, now());
    musicGain.gain.linearRampToValueAtTime(theme === 'earth' ? 0.6 : 0.45, now() + 2.0);
    for (const f of drones) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      g.gain.value = theme === 'earth' ? 0.05 : 0.06;
      osc.connect(g);
      g.connect(musicGain);
      osc.start();
      droneNodes.push(osc);
    }
    melodyToken++;
    scheduleMelody(melodyToken, 0);
  } catch {
    /* ignore */
  }
}

function scheduleMelody(token: number, step: number): void {
  if (!ctx || !musicGain) return;
  if (token !== melodyToken || !musicOn) return;
  try {
    const earth = theme === 'earth';
    const scale = earth ? EARTH_MELODY : SPACE_SCALE;
    const f = earth ? scale[step % scale.length]! : scale[Math.floor(Math.random() * scale.length)]!;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = earth ? 'triangle' : 'triangle';
    osc.frequency.value = earth ? f : f * 2;
    const t0 = now();
    const peak = earth ? 0.07 : 0.05;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + (earth ? 0.9 : 1.4));
    osc.connect(g);
    g.connect(musicGain);
    osc.start(t0);
    osc.stop(t0 + (earth ? 1.0 : 1.5));
  } catch {
    /* ignore */
  }
  const gap = theme === 'earth' ? 540 : 1100 + Math.random() * 1300;
  melodyTimer = window.setTimeout(() => scheduleMelody(token, step + 1), gap);
}

function stopMusic(): void {
  melodyToken++;
  if (melodyTimer !== null) {
    clearTimeout(melodyTimer);
    melodyTimer = null;
  }
  try {
    if (musicGain && ctx) {
      musicGain.gain.cancelScheduledValues(now());
      musicGain.gain.setValueAtTime(musicGain.gain.value, now());
      musicGain.gain.linearRampToValueAtTime(0.0001, now() + 0.5);
    }
    for (const o of droneNodes) {
      try {
        o.stop(now() + 0.6);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  droneNodes = [];
}

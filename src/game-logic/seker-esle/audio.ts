// Procedural Web Audio engine — first sound system in the repo.
// All sounds synthesized at runtime (OscillatorNode + GainNode).
// Zero audio assets, zero bandwidth.
//
// iOS Safari guards: lazy init on first user gesture, suspend on hidden,
// resume on visible. Polyphony cap to avoid CPU spikes during cascades.

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let masterFilter: BiquadFilterNode | null = null;
let enabled = true;
let initialized = false;
let activeVoices = 0;
const MAX_VOICES = 24;

export function setEnabled(value: boolean): void {
  enabled = value;
  if (masterGain && ctx) {
    masterGain.gain.setTargetAtTime(value ? 0.7 : 0, ctx.currentTime, 0.05);
  }
}

export function isEnabled(): boolean {
  return enabled;
}

export function ensureAudio(): void {
  if (initialized) {
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    return;
  }
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    masterFilter = ctx.createBiquadFilter();
    masterFilter.type = 'lowpass';
    masterFilter.frequency.value = 14000;
    masterGain = ctx.createGain();
    masterGain.gain.value = enabled ? 0.7 : 0;
    masterFilter.connect(masterGain);
    masterGain.connect(ctx.destination);
    initialized = true;
    document.addEventListener('visibilitychange', () => {
      if (!ctx) return;
      if (document.hidden) ctx.suspend().catch(() => {});
      else ctx.resume().catch(() => {});
    });
  } catch {
    initialized = false;
  }
}

interface ToneOpts {
  wave: OscillatorType;
  freq: number;
  dur: number;
  attack?: number;
  release?: number;
  peakGain?: number;
  slideTo?: number;
  detune?: number;
  delay?: number;
}

function playTone(opts: ToneOpts): void {
  if (!ctx || !masterFilter || !enabled) return;
  if (activeVoices >= MAX_VOICES) return;
  const t0 = ctx.currentTime + (opts.delay ?? 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = opts.wave;
  osc.frequency.setValueAtTime(opts.freq, t0);
  if (opts.slideTo !== undefined) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slideTo), t0 + opts.dur);
  }
  if (opts.detune) osc.detune.value = opts.detune;
  const attack = opts.attack ?? 0.005;
  const release = opts.release ?? 0.04;
  const peak = Math.max(0.0001, opts.peakGain ?? 0.18);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
  g.gain.setValueAtTime(peak, t0 + Math.max(attack, opts.dur - release));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
  osc.connect(g);
  g.connect(masterFilter);
  osc.start(t0);
  osc.stop(t0 + opts.dur + 0.02);
  activeVoices += 1;
  osc.onended = () => {
    activeVoices = Math.max(0, activeVoices - 1);
    osc.disconnect();
    g.disconnect();
  };
}

interface NoiseOpts {
  dur: number;
  peakGain?: number;
  filterFreq?: number;
  filterType?: BiquadFilterType;
  delay?: number;
}

function playNoise(opts: NoiseOpts): void {
  if (!ctx || !masterFilter || !enabled) return;
  if (activeVoices >= MAX_VOICES) return;
  const t0 = ctx.currentTime + (opts.delay ?? 0);
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * opts.dur)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.8;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = opts.filterType ?? 'bandpass';
  filter.frequency.value = opts.filterFreq ?? 1200;
  filter.Q.value = 1.2;
  const g = ctx.createGain();
  const peak = opts.peakGain ?? 0.18;
  g.gain.setValueAtTime(peak, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + opts.dur);
  src.connect(filter);
  filter.connect(g);
  g.connect(masterFilter);
  src.start(t0);
  src.stop(t0 + opts.dur + 0.02);
  activeVoices += 1;
  src.onended = () => {
    activeVoices = Math.max(0, activeVoices - 1);
    src.disconnect();
    filter.disconnect();
    g.disconnect();
  };
}

const C4 = 261.63;
const semi = (base: number, n: number): number => base * Math.pow(2, n / 12);

// ────────────── Sound recipes ──────────────

export function sfxSwap(): void {
  playTone({ wave: 'square', freq: 440, dur: 0.05, peakGain: 0.12, release: 0.03 });
}

export function sfxMatch(size: number, cascadeDepth: number): void {
  const baseShift = Math.pow(1.122, cascadeDepth);
  const root = C4 * baseShift;
  const notes = size >= 5 ? [0, 4, 7, 12] : size === 4 ? [0, 4, 7, 11] : [0, 4, 7];
  notes.forEach((n, i) => {
    playTone({
      wave: 'sine',
      freq: semi(root, n),
      dur: 0.16,
      peakGain: 0.16,
      delay: i * 0.045,
      release: 0.08,
    });
  });
}

export function sfxSpecialSpawn(): void {
  playNoise({ dur: 0.04, filterFreq: 3000, peakGain: 0.14 });
  playTone({ wave: 'sine', freq: 600, dur: 0.18, slideTo: 1400, peakGain: 0.15, delay: 0.02 });
}

export function sfxStripedFire(): void {
  playTone({
    wave: 'sawtooth', freq: 880, slideTo: 220, dur: 0.22, peakGain: 0.18, release: 0.1,
  });
}

export function sfxWrappedExplode(): void {
  playNoise({ dur: 0.22, filterFreq: 800, filterType: 'lowpass', peakGain: 0.22 });
  playTone({ wave: 'sine', freq: 80, dur: 0.18, peakGain: 0.22, slideTo: 50 });
}

export function sfxColorBomb(): void {
  playNoise({ dur: 0.5, filterFreq: 4000, filterType: 'bandpass', peakGain: 0.2 });
  for (let i = 0; i < 6; i++) {
    playTone({
      wave: 'triangle',
      freq: semi(C4, i * 2 + 4),
      dur: 0.18,
      peakGain: 0.12,
      delay: i * 0.06,
    });
  }
}

export function sfxLevelComplete(): void {
  const roots = [0, 5, 7, 12]; // I IV V I
  roots.forEach((n, i) => {
    playTone({
      wave: 'triangle',
      freq: semi(C4 * 2, n),
      dur: 0.32,
      peakGain: 0.18,
      delay: i * 0.22,
      release: 0.18,
    });
    playTone({
      wave: 'sine',
      freq: semi(C4, n),
      dur: 0.32,
      peakGain: 0.12,
      delay: i * 0.22,
      release: 0.18,
    });
  });
}

export function sfxLevelFail(): void {
  const notes = [0, -1, -3, -5];
  notes.forEach((n, i) => {
    playTone({
      wave: 'sine',
      freq: semi(C4 * 2, n),
      dur: 0.24,
      peakGain: 0.14,
      delay: i * 0.2,
      release: 0.14,
    });
  });
}

export function sfxStarEarned(starIndex: 0 | 1 | 2): void {
  const base = C4 * 4;
  const offsets = [0, 3, 7, 12];
  const o = offsets[starIndex] ?? 0;
  playTone({ wave: 'triangle', freq: semi(base, o), dur: 0.12, peakGain: 0.18, delay: 0 });
  playTone({ wave: 'triangle', freq: semi(base, o + 4), dur: 0.16, peakGain: 0.16, delay: 0.06 });
  playTone({ wave: 'triangle', freq: semi(base, o + 7), dur: 0.18, peakGain: 0.14, delay: 0.12 });
}

export function sfxButton(): void {
  playTone({ wave: 'sine', freq: 760, dur: 0.04, peakGain: 0.1 });
}

export function sfxStreakReward(): void {
  for (const n of [0, 4, 7]) {
    playTone({ wave: 'sine', freq: semi(C4 * 2, n), dur: 0.4, peakGain: 0.14, release: 0.3 });
  }
}

export function sfxHammer(): void {
  playNoise({ dur: 0.08, filterFreq: 600, filterType: 'lowpass', peakGain: 0.2 });
  playTone({ wave: 'sine', freq: 80, dur: 0.08, peakGain: 0.2 });
}

export function sfxComboBanner(depth: number): void {
  const root = C4 * 4 * Math.pow(1.06, depth);
  playTone({ wave: 'triangle', freq: root, dur: 0.18, peakGain: 0.18 });
  playTone({ wave: 'triangle', freq: root * 1.5, dur: 0.16, peakGain: 0.14, delay: 0.06 });
}

export function sfxTick(): void {
  playTone({ wave: 'sine', freq: 1320, dur: 0.025, peakGain: 0.08 });
}

export function sfxAchievementUnlock(): void {
  for (let i = 0; i < 4; i++) {
    playTone({
      wave: 'triangle',
      freq: semi(C4 * 2, i * 3),
      dur: 0.14,
      peakGain: 0.16,
      delay: i * 0.07,
    });
  }
}

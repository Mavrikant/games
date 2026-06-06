import { defineGame } from '@shared/game-module';
import { reportGameOver } from '@shared/leaderboard';

// Vardiya — sosyo-teknik vardiya planlama bulmacası.
// Pitfalls actively guarded:
// - overlay-input-leak: explicit state machine; cell/worker clicks no-op outside 'planning'.
// - stale-async-callback: no async work; reset() bumps gen for future-proofing.
// - unguarded-storage: safeRead/safeWrite wrap localStorage with try/catch.
// - duplicate-with-shared-layer: body has no <h1>, hint or how-to; layout supplies these.
// - invisible-boot: init() renders grid + workers + level 1 demand before any user input.
// - visual-vs-hitbox: DOM <button> elements; hitbox = visual element, no offset math.

type GameState = 'planning' | 'reviewing' | 'levelComplete' | 'gameComplete';
type Skill = 'A' | 'B';

interface Worker {
  id: string;
  name: string;
  skill: Skill;
  isSenior: boolean;
  maxShifts: number;
  forbiddenDays: number[];
}

interface CellDemand {
  A: number;
  B: number;
  needsSenior: boolean;
}

interface Cell {
  id: string;
  day: number;
  shift: number;
  demand: CellDemand;
}

interface LevelRules {
  weeklyCap: boolean;
  backToBack: boolean;
  personalForbidden: boolean;
  seniorRequired: boolean;
}

interface Level {
  id: number;
  title: string;
  hint: string;
  days: number;
  workers: Worker[];
  cells: Cell[];
  threshold: number;
  rules: LevelRules;
}

type ViolationKind =
  | 'demand'
  | 'weekly-cap'
  | 'back-to-back'
  | 'personal'
  | 'senior-missing';

interface Violation {
  kind: ViolationKind;
  workerId?: string;
  cellId?: string;
  detail: string;
}

interface EvalReport {
  coverage: number;
  happiness: number;
  score: number;
  passed: boolean;
  totalCells: number;
  metCells: number;
  violations: Violation[];
  unmetCellIds: string[];
}

const STORAGE_BEST_LEVEL = 'vardiya.bestLevel';
const STORAGE_BEST_SCORE = 'vardiya.bestScore';
const SCORE_DESC = { gameId: 'vardiya', storageKey: STORAGE_BEST_SCORE, direction: 'higher' as const };
const DAY_NAMES = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum'];
const SHIFT_NAMES = ['Gündüz', 'Akşam'];
const SHIFT_ICONS = ['☼', '☾'];

function cellId(day: number, shift: number): string {
  return `d${day}s${shift}`;
}

function makeCells(days: number, demands: CellDemand[][]): Cell[] {
  const out: Cell[] = [];
  for (let d = 0; d < days; d++) {
    for (let s = 0; s < 2; s++) {
      out.push({
        id: cellId(d, s),
        day: d,
        shift: s,
        demand: demands[d]![s]!,
      });
    }
  }
  return out;
}

function dem(A: number, B: number, needsSenior = false): CellDemand {
  return { A, B, needsSenior };
}

function uniformDemand(days: number, A: number, B: number, needsSenior = false): CellDemand[][] {
  const out: CellDemand[][] = [];
  for (let d = 0; d < days; d++) {
    out.push([dem(A, B, needsSenior), dem(A, B, needsSenior)]);
  }
  return out;
}

const LEVELS: Level[] = [
  {
    id: 1,
    title: 'Tanışma',
    hint: 'Her vardiyada bir A ve bir B yetenekli gerekli. Yeteneği eşle, bitti.',
    days: 3,
    workers: [
      { id: 'w1', name: 'Ali', skill: 'A', isSenior: false, maxShifts: 6, forbiddenDays: [] },
      { id: 'w2', name: 'Ayşe', skill: 'B', isSenior: false, maxShifts: 6, forbiddenDays: [] },
      { id: 'w3', name: 'Burak', skill: 'A', isSenior: false, maxShifts: 6, forbiddenDays: [] },
      { id: 'w4', name: 'Cem', skill: 'B', isSenior: false, maxShifts: 6, forbiddenDays: [] },
    ],
    cells: makeCells(3, uniformDemand(3, 1, 1)),
    threshold: 80,
    rules: {
      weeklyCap: false,
      backToBack: false,
      personalForbidden: false,
      seniorRequired: false,
    },
  },
  {
    id: 2,
    title: 'Haftalık limit',
    hint: 'Hiç kimse haftada 5 vardiyadan fazlasını çekemez. Yükü dağıt.',
    days: 5,
    workers: [
      { id: 'w1', name: 'Ali', skill: 'A', isSenior: false, maxShifts: 5, forbiddenDays: [] },
      { id: 'w2', name: 'Ayşe', skill: 'B', isSenior: false, maxShifts: 5, forbiddenDays: [] },
      { id: 'w3', name: 'Burak', skill: 'A', isSenior: false, maxShifts: 5, forbiddenDays: [] },
      { id: 'w4', name: 'Cem', skill: 'B', isSenior: false, maxShifts: 5, forbiddenDays: [] },
    ],
    cells: makeCells(5, uniformDemand(5, 1, 1)),
    threshold: 75,
    rules: {
      weeklyCap: true,
      backToBack: false,
      personalForbidden: false,
      seniorRequired: false,
    },
  },
  {
    id: 3,
    title: 'Yorgunluk',
    hint: 'Akşam vardiyasından çıkan ertesi gün gündüze gelirse mutsuz olur (arka arkaya yasak).',
    days: 5,
    workers: [
      { id: 'w1', name: 'Ali', skill: 'A', isSenior: false, maxShifts: 5, forbiddenDays: [] },
      { id: 'w2', name: 'Ayşe', skill: 'B', isSenior: false, maxShifts: 5, forbiddenDays: [] },
      { id: 'w3', name: 'Burak', skill: 'A', isSenior: false, maxShifts: 5, forbiddenDays: [] },
      { id: 'w4', name: 'Cem', skill: 'B', isSenior: false, maxShifts: 5, forbiddenDays: [] },
      { id: 'w5', name: 'Defne', skill: 'A', isSenior: false, maxShifts: 4, forbiddenDays: [] },
      { id: 'w6', name: 'Elif', skill: 'B', isSenior: false, maxShifts: 4, forbiddenDays: [] },
    ],
    cells: makeCells(5, uniformDemand(5, 1, 1)),
    threshold: 70,
    rules: {
      weeklyCap: true,
      backToBack: true,
      personalForbidden: false,
      seniorRequired: false,
    },
  },
  {
    id: 4,
    title: 'Kişisel kısıtlar',
    hint: 'Bazı çalışanların belirli günleri vardiyaya gelemez. Profillerine bak.',
    days: 5,
    workers: [
      { id: 'w1', name: 'Ali', skill: 'A', isSenior: false, maxShifts: 4, forbiddenDays: [2] },
      { id: 'w2', name: 'Ayşe', skill: 'B', isSenior: false, maxShifts: 4, forbiddenDays: [4] },
      { id: 'w3', name: 'Burak', skill: 'A', isSenior: false, maxShifts: 4, forbiddenDays: [0] },
      { id: 'w4', name: 'Cem', skill: 'B', isSenior: false, maxShifts: 4, forbiddenDays: [3] },
      { id: 'w5', name: 'Defne', skill: 'A', isSenior: false, maxShifts: 4, forbiddenDays: [] },
      { id: 'w6', name: 'Elif', skill: 'B', isSenior: false, maxShifts: 4, forbiddenDays: [] },
    ],
    cells: makeCells(5, uniformDemand(5, 1, 1)),
    threshold: 65,
    rules: {
      weeklyCap: true,
      backToBack: true,
      personalForbidden: true,
      seniorRequired: false,
    },
  },
  {
    id: 5,
    title: 'Kıdemli gerekli',
    hint: 'Akşam vardiyalarında en az bir kıdemli (⭐) bulunmalı.',
    days: 5,
    workers: [
      { id: 'w1', name: 'Ali', skill: 'A', isSenior: true, maxShifts: 4, forbiddenDays: [2] },
      { id: 'w2', name: 'Ayşe', skill: 'B', isSenior: false, maxShifts: 4, forbiddenDays: [4] },
      { id: 'w3', name: 'Burak', skill: 'A', isSenior: false, maxShifts: 4, forbiddenDays: [0] },
      { id: 'w4', name: 'Cem', skill: 'B', isSenior: true, maxShifts: 4, forbiddenDays: [3] },
      { id: 'w5', name: 'Defne', skill: 'A', isSenior: false, maxShifts: 4, forbiddenDays: [] },
      { id: 'w6', name: 'Elif', skill: 'B', isSenior: false, maxShifts: 4, forbiddenDays: [] },
    ],
    cells: makeCells(5, [
      [dem(1, 1, false), dem(1, 1, true)],
      [dem(1, 1, false), dem(1, 1, true)],
      [dem(1, 1, false), dem(1, 1, true)],
      [dem(1, 1, false), dem(1, 1, true)],
      [dem(1, 1, false), dem(1, 1, true)],
    ]),
    threshold: 60,
    rules: {
      weeklyCap: true,
      backToBack: true,
      personalForbidden: true,
      seniorRequired: true,
    },
  },
];

let gridEl!: HTMLElement;
let workersEl!: HTMLElement;
let statusEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let levelEl!: HTMLElement;
let commitBtn!: HTMLButtonElement;
let clearBtn!: HTMLButtonElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitleEl!: HTMLElement;
let overlayMsgEl!: HTMLElement;
let overlayDetailsEl!: HTMLElement;
let overlayRetryBtn!: HTMLButtonElement;
let overlayNextBtn!: HTMLButtonElement;

let state: GameState = 'planning';
let levelIdx = 0;
let assignments: Record<string, string[]> = {};
let selectedCellId: string | null = null;
let lastScore = 0;
let bestLevel = 1;
let bestScore = 0;
let gen = 0;

function level(): Level {
  return LEVELS[levelIdx]!;
}

function safeRead(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function safeWrite(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

function workerById(id: string): Worker | undefined {
  return level().workers.find((w) => w.id === id);
}

function cellById(id: string): Cell | undefined {
  return level().cells.find((c) => c.id === id);
}

function workerLoad(): Record<string, string[]> {
  const load: Record<string, string[]> = {};
  for (const w of level().workers) load[w.id] = [];
  for (const [cid, ws] of Object.entries(assignments)) {
    for (const wid of ws) {
      const arr = load[wid];
      if (arr) arr.push(cid);
    }
  }
  return load;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;'
    : c === '<' ? '&lt;'
    : c === '>' ? '&gt;'
    : c === '"' ? '&quot;'
    : '&#39;',
  );
}

function evaluate(): EvalReport {
  const lvl = level();
  const violations: Violation[] = [];
  const unmetCellIds: string[] = [];
  let metCells = 0;

  for (const cell of lvl.cells) {
    const workers = (assignments[cell.id] ?? []).map((id) => workerById(id)).filter(Boolean) as Worker[];
    const aCount = workers.filter((w) => w.skill === 'A').length;
    const bCount = workers.filter((w) => w.skill === 'B').length;
    const hasSenior = workers.some((w) => w.isSenior);

    let ok = aCount >= cell.demand.A && bCount >= cell.demand.B;
    if (lvl.rules.seniorRequired && cell.demand.needsSenior && !hasSenior) {
      ok = false;
      violations.push({
        kind: 'senior-missing',
        cellId: cell.id,
        detail: `${DAY_NAMES[cell.day]} ${SHIFT_NAMES[cell.shift]}: kıdemli yok.`,
      });
    }

    if (ok) {
      metCells++;
    } else {
      unmetCellIds.push(cell.id);
      if (aCount < cell.demand.A || bCount < cell.demand.B) {
        violations.push({
          kind: 'demand',
          cellId: cell.id,
          detail: `${DAY_NAMES[cell.day]} ${SHIFT_NAMES[cell.shift]}: ${cell.demand.A}A · ${cell.demand.B}B gerekli, ${aCount}A · ${bCount}B atandı.`,
        });
      }
    }
  }

  const load = workerLoad();

  if (lvl.rules.weeklyCap) {
    for (const w of lvl.workers) {
      const n = load[w.id]!.length;
      if (n > w.maxShifts) {
        violations.push({
          kind: 'weekly-cap',
          workerId: w.id,
          detail: `${w.name} ${n} vardiyada (max ${w.maxShifts}).`,
        });
      }
    }
  }

  if (lvl.rules.backToBack) {
    for (const w of lvl.workers) {
      const cellsOfW = load[w.id]!.map((id) => cellById(id)!).filter(Boolean);
      const byDay = new Map<number, Set<number>>();
      for (const c of cellsOfW) {
        if (!byDay.has(c.day)) byDay.set(c.day, new Set());
        byDay.get(c.day)!.add(c.shift);
      }
      for (let d = 0; d < lvl.days - 1; d++) {
        const today = byDay.get(d);
        const tomorrow = byDay.get(d + 1);
        if (today?.has(1) && tomorrow?.has(0)) {
          violations.push({
            kind: 'back-to-back',
            workerId: w.id,
            detail: `${w.name}: ${DAY_NAMES[d]} akşam → ${DAY_NAMES[d + 1]} gündüz (yorgun).`,
          });
        }
      }
    }
  }

  if (lvl.rules.personalForbidden) {
    for (const w of lvl.workers) {
      if (w.forbiddenDays.length === 0) continue;
      const cellsOfW = load[w.id]!.map((id) => cellById(id)!).filter(Boolean);
      for (const c of cellsOfW) {
        if (w.forbiddenDays.includes(c.day)) {
          violations.push({
            kind: 'personal',
            workerId: w.id,
            cellId: c.id,
            detail: `${w.name}: ${DAY_NAMES[c.day]} günü yasaklı, atanmış.`,
          });
        }
      }
    }
  }

  const totalCells = lvl.cells.length;
  const coverage = totalCells === 0 ? 0 : metCells / totalCells;
  const workerCount = Math.max(1, lvl.workers.length);
  const happiness = Math.max(0, 1 - violations.filter((v) => v.kind !== 'demand').length / workerCount);
  const score = Math.round(coverage * happiness * 100);
  const passed = score >= lvl.threshold;

  return { coverage, happiness, score, passed, totalCells, metCells, violations, unmetCellIds };
}

function renderGrid(): void {
  const lvl = level();
  gridEl.style.setProperty('--vd-cols', String(lvl.days));
  gridEl.innerHTML = '';

  const corner = document.createElement('div');
  corner.className = 'vd-grid__corner';
  corner.setAttribute('aria-hidden', 'true');
  gridEl.appendChild(corner);

  for (let d = 0; d < lvl.days; d++) {
    const head = document.createElement('div');
    head.className = 'vd-grid__day';
    head.textContent = DAY_NAMES[d] ?? `Gün ${d + 1}`;
    head.setAttribute('role', 'columnheader');
    gridEl.appendChild(head);
  }

  for (let s = 0; s < 2; s++) {
    const label = document.createElement('div');
    label.className = 'vd-grid__shift';
    label.setAttribute('role', 'rowheader');
    label.innerHTML = `<span class="vd-grid__shift-icon">${SHIFT_ICONS[s]}</span>${SHIFT_NAMES[s]}`;
    gridEl.appendChild(label);

    for (let d = 0; d < lvl.days; d++) {
      const cell = lvl.cells.find((c) => c.day === d && c.shift === s)!;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'vd-cell';
      btn.dataset.cellId = cell.id;
      btn.setAttribute('role', 'gridcell');
      const seniorBadge = cell.demand.needsSenior && lvl.rules.seniorRequired ? ' ★' : '';
      btn.setAttribute(
        'aria-label',
        `${DAY_NAMES[cell.day]} ${SHIFT_NAMES[cell.shift]}, ${cell.demand.A} A ve ${cell.demand.B} B gerekli${seniorBadge ? ', kıdemli gerekli' : ''}`,
      );
      btn.innerHTML = `
        <span class="vd-cell__demand">
          <span class="vd-demand-pill vd-demand-pill--A">${cell.demand.A}A</span>
          <span class="vd-demand-pill vd-demand-pill--B">${cell.demand.B}B</span>
          ${seniorBadge ? '<span class="vd-demand-pill vd-demand-pill--senior" title="Kıdemli gerekli">★</span>' : ''}
        </span>
        <span class="vd-cell__slots" data-slots="${escapeHtml(cell.id)}"></span>
      `;
      gridEl.appendChild(btn);
    }
  }
}

function renderAssignments(): void {
  const lvl = level();
  const load = workerLoad();

  const cellBtns = gridEl.querySelectorAll<HTMLButtonElement>('.vd-cell');
  cellBtns.forEach((btn) => {
    const cid = btn.dataset.cellId!;
    const ws = (assignments[cid] ?? []).map((id) => workerById(id)).filter(Boolean) as Worker[];
    const slotsEl = btn.querySelector<HTMLElement>('.vd-cell__slots');
    if (!slotsEl) return;
    slotsEl.innerHTML = '';
    for (const w of ws) {
      const chip = document.createElement('span');
      chip.className = `vd-slot vd-slot--${w.skill}${w.isSenior ? ' vd-slot--senior' : ''}`;
      chip.dataset.workerId = w.id;
      chip.dataset.cellId = cid;
      chip.title = `${w.name} (${w.skill}${w.isSenior ? ', kıdemli' : ''}) — tıkla, kaldır.`;
      chip.textContent = w.isSenior ? `★${w.name}` : w.name;
      slotsEl.appendChild(chip);
    }
    btn.classList.toggle('vd-cell--selected', selectedCellId === cid);
  });

  const chips = workersEl.querySelectorAll<HTMLButtonElement>('.vd-worker');
  chips.forEach((chip) => {
    const wid = chip.dataset.workerId!;
    const w = workerById(wid);
    if (!w) return;
    const used = load[wid]?.length ?? 0;
    const capEl = chip.querySelector<HTMLElement>('.vd-worker__cap');
    if (capEl) capEl.textContent = `${used}/${w.maxShifts}`;
    chip.classList.toggle('vd-worker--full', used >= w.maxShifts && lvl.rules.weeklyCap);
    const inSelected =
      selectedCellId !== null && (assignments[selectedCellId] ?? []).includes(wid);
    chip.classList.toggle('vd-worker--assigned', inSelected);
  });
}

function renderWorkers(): void {
  const lvl = level();
  workersEl.innerHTML = '';
  for (const w of lvl.workers) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = `vd-worker vd-worker--${w.skill}${w.isSenior ? ' vd-worker--senior' : ''}`;
    chip.dataset.workerId = w.id;
    const forbiddenLabel =
      lvl.rules.personalForbidden && w.forbiddenDays.length > 0
        ? `<span class="vd-worker__forbidden">yasak: ${w.forbiddenDays.map((d) => DAY_NAMES[d]).join(', ')}</span>`
        : '';
    chip.innerHTML = `
      <span class="vd-worker__name">${w.isSenior ? '★ ' : ''}${escapeHtml(w.name)}</span>
      <span class="vd-worker__meta">
        <span class="vd-worker__skill">${w.skill}</span>
        <span class="vd-worker__cap">0/${w.maxShifts}</span>
      </span>
      ${forbiddenLabel}
    `;
    workersEl.appendChild(chip);
  }
}

function syncHud(): void {
  const lvl = level();
  levelEl.textContent = `${lvl.id}/${LEVELS.length}`;
  scoreEl.textContent = state === 'planning' ? '—' : String(lastScore);
  bestEl.textContent = String(bestScore);
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function setSelectedCell(cid: string | null): void {
  selectedCellId = cid;
  renderAssignments();
  if (cid) {
    const c = cellById(cid);
    if (c) {
      setStatus(
        `${DAY_NAMES[c.day]} ${SHIFT_NAMES[c.shift]} seçildi — ${c.demand.A}A · ${c.demand.B}B${c.demand.needsSenior && level().rules.seniorRequired ? ' · ★' : ''} gerekli. Çalışan rozetine tıkla.`,
      );
    }
  } else {
    setStatus('Hücreye tıkla, sonra çalışan rozetine tıkla. Hazır olunca Onayla.');
  }
}

function toggleAssignment(cid: string, wid: string): void {
  const list = assignments[cid] ?? [];
  const idx = list.indexOf(wid);
  if (idx >= 0) {
    list.splice(idx, 1);
  } else {
    list.push(wid);
  }
  assignments[cid] = list;
  renderAssignments();
}

function removeAssignment(cid: string, wid: string): void {
  const list = assignments[cid] ?? [];
  const idx = list.indexOf(wid);
  if (idx >= 0) {
    list.splice(idx, 1);
    assignments[cid] = list;
    renderAssignments();
  }
}

function clearAssignments(): void {
  assignments = {};
  for (const c of level().cells) assignments[c.id] = [];
  renderAssignments();
}

function showOverlay(report: EvalReport): void {
  const lvl = level();
  overlayTitleEl.textContent = report.passed ? `✓ ${lvl.title}` : `Eksik — ${lvl.title}`;
  overlayMsgEl.textContent = report.passed
    ? `Skor ${report.score} (eşik ${lvl.threshold}). Kapsama %${Math.round(report.coverage * 100)} · Mutluluk %${Math.round(report.happiness * 100)}.`
    : `Skor ${report.score} (eşik ${lvl.threshold}). Kapsama %${Math.round(report.coverage * 100)} · Mutluluk %${Math.round(report.happiness * 100)}.`;

  overlayDetailsEl.innerHTML = '';
  const shown = report.violations.slice(0, 6);
  for (const v of shown) {
    const li = document.createElement('li');
    li.className = `vd-overlay__v vd-overlay__v--${v.kind}`;
    li.textContent = v.detail;
    overlayDetailsEl.appendChild(li);
  }
  if (report.violations.length > shown.length) {
    const li = document.createElement('li');
    li.className = 'vd-overlay__v vd-overlay__v--more';
    li.textContent = `… ve ${report.violations.length - shown.length} ihlal daha.`;
    overlayDetailsEl.appendChild(li);
  }
  if (report.violations.length === 0) {
    const li = document.createElement('li');
    li.className = 'vd-overlay__v vd-overlay__v--clean';
    li.textContent = 'Hiç ihlal yok. Plan temiz.';
    overlayDetailsEl.appendChild(li);
  }

  const isLast = levelIdx >= LEVELS.length - 1;
  overlayRetryBtn.hidden = false;
  overlayNextBtn.hidden = !report.passed;
  overlayNextBtn.textContent = isLast ? 'Bitir' : 'Sonraki level';

  overlayEl.hidden = false;
  overlayEl.setAttribute('aria-hidden', 'false');
  overlayEl.classList.add('vd-overlay--open');
}

function hideOverlay(): void {
  overlayEl.hidden = true;
  overlayEl.setAttribute('aria-hidden', 'true');
  overlayEl.classList.remove('vd-overlay--open');
}

function commit(): void {
  if (state !== 'planning') return;
  const report = evaluate();
  lastScore = report.score;
  if (report.score > bestScore) {
    bestScore = report.score;
    safeWrite(STORAGE_BEST_SCORE, bestScore);
  }
  if (report.passed && level().id > bestLevel) {
    bestLevel = level().id;
    safeWrite(STORAGE_BEST_LEVEL, bestLevel);
  }
  reportGameOver(SCORE_DESC, report.score);
  state = report.passed ? 'levelComplete' : 'reviewing';
  syncHud();
  showOverlay(report);
}

function retry(): void {
  if (state !== 'reviewing' && state !== 'levelComplete') return;
  state = 'planning';
  hideOverlay();
  setSelectedCell(null);
  setStatus('Atamaları düzenle, tekrar Onayla.');
}

function next(): void {
  if (state !== 'levelComplete') return;
  if (levelIdx >= LEVELS.length - 1) {
    state = 'gameComplete';
    setStatus(`Tebrikler — tüm ${LEVELS.length} level çözüldü. En iyi skor: ${bestScore}.`);
    overlayTitleEl.textContent = 'Bitti';
    overlayMsgEl.textContent = `Tüm leveller geçildi. En iyi skor: ${bestScore}.`;
    overlayRetryBtn.hidden = false;
    overlayNextBtn.hidden = true;
    overlayEl.hidden = false;
    overlayEl.setAttribute('aria-hidden', 'false');
    return;
  }
  levelIdx++;
  state = 'planning';
  selectedCellId = null;
  assignments = {};
  for (const c of level().cells) assignments[c.id] = [];
  hideOverlay();
  renderGrid();
  renderWorkers();
  renderAssignments();
  syncHud();
  setStatus(`Level ${level().id} — ${level().hint}`);
}

function fullReset(): void {
  gen++;
  state = 'planning';
  levelIdx = 0;
  lastScore = 0;
  selectedCellId = null;
  assignments = {};
  for (const c of level().cells) assignments[c.id] = [];
  hideOverlay();
  renderGrid();
  renderWorkers();
  renderAssignments();
  syncHud();
  setStatus(`Level ${level().id} — ${level().hint}`);
}

function _wire(): void {
gridEl.addEventListener('click', (e) => {
  if (state !== 'planning') return;
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const slot = target.closest<HTMLElement>('.vd-slot');
  if (slot) {
    e.stopPropagation();
    const cid = slot.dataset.cellId!;
    const wid = slot.dataset.workerId!;
    removeAssignment(cid, wid);
    return;
  }
  const cellBtn = target.closest<HTMLElement>('.vd-cell');
  if (!cellBtn) return;
  const cid = cellBtn.dataset.cellId;
  if (!cid) return;
  setSelectedCell(selectedCellId === cid ? null : cid);
});

workersEl.addEventListener('click', (e) => {
  if (state !== 'planning') return;
  const target = e.target as HTMLElement | null;
  if (!target) return;
  const chip = target.closest<HTMLElement>('.vd-worker');
  if (!chip) return;
  const wid = chip.dataset.workerId;
  if (!wid) return;
  if (selectedCellId === null) {
    setStatus('Önce bir hücreye tıkla, sonra çalışan rozetine.');
    return;
  }
  toggleAssignment(selectedCellId, wid);
});

commitBtn.addEventListener('click', commit);
clearBtn.addEventListener('click', () => {
  if (state !== 'planning') return;
  clearAssignments();
  setSelectedCell(null);
});
restartBtn.addEventListener('click', fullReset);
overlayRetryBtn.addEventListener('click', retry);
overlayNextBtn.addEventListener('click', next);

window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'r') {
    fullReset();
    e.preventDefault();
    return;
  }
  if (state === 'planning') {
    if (k === 'enter') {
      commit();
      e.preventDefault();
    } else if (k === 'escape') {
      setSelectedCell(null);
      e.preventDefault();
    }
    return;
  }
  if (state === 'levelComplete') {
    if (k === 'n' || k === 'enter') {
      next();
      e.preventDefault();
    } else if (k === 'escape') {
      retry();
      e.preventDefault();
    }
    return;
  }
  if (state === 'reviewing') {
    if (k === 'enter' || k === 'escape') {
      retry();
      e.preventDefault();
    }
    return;
  }
});
}

function init(): void {
  gridEl = document.querySelector<HTMLElement>('#grid')!;
  workersEl = document.querySelector<HTMLElement>('#workers')!;
  statusEl = document.querySelector<HTMLElement>('#status')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  levelEl = document.querySelector<HTMLElement>('#level')!;
  commitBtn = document.querySelector<HTMLButtonElement>('#commit')!;
  clearBtn = document.querySelector<HTMLButtonElement>('#clear')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitleEl = document.querySelector<HTMLElement>('#overlayTitle')!;
  overlayMsgEl = document.querySelector<HTMLElement>('#overlayMsg')!;
  overlayDetailsEl = document.querySelector<HTMLElement>('#overlayDetails')!;
  overlayRetryBtn = document.querySelector<HTMLButtonElement>('#overlayRetry')!;
  overlayNextBtn = document.querySelector<HTMLButtonElement>('#overlayNext')!;

  _wire();

  bestScore = safeRead(STORAGE_BEST_SCORE, 0);
  bestLevel = safeRead(STORAGE_BEST_LEVEL, 1);
  levelIdx = 0;
  lastScore = 0;
  state = 'planning';
  clearAssignments();
  renderGrid();
  renderWorkers();
  renderAssignments();
  syncHud();
  setStatus(`Level ${level().id} — ${level().hint}`);
}

export const game = defineGame({ init, reset: fullReset });

declare global {
  interface Window {
    __vardiya?: {
      getState: () => GameState;
      getLevel: () => number;
      getScore: () => number;
      getBest: () => number;
      getAssignments: () => Record<string, string[]>;
      assign: (cid: string, wid: string) => void;
      unassign: (cid: string, wid: string) => void;
      selectCell: (cid: string | null) => void;
      commit: () => void;
      retry: () => void;
      next: () => void;
      reset: () => void;
      evaluate: () => EvalReport;
      levels: () => readonly Level[];
    };
  }
}
if (typeof window !== 'undefined') {
  window.__vardiya = {
    getState: () => state,
    getLevel: () => level().id,
    getScore: () => lastScore,
    getBest: () => bestScore,
    getAssignments: () => assignments,
    assign: (cid, wid) => {
      const list = assignments[cid] ?? [];
      if (!list.includes(wid)) {
        list.push(wid);
        assignments[cid] = list;
        renderAssignments();
      }
    },
    unassign: (cid, wid) => removeAssignment(cid, wid),
    selectCell: setSelectedCell,
    commit,
    retry,
    next,
    reset: fullReset,
    evaluate,
    levels: () => LEVELS,
  };
}

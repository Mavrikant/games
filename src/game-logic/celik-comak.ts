import { defineGame } from '@shared/game-module';
import { safeRead, safeWrite } from '@shared/storage';
import { createGenToken } from '@shared/gen-token';
import { showOverlay, hideOverlay } from '@shared/overlay';

// Çelik Çomak — geleneksel Türk sokak oyunu, iki-fazlı zamanlama arcade'i.
//
// Her atış:
//   1) Flip fazı: yatay gösterge sweet-spot'tan geçerken Space/tıkla → çelik
//      zıplama hızını alır (sweet-spot merkezine yakınlık doğru orantılı).
//   2) Rising/Falling: çelik yer çekimiyle havalanır + döner; input no-op.
//   3) Strike fazı: çelik strike penceresine girince dikey gösterge oluşur,
//      sweet-spot içinde Space/tıkla → yatay launch velocity (flip × strike).
//   4) Flight: projectile fizikle uçar, yere düşer; mesafe adım olarak ölçülür.
//   5) Land → bekle → sonraki atış (toplam 3) → game over.
//
// PITFALL guards:
//   - module-level-dom-access: tüm DOM/canvas erişimi init() içinde.
//   - unguarded-storage: safeRead/safeWrite.
//   - stale-async-callback: gen-token + RAF iptal'i; reset gen.bump() yapar
//     ve setTimeout chain'leri token check ile guard'lı.
//   - overlay-input-leak: state enum; her input handler durumu kontrol eder.
//   - missing-overlay-css: overlay--hidden ve overlay konum CSS'i style.css'te.
//   - invisible-boot: init() sonunda ilk frame çizilir + overlay görünür,
//     ilk Space/click anında 250ms içinde flip göstergesi görünür hale gelir.
//   - hud-counter-synced-only-at-lifecycle-edges: skor/atış HUD'u her durum
//     geçişinde anında güncellenir, bir yerde gizli mutate olmaz.
//   - visual-vs-hitbox: yok, çarpışma yok; ama strike penceresi tek const
//     ile hem fizik hem görsel besler.

// ---- Sabitler ----

const STORAGE_BEST = 'celik-comak.best';
const TOTAL_ATTEMPTS = 3;

const WIDTH = 640;
const HEIGHT = 360;
const GROUND_Y = 290; // y pozisyonu, ground top edge
const PLAYER_X = 90;
const CELIK_REST_X = 130; // çelik yerde duruyorsa
const CELIK_LEN = 26;
const STRIKE_X = 145; // strike hit edilebileceği x koordinatı
const STRIKE_RANGE = 26; // ±px tolerans

// Flip faz gösterge: yatay, soldan sağa kayan indicator
const FLIP_BAR_LEFT = 60;
const FLIP_BAR_RIGHT = 580;
const FLIP_BAR_Y = HEIGHT - 30;
const FLIP_BAR_DURATION_MS = 1400; // bar'ı bir uçtan diğerine sweep süresi
const FLIP_SWEET_CENTER = (FLIP_BAR_LEFT + FLIP_BAR_RIGHT) / 2;
const FLIP_SWEET_HALF = 60; // ±60px sweet zone

// Strike faz gösterge: dikey, yukarı-aşağı süzülen
const STRIKE_BAR_X = STRIKE_X + 40;
const STRIKE_BAR_TOP = 60;
const STRIKE_BAR_BOTTOM = GROUND_Y - 10;
const STRIKE_BAR_DURATION_MS = 1100;
const STRIKE_SWEET_CENTER = (STRIKE_BAR_TOP + STRIKE_BAR_BOTTOM) / 2;
const STRIKE_SWEET_HALF = 35;

// Fizik
const GRAVITY = 980; // px/s²
const MIN_FLIP_VY = 280; // px/s — sweet-spot kenarında zıplama hızı
const MAX_FLIP_VY = 560; // px/s — sweet-spot merkezinde
const MIN_STRIKE_VX = 240; // px/s
const MAX_STRIKE_VX = 720;
// Mesafe ölçeği: ekrandan çıkıp gidebilir; her 16 px = 1 adım
const DISTANCE_SCALE = 16;

// Görsel / sonuç gecikmeleri
const LAND_DELAY_MS = 900;
const READY_DELAY_MS = 350; // landed → next ready arası

// ---- State / DOM ----

type Phase =
  | 'idle' // overlay açık, başla tuşunu bekliyoruz (yeni atış için ready)
  | 'flip' // flip göstergesi koşuyor
  | 'rising' // çelik uçuyor (input yok)
  | 'strike' // strike göstergesi koşuyor (çelik strike zone'da)
  | 'flying' // çelik vurulup yatay uçuyor
  | 'landed' // çelik yere düştü, kısa bekleme
  | 'gameover'; // tüm atışlar bitti, overlay açık

let stage!: HTMLCanvasElement;
let ctx!: CanvasRenderingContext2D;
let attemptEl!: HTMLElement;
let lastEl!: HTMLElement;
let scoreEl!: HTMLElement;
let bestEl!: HTMLElement;
let restartBtn!: HTMLButtonElement;
let overlayEl!: HTMLElement;
let overlayTitle!: HTMLElement;
let overlayMsg!: HTMLElement;
let overlayAction!: HTMLButtonElement;

const gen = createGenToken();

let phase: Phase = 'idle';
let attempt = 0; // 0..TOTAL_ATTEMPTS
let total = 0;
let lastDistance = 0;
let best = 0;

// Faz state'leri
let flipStartedAt = 0;
let strikeStartedAt = 0;

// Çelik state (rising → flying → landed)
let celikX = CELIK_REST_X;
let celikY = GROUND_Y - CELIK_LEN / 2;
let celikVx = 0;
let celikVy = 0;
let celikRot = 0; // radyan
let celikSpin = 0; // rad/s
let phaseLastTs = 0; // RAF dt için

// RAF handle
let rafHandle: number | null = null;

// ---- Yardımcı: storage / best ----

function loadBest(): number {
  const raw = safeRead<unknown>(STORAGE_BEST, 0);
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function commitBest(): void {
  if (total > best) {
    best = total;
    safeWrite(STORAGE_BEST, best);
  }
}

// ---- HUD ----

function renderHud(): void {
  attemptEl.textContent =
    attempt >= TOTAL_ATTEMPTS
      ? `${TOTAL_ATTEMPTS}/${TOTAL_ATTEMPTS}`
      : `${attempt + 1}/${TOTAL_ATTEMPTS}`;
  lastEl.textContent = String(lastDistance);
  scoreEl.textContent = String(total);
  bestEl.textContent = String(best);
}

// ---- RAF döngüsü ----

function startLoop(): void {
  if (rafHandle !== null) return;
  phaseLastTs = performance.now();
  const token = gen.current();
  const loop = (ts: number): void => {
    if (token !== gen.current()) {
      rafHandle = null;
      return;
    }
    const dt = Math.min(0.05, (ts - phaseLastTs) / 1000);
    phaseLastTs = ts;
    update(dt);
    draw();
    rafHandle = requestAnimationFrame(loop);
  };
  rafHandle = requestAnimationFrame(loop);
}

function stopLoop(): void {
  if (rafHandle !== null) {
    cancelAnimationFrame(rafHandle);
    rafHandle = null;
  }
}

// ---- Update ----

function update(dt: number): void {
  if (phase === 'rising') {
    // Çelik dikey + biraz yatay (sağa doğru) uçuyor
    celikVy += GRAVITY * dt;
    celikX += celikVx * dt;
    celikY += celikVy * dt;
    celikRot += celikSpin * dt;
    // Çelik tekrar zemin seviyesine düştü mü? Çomak menziline geldiğinde
    // strike fazına geç.
    if (celikVy > 0 && celikY >= GROUND_Y - 80 && celikX >= STRIKE_X - STRIKE_RANGE) {
      enterStrikePhase();
    }
    // Çok düşerse strike kaçırıldı sayılır
    if (celikY >= GROUND_Y - CELIK_LEN / 2) {
      celikY = GROUND_Y - CELIK_LEN / 2;
      celikVy = 0;
      celikVx = 0;
      lastDistance = 0;
      enterLandedPhase();
    }
  } else if (phase === 'flying') {
    celikVy += GRAVITY * dt;
    celikX += celikVx * dt;
    celikY += celikVy * dt;
    celikRot += celikSpin * dt;
    if (celikY >= GROUND_Y - CELIK_LEN / 2) {
      celikY = GROUND_Y - CELIK_LEN / 2;
      const distPx = Math.max(0, celikX - PLAYER_X);
      lastDistance = Math.round(distPx / DISTANCE_SCALE);
      total += lastDistance;
      renderHud();
      enterLandedPhase();
    }
  }
}

// ---- Faz geçişleri ----

function startAttempt(): void {
  // Bir atışın başlangıcı: flip fazı başlar.
  phase = 'flip';
  flipStartedAt = performance.now();
  celikX = CELIK_REST_X;
  celikY = GROUND_Y - CELIK_LEN / 2;
  celikVx = 0;
  celikVy = 0;
  celikRot = 0;
  celikSpin = 0;
  hideOverlay(overlayEl);
  renderHud();
  startLoop();
}

function enterStrikePhase(): void {
  phase = 'strike';
  strikeStartedAt = performance.now();
}

function enterLandedPhase(): void {
  phase = 'landed';
  renderHud();
  attempt++;
  const token = gen.current();
  window.setTimeout(() => {
    if (token !== gen.current()) return;
    if (phase !== 'landed') return;
    if (attempt >= TOTAL_ATTEMPTS) {
      enterGameOver();
    } else {
      enterReadyForNext();
    }
  }, LAND_DELAY_MS);
}

function enterReadyForNext(): void {
  phase = 'idle';
  showOverlayReady();
  renderHud();
  // Hemen ardından flip fazına geçilebilmesi için kısa bir auto-start delay
  // istemiyoruz — overlay action butonu açıkça lazım, yoksa kullanıcı kafa
  // karışır. Ama RAF döngüsünü stop edelim ki idle iken CPU dönmesin.
  stopLoop();
  // Tek frame çiz: zemin + oyuncu + yerdeki çelik.
  draw();
}

function enterGameOver(): void {
  phase = 'gameover';
  commitBest();
  renderHud();
  showOverlayGameOver();
  stopLoop();
  draw();
}

function showOverlayReady(): void {
  if (attempt === 0) {
    overlayTitle.textContent = 'Çelik Çomak';
    overlayMsg.textContent =
      'İki fazlı zamanlama: önce çubuğu zıplat, sonra havadayken vur. Boşluk veya tıkla ile başla.';
    overlayAction.textContent = 'Başla';
  } else {
    overlayTitle.textContent = `Atış ${attempt + 1} / ${TOTAL_ATTEMPTS}`;
    overlayMsg.textContent =
      lastDistance > 0
        ? `Son atış: ${lastDistance} adım. Toplam: ${total}.`
        : `Son atış kaçtı. Toplam: ${total}.`;
    overlayAction.textContent = 'Devam';
  }
  showOverlay(overlayEl);
  try {
    overlayAction.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

function showOverlayGameOver(): void {
  const isRecord = total > best || (total === best && total > 0);
  overlayTitle.textContent = isRecord && total > 0 ? 'Yeni rekor!' : 'Tur bitti';
  overlayMsg.textContent =
    total > 0
      ? `Toplam: ${total} adım. En iyi: ${best}.`
      : 'Hiç atış tutmadı. Tekrar dene!';
  overlayAction.textContent = 'Tekrar oyna';
  showOverlay(overlayEl);
  try {
    overlayAction.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

// ---- Input action ----

function action(): void {
  if (phase === 'idle') {
    if (attempt >= TOTAL_ATTEMPTS) {
      resetGame();
      startAttempt();
    } else {
      startAttempt();
    }
    return;
  }
  if (phase === 'flip') {
    commitFlip();
    return;
  }
  if (phase === 'strike') {
    commitStrike();
    return;
  }
  if (phase === 'gameover') {
    resetGame();
    startAttempt();
    return;
  }
  // rising / flying / landed → input yok (input no-op).
}

function commitFlip(): void {
  // Indicator x pozisyonu = sweep süresine göre interpolate
  const t = (performance.now() - flipStartedAt) % FLIP_BAR_DURATION_MS;
  const ratio = t / FLIP_BAR_DURATION_MS;
  // ratio ∈ [0,1]; sağa kayma simülasyonu
  const x = FLIP_BAR_LEFT + ratio * (FLIP_BAR_RIGHT - FLIP_BAR_LEFT);
  const dist = Math.abs(x - FLIP_SWEET_CENTER);
  if (dist > FLIP_SWEET_HALF) {
    // Sweet zone dışında — atış kaçtı
    lastDistance = 0;
    enterLandedPhase();
    return;
  }
  // Sweet zone içi: merkez = max, kenar = min
  const accuracy = 1 - dist / FLIP_SWEET_HALF; // [0,1]
  const vy = MIN_FLIP_VY + (MAX_FLIP_VY - MIN_FLIP_VY) * accuracy;
  // Çelik biraz sağa doğru ilerlesin (oyuncudan uzaklaşsın), ama esas yukarı.
  celikVy = -vy;
  celikVx = 30 + 25 * accuracy; // 30-55 px/s — strike point'e kadar gitsin
  celikSpin = 8 + 6 * accuracy; // rad/s
  // Çeliği fizik konumuna getir (çubuğun ucundan kalkıyor)
  celikX = CELIK_REST_X + 4;
  celikY = GROUND_Y - 6;
  phase = 'rising';
}

function commitStrike(): void {
  const t = (performance.now() - strikeStartedAt) % STRIKE_BAR_DURATION_MS;
  const ratio = t / STRIKE_BAR_DURATION_MS;
  // Indicator y: yukarıdan aşağıya, sonra geri (ping-pong)
  // ratio ∈ [0,1], 0.5'te en altta, 0 ve 1'de en üstte.
  const tri = ratio < 0.5 ? ratio * 2 : 2 - ratio * 2; // 0..1..0
  const y = STRIKE_BAR_TOP + tri * (STRIKE_BAR_BOTTOM - STRIKE_BAR_TOP);
  const dist = Math.abs(y - STRIKE_SWEET_CENTER);
  if (dist > STRIKE_SWEET_HALF) {
    // Kaçtı — çelik düşmeye devam etsin
    lastDistance = 0;
    // Yatay hız sıfır — yerden uzaklaşmaz
    celikVx = 0;
    // RAF devam — yere düşünce landed olur
    return;
  }
  const accuracy = 1 - dist / STRIKE_SWEET_HALF;
  // Strike kuvveti yatay hızı verir
  celikVx = MIN_STRIKE_VX + (MAX_STRIKE_VX - MIN_STRIKE_VX) * accuracy;
  // Hafif yukarı bir vector kazanır (45° fizik için)
  celikVy = -(160 + 200 * accuracy);
  celikSpin = 12 + 18 * accuracy;
  phase = 'flying';
}

// ---- Çizim ----

function draw(): void {
  // Gökyüzü gradient
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, '#1b2540');
  sky.addColorStop(1, '#3a5780');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, WIDTH, GROUND_Y);

  // Zemin
  const ground = ctx.createLinearGradient(0, GROUND_Y, 0, HEIGHT);
  ground.addColorStop(0, '#3d2e1d');
  ground.addColorStop(1, '#221708');
  ctx.fillStyle = ground;
  ctx.fillRect(0, GROUND_Y, WIDTH, HEIGHT - GROUND_Y);

  // Yıldızlar (sabit, dekoratif)
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  drawStars();

  // Mesafe işaretleri
  drawDistanceMarkers();

  // Oyuncu silüeti
  drawPlayer();

  // Çelik (faz'a göre konum)
  drawCelik();

  // Faz göstergesi
  if (phase === 'flip') drawFlipBar();
  if (phase === 'strike') drawStrikeBar();

  // Phase HUD üstü kısa rehber
  drawPhaseHint();
}

const STARS: Array<[number, number]> = [
  [80, 40], [140, 80], [210, 30], [290, 60], [360, 25],
  [440, 70], [510, 35], [560, 90], [590, 50], [40, 110],
  [180, 130], [300, 110], [400, 140], [520, 120], [610, 160],
];

function drawStars(): void {
  for (const [x, y] of STARS) {
    ctx.fillRect(x, y, 2, 2);
  }
}

function drawDistanceMarkers(): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  // Her 80px'te bir mark (5 adım), tüm sahaya
  for (let x = PLAYER_X + 80; x < WIDTH; x += 80) {
    const steps = Math.round((x - PLAYER_X) / DISTANCE_SCALE);
    ctx.beginPath();
    ctx.moveTo(x, GROUND_Y);
    ctx.lineTo(x, GROUND_Y + 8);
    ctx.stroke();
    ctx.fillText(`${steps}`, x, GROUND_Y + 22);
  }
  ctx.textAlign = 'start';
}

function drawPlayer(): void {
  // Basit stickfig + çomak. Çelik faz='rising'|'flying'|'landed' iken oyuncu
  // çomağı hafif sallasın.
  const pHipX = PLAYER_X;
  const pHipY = GROUND_Y;
  ctx.strokeStyle = '#e2dccd';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';

  // Bacaklar
  ctx.beginPath();
  ctx.moveTo(pHipX - 8, pHipY);
  ctx.lineTo(pHipX, pHipY - 32);
  ctx.lineTo(pHipX + 8, pHipY);
  ctx.stroke();

  // Gövde
  ctx.beginPath();
  ctx.moveTo(pHipX, pHipY - 32);
  ctx.lineTo(pHipX, pHipY - 60);
  ctx.stroke();

  // Baş
  ctx.fillStyle = '#e2dccd';
  ctx.beginPath();
  ctx.arc(pHipX, pHipY - 68, 7, 0, Math.PI * 2);
  ctx.fill();

  // Çomak — çomak açısı phase'e göre
  const bat = batPose();
  ctx.strokeStyle = '#9b6a30';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(pHipX, pHipY - 45);
  ctx.lineTo(pHipX + bat.dx, pHipY - 45 + bat.dy);
  ctx.stroke();
  ctx.lineWidth = 1;
}

function batPose(): { dx: number; dy: number } {
  // Default: çomak yere doğru hafif eğik (-15° ile +30° arası animasyon)
  let angle = -Math.PI / 6; // -30°
  if (phase === 'flip') {
    // Flip esnasında çomak sweep ile titretsin (kullanıcı odaklansın)
    const t = (performance.now() - flipStartedAt) / 200;
    angle = -Math.PI / 6 + Math.sin(t) * 0.05;
  } else if (phase === 'rising') {
    // Çomak yukarı doğru kalkmış
    angle = -Math.PI / 2.2;
  } else if (phase === 'strike') {
    // Strike esnasında çomak indirme pozisyonu
    angle = -Math.PI / 3;
  } else if (phase === 'flying') {
    // Vuruş sonrası çomak yatay
    angle = -Math.PI / 8;
  }
  const len = 50;
  return { dx: Math.cos(angle) * len, dy: Math.sin(angle) * len };
}

function drawCelik(): void {
  ctx.save();
  ctx.translate(celikX, celikY);
  ctx.rotate(celikRot);
  // Ahşap renk
  ctx.fillStyle = '#caa066';
  ctx.strokeStyle = '#5c3a14';
  ctx.lineWidth = 1.2;
  const w = CELIK_LEN;
  const h = 6;
  ctx.beginPath();
  ctx.rect(-w / 2, -h / 2, w, h);
  ctx.fill();
  ctx.stroke();
  // Uçlar koyu
  ctx.fillStyle = '#5c3a14';
  ctx.fillRect(-w / 2, -h / 2, 3, h);
  ctx.fillRect(w / 2 - 3, -h / 2, 3, h);
  ctx.restore();
}

function drawFlipBar(): void {
  const t = (performance.now() - flipStartedAt) % FLIP_BAR_DURATION_MS;
  const ratio = t / FLIP_BAR_DURATION_MS;
  const indicatorX = FLIP_BAR_LEFT + ratio * (FLIP_BAR_RIGHT - FLIP_BAR_LEFT);
  // Çubuk arkaplan
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(FLIP_BAR_LEFT - 4, FLIP_BAR_Y - 12, FLIP_BAR_RIGHT - FLIP_BAR_LEFT + 8, 24);
  // Sweet zone
  ctx.fillStyle = 'rgba(80,200,120,0.55)';
  ctx.fillRect(FLIP_SWEET_CENTER - FLIP_SWEET_HALF, FLIP_BAR_Y - 8, FLIP_SWEET_HALF * 2, 16);
  // Indicator
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(indicatorX - 2, FLIP_BAR_Y - 11, 4, 22);
  // Etiket
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'start';
  ctx.fillText('Zıplat: gösterge yeşil bölgedeyken Boşluk/tıkla', FLIP_BAR_LEFT, FLIP_BAR_Y - 18);
}

function drawStrikeBar(): void {
  const t = (performance.now() - strikeStartedAt) % STRIKE_BAR_DURATION_MS;
  const ratio = t / STRIKE_BAR_DURATION_MS;
  const tri = ratio < 0.5 ? ratio * 2 : 2 - ratio * 2;
  const indicatorY = STRIKE_BAR_TOP + tri * (STRIKE_BAR_BOTTOM - STRIKE_BAR_TOP);
  // Arkaplan
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(STRIKE_BAR_X - 12, STRIKE_BAR_TOP - 4, 24, STRIKE_BAR_BOTTOM - STRIKE_BAR_TOP + 8);
  // Sweet zone
  ctx.fillStyle = 'rgba(80,200,120,0.55)';
  ctx.fillRect(STRIKE_BAR_X - 8, STRIKE_SWEET_CENTER - STRIKE_SWEET_HALF, 16, STRIKE_SWEET_HALF * 2);
  // Indicator
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(STRIKE_BAR_X - 11, indicatorY - 2, 22, 4);
  // Etiket
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'start';
  ctx.fillText('Vur!', STRIKE_BAR_X + 16, STRIKE_BAR_TOP - 6);
}

function drawPhaseHint(): void {
  let txt = '';
  if (phase === 'flip') txt = 'Faz 1 — Zıplatma';
  else if (phase === 'rising') txt = 'Çelik yükseliyor…';
  else if (phase === 'strike') txt = 'Faz 2 — Vuruş!';
  else if (phase === 'flying') txt = 'Uçuyor…';
  else if (phase === 'landed') txt = lastDistance > 0 ? `Mesafe: ${lastDistance} adım` : 'Kaçtı.';
  if (!txt) return;
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.fillRect(WIDTH / 2 - 90, 12, 180, 24);
  ctx.fillStyle = '#ffffff';
  ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(txt, WIDTH / 2, 29);
  ctx.textAlign = 'start';
}

// ---- Reset ----

function resetGame(): void {
  gen.bump();
  stopLoop();
  phase = 'idle';
  attempt = 0;
  total = 0;
  lastDistance = 0;
  celikX = CELIK_REST_X;
  celikY = GROUND_Y - CELIK_LEN / 2;
  celikVx = 0;
  celikVy = 0;
  celikRot = 0;
  celikSpin = 0;
  // Best gerekirse storage'dan yenile (zaten init'te yüklü, mutate edilmiyor)
  renderHud();
  showOverlayReady();
  draw();
}

// ---- Input handlers ----

function onKeyDown(e: KeyboardEvent): void {
  if (e.repeat) return;
  const k = e.key;
  if (k === ' ' || k === 'Spacebar') {
    e.preventDefault();
    action();
    return;
  }
  if (k === 'r' || k === 'R') {
    e.preventDefault();
    resetGame();
    return;
  }
}

function onPointerDown(e: PointerEvent): void {
  // Overlay'a tıklama overlay action butonuna gitsin; canvas tıklaması action
  if (e.target === stage) {
    e.preventDefault();
    action();
  }
}

// ---- Init ----

function init(): void {
  stage = document.querySelector<HTMLCanvasElement>('#stage')!;
  ctx = stage.getContext('2d')!;
  attemptEl = document.querySelector<HTMLElement>('#attempt')!;
  lastEl = document.querySelector<HTMLElement>('#last')!;
  scoreEl = document.querySelector<HTMLElement>('#score')!;
  bestEl = document.querySelector<HTMLElement>('#best')!;
  restartBtn = document.querySelector<HTMLButtonElement>('#restart')!;
  overlayEl = document.querySelector<HTMLElement>('#overlay')!;
  overlayTitle = document.querySelector<HTMLElement>('#overlay-title')!;
  overlayMsg = document.querySelector<HTMLElement>('#overlay-msg')!;
  overlayAction = document.querySelector<HTMLButtonElement>('#overlay-action')!;

  best = loadBest();

  restartBtn.addEventListener('click', () => {
    resetGame();
  });
  overlayAction.addEventListener('click', (e) => {
    e.preventDefault();
    action();
  });

  window.addEventListener('keydown', onKeyDown);
  stage.addEventListener('pointerdown', onPointerDown);

  renderHud();
  showOverlayReady();
  // İlk frame: zemin + oyuncu + yerdeki çelik görünsün ki kullanıcı sayfa
  // açar açmaz statik sahneyi görür (pitfall: invisible-boot).
  draw();
}

export const game = defineGame({ init, reset: resetGame });

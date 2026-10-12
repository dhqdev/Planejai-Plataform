/**
 * O motor que dá vida ao Bolinho: cabeça que vira para o mouse com os olhos andando numa esfera,
 * piscadas, pulinhos, amassar e esticar, rolar, tremer de erro, respirar dormindo, acenar,
 * corar e soltar corações, estrelas, faíscas, gotas e "z". O desenho continua sendo o SVG do
 * Bolinho.tsx; aqui só se calcula a pose a cada quadro e se escreve nos grupos do SVG.
 *
 * Adaptado do motor do Coucou (windows/src/mochi/engine.ts e core/anim.ts, que portam o
 * BotEngine.swift): mesmas curvas, mesmos tempos e a mesma física das partes moles.
 * Só o código foi aproveitado; desenho, nome e sons são nossos.
 *
 * MIT License · Copyright (c) 2026 Louis Raillé
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 * and associated documentation files (the "Software"), to deal in the Software without
 * restriction, including without limitation the rights to use, copy, modify, merge, publish,
 * distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions: The above copyright notice
 * and this permission notice shall be included in all copies or substantial portions of the
 * Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
 * INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE
 * AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */

/* ---------------- curvas ---------------- */

export type EaseFn = (t: number) => number;
export const Ease = {
  out: (t: number) => 1 - (1 - t) ** 3,
  inOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  back: (t: number) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2,
  lin: (t: number) => t,
};
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/* ---------------- estados e reações ---------------- */

/** O que ele está fazendo (vem do humor do app): muda cor, olhar, selo e o jeito de se mexer. */
export type BotState = "idle" | "working" | "thinking" | "searching" | "finished" | "error" | "sleeping" | "dizzy";
/** Reações curtas por cima do estado. */
export type Emote = "love" | "surprised" | "proud" | "wink" | "yawn" | "happy" | "annoyed";
/** Olhos que o motor impõe por cima do humor (reações). */
export type EyeOverride = "heart" | "star" | "squint" | "happy" | "closed" | "wink" | "big";
type Badge = "dots" | "dot" | null;
type RGB = readonly [number, number, number];

interface StateCfg {
  color: RGB;
  tint: number;
  badge: Badge;
  bounces?: boolean;
  scans?: boolean;
  breathes?: boolean;
  zz?: boolean;
  sweat?: boolean;
  look?: readonly [number, number];
}

const STATES: Record<BotState, StateCfg> = {
  idle: { color: [0.9, 0.91, 0.93], tint: 0, badge: null },
  working: { color: [0.231, 0.62, 1], tint: 0.4, badge: "dots" },
  thinking: { color: [0.545, 0.361, 0.965], tint: 0.4, badge: "dots", look: [0.55, -0.55] },
  searching: { color: [0.388, 0.396, 0.949], tint: 0.4, badge: "dots", scans: true },
  finished: { color: [0.204, 0.831, 0.6], tint: 0.25, badge: "dot" },
  error: { color: [0.957, 0.314, 0.369], tint: 0.45, badge: "dot" },
  sleeping: { color: [0.58, 0.635, 0.722], tint: 0.22, badge: null, breathes: true, zz: true },
  dizzy: { color: [0.957, 0.447, 0.714], tint: 0.4, badge: null },
};

const EMOTE_EYE: Record<Emote, EyeOverride> = {
  love: "heart",
  surprised: "big",
  proud: "star",
  wink: "wink",
  yawn: "closed",
  happy: "happy",
  annoyed: "squint",
};

/* ---------------- geometria (viewBox 0..120 do Bolinho.tsx) ---------------- */

/** centro do corpo e "raio" usado para tamanhos relativos (o corpo vai de 18 a 102 e de 42 a 106) */
export const CX = 60;
export const CY = 74;
const R = 36;
/** meia largura e meia altura da esfera em que os olhos andam */
const RX = 41.5;
const RY = 30;
/** olhos: afastamento (radianos de cada lado) e altura em repouso */
const EYE_SP = 0.37;
const EYE_P = -0.15;
/** altura dos olhos no desenho (Bolinho.tsx) */
export const EYE_Y = 78.5;
/** base onde o corpo apoia (amassa e estica a partir daqui) */
const FOOT_Y = 106;

type Prop = "yaw" | "pitch" | "roll" | "tilt" | "open" | "sx" | "sy" | "oy" | "ox" | "tint" | "hands" | "blush" | "es" | "badgeS" | "wear";

interface Tween {
  keys: [number, number, EaseFn][];
  i: number;
  from: number;
  start: number;
  done?: () => void;
}

interface Particle {
  type: "heart" | "star" | "spark" | "sweat" | "z";
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  rot: number;
  size: number;
  el?: SVGElement;
}

/** Grupos do SVG que o motor move. Qualquer um pode faltar (miniaturas). */
export interface Parts {
  svg: SVGSVGElement;
  /** tudo que pula, treme, inclina e amassa (corpo, roupa e olhos) */
  body: SVGGElement;
  /** gira inteiro quando ele rola vestido */
  spin: SVGGElement;
  eyeL: SVGGElement;
  eyeR: SVGGElement;
  /** chapéu e afins: seguem a cabeça e balançam atrasados (partes moles) */
  hat?: SVGGElement | null;
  neck?: SVGGElement | null;
  eyewear?: SVGGElement | null;
  blush?: SVGGElement | null;
  tint?: SVGPathElement | null;
  handL?: SVGGElement | null;
  handR?: SVGGElement | null;
  badge?: SVGGElement | null;
  fx?: SVGGElement | null;
}

const NS = "http://www.w3.org/2000/svg";
const now = () => performance.now() / 1000;

/* ---------------- relógio único para todos os Bolinhos da tela ---------------- */

const live = new Set<BolinhoEngine>();
let raf = 0;
let last = 0;
function loop(t: number) {
  const dt = Math.min(0.05, last ? (t - last) / 1000 : 1 / 60);
  last = t;
  let any = false;
  for (const e of live) {
    e.update(dt);
    e.apply();
    if (e.busy) any = true;
  }
  raf = any && !document.hidden ? requestAnimationFrame(loop) : 0;
  if (!raf) {
    last = 0;
    // parado: dorme até a próxima piscada ou olhadinha de alguém
    clearTimeout(wake);
    if (!document.hidden && live.size) {
      let next = Number.POSITIVE_INFINITY;
      for (const e of live) next = Math.min(next, e.nextWake);
      wake = setTimeout(kick, clamp((next - now()) * 1000, 30, 6000));
    }
  }
}
let wake: ReturnType<typeof setTimeout> | undefined;
function kick() {
  if (!raf && live.size) raf = requestAnimationFrame(loop);
}

// um só ouvinte de ponteiro para todos: cada um calcula o próprio olhar
let pointer: { x: number; y: number; at: number } | null = null;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointermove",
    (e) => {
      pointer = { x: e.clientX, y: e.clientY, at: Date.now() };
      kick();
    },
    { passive: true },
  );
  document.addEventListener("visibilitychange", kick);
}

/* ---------------- motor ---------------- */

export class BolinhoEngine {
  // pose animada
  yaw = 0;
  pitch = 0;
  roll = 0;
  tilt = 0;
  open = 1;
  sx = 1;
  sy = 1;
  oy = 0;
  ox = 0;
  tint = 0;
  hands = 0;
  blush = 0;
  es = 1;
  badgeS = 0;
  /** presença da roupa (0 = saiu, 1 = vestida): troca de roupa anima */
  wear = 1;

  // alvos que a pose persegue suavemente
  tgYaw = 0;
  tgPitch = 0;
  tgTilt = 0;
  tgSx = 1;
  tgSy = 1;
  tgEs = 1;

  // partes moles (chapéu, pompom, cachecol) atrasam como mola
  physDx = 0;
  physDy = 0;
  private physVx = 0;
  private physVy = 0;
  private prevYaw = 0;
  private prevOy = 0;
  private prevRoll = 0;

  state: BotState = "idle";
  cfg: StateCfg = STATES.idle;
  private col: RGB = STATES.idle.color;
  private colT: RGB = STATES.idle.color;

  /** olhos impostos por uma reação, até `eyeUntil` */
  eye: EyeOverride | null = null;
  private eyeUntil = 0;
  /** chamado quando os olhos impostos mudam (o React troca o desenho) */
  onEye: ((e: EyeOverride | null) => void) | null = null;
  /** chamado quando ele fica tonto de tanto apanhar (três toques em 1,7 s) */
  onDizzy: (() => void) | null = null;

  /** com roupa visível ele rola inteiro, chapéu junto */
  dressed = false;
  /** olhar fixo do humor (ex.: tímido olha para baixo e para o lado), em unidades de -1..1 */
  gaze: readonly [number, number] | null = null;
  /** sem partículas nem selo (avatares pequenos) */
  small = false;

  private badge: Badge = null;
  private badgeToken = 0;
  private tweens = new Map<Prop, Tween>();
  private particles: Particle[] = [];
  private t0 = now() - Math.random() * 5;
  private nextBlink = now() + 1.5 + Math.random() * 2;
  private lastAmbient = 0;
  private waveStart = 0;
  private waveUntil = 0;
  private greetToken = 0;
  private slaps: number[] = [];
  private wanderAt = 0;
  private wanderTo: [number, number] = [0, 0];
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private parts: Parts) {}

  start() {
    live.add(this);
    kick();
  }

  stop() {
    live.delete(this);
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    for (const p of this.particles) p.el?.remove();
    this.particles = [];
  }

  /** setTimeout que morre junto com o Bolinho */
  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
      kick();
    }, ms);
    this.timers.add(t);
  }

  private setEye(e: EyeOverride | null, seconds: number) {
    this.eye = e;
    this.eyeUntil = e ? now() + seconds : 0;
    this.onEye?.(e);
  }

  /* ---------- API ---------- */

  setState(next: BotState) {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    this.cfg = STATES[next];
    this.colT = this.cfg.color;
    if (!this.tweens.has("tint")) this.anim("tint", [[this.cfg.tint, 300, Ease.inOut]]);
    this.setBadge(this.cfg.badge);

    switch (next) {
      case "finished":
        // dá uma cambalhota de alegria e solta faíscas
        this.doRoll(950, 1);
        this.later(500, () => this.emit("spark", 5));
        break;
      case "error":
        this.anim("ox", [
          [0.08, 50, Ease.out],
          [-0.08, 70, Ease.inOut],
          [0.05, 70, Ease.inOut],
          [0, 90, Ease.out],
        ]);
        break;
      case "dizzy":
        this.doRoll(1300, 2);
        break;
      case "sleeping":
        // boceja antes de pegar no sono
        if (prev !== "sleeping") this.emote("yawn");
        break;
      default:
        this.blink();
    }
    kick();
  }

  private setBadge(b: Badge) {
    if (this.small) b = null;
    if (b === this.badge && this.badgeS > 0.5) return;
    const tok = ++this.badgeToken;
    this.anim("badgeS", [[0, 90, Ease.inOut]]);
    this.later(100, () => {
      if (tok !== this.badgeToken) return;
      this.badge = b;
      const el = this.parts.badge;
      if (el) el.dataset.kind = b ?? "";
      if (b) this.anim("badgeS", [[1, 280, Ease.back]]);
    });
  }

  blink() {
    if (this.tweens.has("open")) return;
    this.anim("open", [
      [0.06, 70, Ease.inOut],
      [1, 130, Ease.out],
    ]);
    kick();
  }

  squash() {
    this.physVy += 0.6;
    this.anim("sy", [
      [0.78, 70, Ease.out],
      [1.1, 130, Ease.out],
      [1, 170, Ease.inOut],
    ]);
    this.anim("sx", [
      [1.16, 70, Ease.out],
      [0.95, 130, Ease.out],
      [1, 170, Ease.inOut],
    ]);
    kick();
  }

  /** Um tapa: amassa, o chapéu chacoalha e ele fica de cara feia. Três seguidos e ele fica tonto. */
  slap() {
    this.interruptGreet();
    if (this.state === "dizzy") return;
    const t = now();
    this.slaps = this.slaps.filter((s) => t - s < 1.7);
    this.slaps.push(t);
    this.squash();
    this.physVy -= 1.2;
    this.physVx += Math.random() < 0.5 ? 0.7 : -0.7;
    if (this.slaps.length >= 3) {
      this.slaps = [];
      this.setEye(null, 0);
      this.onDizzy?.();
    } else {
      this.setEye("squint", 0.8);
    }
  }

  doRoll(ms: number, turns: number) {
    this.roll = 0;
    this.anim("roll", [[Math.PI * 2 * turns, ms, Ease.inOut]], () => {
      this.roll = 0;
    });
  }

  /** O "oi": dá um pulinho, levanta a mãozinha e acena, com olhos sorrindo e duas piscadas. */
  greet() {
    const t = now();
    const tok = ++this.greetToken;
    this.waveStart = t + 0.45;
    this.waveUntil = t + 1.55;
    this.physVx += 0.2;
    this.setEye("happy", 2);
    this.anim("oy", [
      [-0.06, 220, Ease.out],
      [0, 220, Ease.back],
    ]);
    this.later(250, () => {
      if (this.greetToken !== tok) return;
      this.anim("hands", [[1, 280, Ease.out]]);
      this.anim("sy", [
        [0.95, 100, Ease.out],
        [1, 260, Ease.back],
      ]);
      this.anim("sx", [
        [1.04, 100, Ease.out],
        [1, 260, Ease.back],
      ]);
    });
    this.later(550, () => this.greetToken === tok && this.blink());
    this.later(1500, () => this.greetToken === tok && this.blink());
    this.later(1550, () => {
      if (this.greetToken !== tok) return;
      this.waveUntil = 0;
      this.anim("hands", [[0, 200, Ease.inOut]]);
    });
    kick();
  }

  interruptGreet() {
    if (this.hands <= 0.01 && now() >= this.waveUntil) return;
    this.greetToken++;
    this.waveUntil = 0;
    this.waveStart = 0;
    this.anim("hands", [[0, 150, Ease.inOut]]);
  }

  emote(e: Emote, duration = 1.8) {
    this.setEye(EMOTE_EYE[e], duration);
    switch (e) {
      case "love":
        this.anim("blush", [
          [1, 300, Ease.out],
          [1, (duration - 0.6) * 1000, Ease.lin],
          [0, 300, Ease.inOut],
        ]);
        this.emit("heart", 4);
        this.anim("oy", [
          [-0.1, 160, Ease.out],
          [0, 300, Ease.back],
        ]);
        break;
      case "surprised":
        this.anim("oy", [
          [-0.3, 140, Ease.out],
          [0, 380, Ease.back],
        ]);
        this.anim("es", [
          [1.25, 120, Ease.out],
          [1, 500, Ease.inOut],
        ]);
        break;
      case "proud":
        this.emit("star", 5);
        this.anim("tilt", [
          [-0.14, 220, Ease.out],
          [-0.14, (duration - 0.5) * 1000, Ease.lin],
          [0, 280, Ease.inOut],
        ]);
        this.anim("blush", [
          [0.7, 250, Ease.out],
          [0.7, (duration - 0.5) * 1000, Ease.lin],
          [0, 300, Ease.inOut],
        ]);
        break;
      case "wink":
        this.anim("tilt", [
          [0.12, 160, Ease.out],
          [0.12, (duration - 0.4) * 1000, Ease.lin],
          [0, 240, Ease.inOut],
        ]);
        break;
      case "yawn":
        // estica, fecha o olho e solta dois "z"
        this.setEye(null, 0);
        this.anim("sy", [
          [1.12, 500, Ease.inOut],
          [1, 500, Ease.inOut],
        ]);
        this.anim("sx", [
          [0.94, 500, Ease.inOut],
          [1, 500, Ease.inOut],
        ]);
        this.later(700, () => {
          this.setEye("closed", 1.1);
          this.emit("z", 2);
        });
        break;
      case "happy":
        this.anim("blush", [
          [0.6, 200, Ease.out],
          [0, 600, Ease.inOut],
        ]);
        break;
      case "annoyed":
        this.setEye("squint", 0.8);
        break;
    }
    kick();
  }

  /** Roupa nova: a velha sai (180 ms), a nova cai no lugar (350 ms) e ele dá uma amassadinha. */
  changeOutfit(swap: () => void) {
    this.anim("wear", [[0, 180, Ease.inOut]], () => {
      swap();
      this.anim("wear", [[1, 350, Ease.inOut]], () => this.squash());
    });
    kick();
  }

  /** Mouse em cima: olhos crescem um pouco e ele pisca. */
  hover(on: boolean) {
    this.tgEs = on ? 1.08 : 1;
    if (on) this.blink();
    kick();
  }

  emit(type: Particle["type"], count: number) {
    if (this.small || !this.parts.fx) return;
    for (let i = 0; i < count; i++) {
      const z = type === "z";
      this.particles.push({
        type,
        x: (Math.random() - 0.5) * 0.9 + (z ? 0.55 : 0),
        y: -0.7 - Math.random() * 0.2,
        vx: (Math.random() - 0.5) * 0.35 + (z ? 0.18 : 0),
        vy: -(0.45 + Math.random() * 0.35),
        age: -i * 0.14,
        life: 1.3 + Math.random() * 0.5,
        rot: Math.random() * Math.PI * 2,
        size: 0.15 + Math.random() * 0.08,
      });
    }
    kick();
  }

  anim(prop: Prop, keys: [number, number, EaseFn][], done?: () => void) {
    this.tweens.set(prop, { keys, i: 0, from: this[prop], start: performance.now(), done });
    kick();
  }

  /** Ainda tem algo se mexendo? Se não, o relógio para e não gasta bateria. */
  get busy(): boolean {
    const c = this.cfg;
    const p = pointer && Date.now() - pointer.at < 3000;
    return (
      !!p ||
      this.tweens.size > 0 ||
      this.particles.length > 0 ||
      !!(c.bounces || c.scans || c.breathes || c.zz || c.sweat) ||
      this.state === "dizzy" ||
      this.waveUntil > now() ||
      Math.abs(this.tgYaw - this.yaw) > 0.002 ||
      Math.abs(this.tgPitch - this.pitch) > 0.002 ||
      Math.abs(this.tgTilt - this.tilt) > 0.002 ||
      Math.abs(this.tgSy - this.sy) > 0.002 ||
      Math.abs(this.tgSx - this.sx) > 0.002 ||
      Math.abs(this.tgEs - this.es) > 0.002 ||
      Math.abs(this.physVx) > 0.01 ||
      Math.abs(this.physVy) > 0.01 ||
      Math.abs(this.col[0] - this.colT[0]) > 0.003
    );
  }

  /** Quando ele precisa acordar sozinho de novo (próxima piscada ou próxima olhadinha), em segundos. */
  get nextWake(): number {
    return Math.min(this.nextBlink, this.wanderAt);
  }

  /* ---------- quadro a quadro ---------- */

  update(dt: number) {
    const n = now();
    const ms = performance.now();

    for (const [prop, tw] of [...this.tweens]) {
      const k = tw.keys[tw.i]!;
      const p = clamp((ms - tw.start) / Math.max(1, k[1]), 0, 1);
      this[prop] = tw.from + (k[0] - tw.from) * k[2](p);
      if (p >= 1) {
        tw.from = k[0];
        tw.i++;
        tw.start = ms;
        if (tw.i >= tw.keys.length) {
          this.tweens.delete(prop);
          tw.done?.();
        }
      }
    }

    const t = n - this.t0;
    // olhar: segue o ponteiro; parado, passeia sozinho (como o mini do Coucou)
    let lx = 0;
    let ly = 0;
    const recent = pointer && Date.now() - pointer.at < 2500;
    if (recent && pointer) {
      const r = this.parts.svg.getBoundingClientRect();
      if (r.width) {
        const dx = pointer.x - (r.left + r.width / 2);
        const dy = pointer.y - (r.top + r.height * 0.62);
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / (r.width * 1.6));
        lx = (dx / d) * k;
        ly = (dy / d) * k;
      }
    } else {
      if (n > this.wanderAt) {
        this.wanderTo = Math.random() < 0.3 ? [0, 0] : [-0.8 + Math.random() * 1.6, -0.5 + Math.random() * 0.9];
        this.wanderAt = n + 0.7 + Math.random() * 2.3;
      }
      [lx, ly] = this.wanderTo;
    }
    let ty = lx * 0.55;
    let tp = -ly * 0.42;
    const look = this.gaze ?? this.cfg.look;
    if (look) {
      ty = ty * 0.3 + look[0] * 0.55;
      tp = tp * 0.3 - look[1] * 0.45;
    }
    if (this.cfg.scans) {
      ty = Math.sin(t * 2.6) * 0.6;
      tp = 0.06;
    }
    if (this.state === "sleeping") {
      ty = 0;
      tp = -0.12;
    }
    if (this.state === "dizzy") ty = Math.sin(t * 9) * 0.25;
    this.tgYaw = ty;
    this.tgPitch = tp;

    this.tgTilt = 0;
    if (n > this.waveStart && n < this.waveUntil) this.tgTilt = -0.06 + Math.sin(2 * Math.PI * 1.2 * (n - this.waveStart)) * 0.07;

    const kGen = 1 - 0.0008 ** dt;
    const bounce = this.cfg.bounces ? -Math.abs(Math.sin(t * 5.2)) * 0.07 : 0;
    if (!this.tweens.has("oy")) this.oy += (bounce - this.oy) * kGen;

    if (this.cfg.breathes) {
      this.tgSy = 1 + Math.sin(t * 1.8) * 0.035;
      this.tgSx = 1 - Math.sin(t * 1.8) * 0.02;
    } else {
      this.tgSy = 1;
      this.tgSx = 1;
    }

    const kLook = 1 - 0.0025 ** dt;
    if (!this.tweens.has("yaw")) this.yaw += (this.tgYaw - this.yaw) * kLook;
    if (!this.tweens.has("pitch")) this.pitch += (this.tgPitch - this.pitch) * kLook;
    if (!this.tweens.has("tilt")) this.tilt += (this.tgTilt - this.tilt) * kGen;
    if (!this.tweens.has("sy")) this.sy += (this.tgSy - this.sy) * kGen;
    if (!this.tweens.has("sx")) this.sx += (this.tgSx - this.sx) * kGen;
    if (!this.tweens.has("es")) this.es += (this.tgEs - this.es) * kGen;

    const kc = 1 - 0.002 ** dt;
    this.col = [lerp(this.col[0], this.colT[0], kc), lerp(this.col[1], this.colT[1], kc), lerp(this.col[2], this.colT[2], kc)];

    if (n > this.nextBlink) {
      if (this.state !== "sleeping" && this.state !== "dizzy") {
        this.blink();
        if (Math.random() < 0.22) this.later(230, () => this.blink());
      }
      this.nextBlink = n + 2.2 + Math.random() * 3.2;
    }

    if (this.eye && n > this.eyeUntil) this.setEye(null, 0);

    if (n - this.lastAmbient > 1.3) {
      this.lastAmbient = n;
      if (this.cfg.zz) this.emit("z", 1);
      if (this.cfg.sweat && Math.random() < 0.5) this.emit("sweat", 1);
    }

    for (const p of this.particles) p.age += dt;
    for (const p of this.particles) if (p.age >= p.life) p.el?.remove();
    this.particles = this.particles.filter((p) => p.age < p.life);

    // partes moles: atrasam na virada da cabeça, nos pulos e nas cambalhotas (rigidez 60, amortecimento 9)
    if (dt > 0) {
      const yawVel = (this.yaw - this.prevYaw) / dt;
      const oyVel = (this.oy - this.prevOy) / dt;
      const dRoll = this.roll - this.prevRoll;
      const rollVel = Math.abs(dRoll) > Math.PI ? 0 : dRoll / dt;
      const centrifugal = this.dressed ? rollVel * 0.18 : 0;
      const tDx = clamp(-yawVel * 0.35 - this.tilt * 2 + centrifugal, -1, 1);
      const tDy = clamp(oyVel * 0.5, -1, 1);
      this.physVx += (60 * (tDx - this.physDx) - 9 * this.physVx) * dt;
      this.physVy += (60 * (tDy - this.physDy) - 9 * this.physVy) * dt;
      this.physDx += this.physVx * dt;
      this.physDy += this.physVy * dt;
    }
    this.prevYaw = this.yaw;
    this.prevOy = this.oy;
    this.prevRoll = this.roll;
  }

  /** Escreve a pose nos grupos do SVG. */
  apply() {
    const P = this.parts;
    const f = (v: number) => v.toFixed(2);
    const deg = (r: number) => ((r * 180) / Math.PI).toFixed(2);

    // corpo: anda (tremida, pulo), inclina pelo centro e amassa a partir do pé
    const tx = this.ox * R;
    const ty = this.oy * R;
    P.body.setAttribute(
      "transform",
      `translate(${f(tx)} ${f(ty)}) rotate(${deg(this.tilt)} ${CX} ${CY}) translate(${CX} ${FOOT_Y}) scale(${f(this.sx)} ${f(this.sy)}) translate(${-CX} ${-FOOT_Y})`,
    );
    // vestido, a cambalhota gira o personagem inteiro; sem roupa, só os olhos dão a volta na esfera
    const rigid = this.dressed;
    P.spin.setAttribute("transform", rigid && Math.abs(this.roll) > 0.001 ? `rotate(${deg(this.roll)} ${CX} ${CY})` : "");

    // olhos numa esfera: andam, encolhem na borda e somem atrás
    for (const [sd, el] of [
      [-1, P.eyeL],
      [1, P.eyeR],
    ] as const) {
      const eyeYaw = sd * EYE_SP + this.yaw;
      let eyePitch = EYE_P + this.pitch + (rigid ? 0 : this.roll);
      eyePitch = ((((eyePitch + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)) - Math.PI;
      const cp = Math.cos(eyePitch);
      const visible = Math.cos(eyeYaw) * cp > 0.04;
      const bx = Math.sin(sd * EYE_SP) * Math.cos(EYE_P) * RX;
      const by = -Math.sin(EYE_P) * RY;
      const ex = Math.sin(eyeYaw) * cp * RX - bx;
      const ey = -Math.sin(eyePitch) * RY - by;
      const fx = Math.max(0.18, Math.cos(eyeYaw)) / Math.cos(EYE_SP);
      const fy = Math.max(0.18, cp) / Math.cos(EYE_P);
      const ox = CX + bx;
      const oy = EYE_Y;
      const k = this.es;
      el.setAttribute(
        "transform",
        `translate(${f(ex)} ${f(ey)}) translate(${f(ox)} ${oy}) scale(${f(fx * k)} ${f(fy * k * Math.max(0.06, this.open))}) translate(${f(-ox)} ${-oy})`,
      );
      el.style.opacity = visible ? "" : "0";
    }

    // chapéu e cachecol: acompanham a cabeça e balançam atrasados como mola
    const headX = Math.sin(this.yaw) * 5;
    const headY = -Math.sin(this.pitch) * 3;
    const w = this.wear;
    const wearT = (dy: number) => (w < 0.999 ? ` translate(0 ${f((1 - w) * dy)})` : "");
    if (P.hat)
      P.hat.setAttribute(
        "transform",
        `translate(${f(headX)} ${f(headY + this.physDy * 3)}) rotate(${f(this.physDx * 9)} ${CX} 52)${wearT(-30)}`,
      );
    if (P.hat) P.hat.style.opacity = w < 0.999 ? f(w) : "";
    if (P.eyewear) {
      P.eyewear.setAttribute("transform", `translate(${f(headX * 1.4)} ${f(headY * 1.4)})${wearT(-12)}`);
      P.eyewear.style.opacity = w < 0.999 ? f(w) : "";
    }
    if (P.neck) {
      P.neck.setAttribute("transform", `rotate(${f(this.physDx * 4)} ${CX} 98)${wearT(10)}`);
      P.neck.style.opacity = w < 0.999 ? f(w) : "";
    }

    // bochechas coradas (amor, orgulho, estados com cor)
    if (P.blush) {
      const b = Math.max(this.blush, this.tint * 0.5);
      P.blush.style.opacity = f(b);
      P.blush.setAttribute("transform", `translate(${f(Math.sin(this.yaw) * RX * 0.8)} 0)`);
    }
    // cor do estado subindo de baixo (azul trabalhando, verde pronto, vermelho erro...)
    if (P.tint) {
      const [r, g, b] = this.col.map((c) => Math.round(c * 255));
      P.svg.style.setProperty("--tint", `rgb(${r},${g},${b})`);
      P.tint.style.opacity = f(this.tint);
    }

    // mãozinhas: aparecem para acenar
    for (const [sd, el] of [
      [-1, P.handL],
      [1, P.handR],
    ] as const) {
      if (!el) continue;
      if (this.hands <= 0.01) {
        el.style.display = "none";
        continue;
      }
      el.style.display = "";
      const n = now();
      const waving = n >= this.waveStart && this.waveStart > 0 && n < this.waveUntil;
      const hw = 42 * this.sx;
      const hh = 32 * this.sy;
      let x = sd * hw * 1.06;
      let y = hh * 0.7;
      let rot = 0;
      if (sd > 0 && waving) {
        const wt = n - this.waveStart;
        const e = 1 - (1 - Math.min(1, wt / 0.18)) ** 3;
        x = lerp(hw * 1.06, hw * 1.1 + Math.cos(13 * wt) * 0.06 * 64, e);
        y = lerp(hh * 0.7, -hh * 0.15 - Math.sin(13 * wt) * 0.14 * 64, e);
        rot = (-0.5 + Math.sin(13 * wt) * 0.35) * e;
      } else if (sd < 0 && waving) {
        y = hh * 0.7 + Math.sin(6 * (n - this.waveStart)) * 0.04 * 64;
      }
      el.setAttribute("transform", `translate(${f(CX + x + tx)} ${f(CY + y + ty)}) rotate(${deg(rot)}) scale(${f(this.hands)})`);
    }

    // selo no canto: três pontinhos trabalhando, bolinha de cor no fim
    if (P.badge) {
      const s = this.badgeS;
      P.badge.style.display = s > 0.01 ? "" : "none";
      if (s > 0.01) {
        const [r, g, b] = this.col.map((c) => Math.round(c * 255));
        P.badge.style.setProperty("--badge", `rgb(${r},${g},${b})`);
        P.badge.setAttribute("transform", `translate(${f(CX - R * 0.95 * this.sx + tx)} ${f(CY - R * 0.95 * this.sy + ty)}) scale(${f(s)})`);
        if (this.badge === "dots") {
          const t = now();
          P.badge.querySelectorAll<SVGCircleElement>(".bb-dot").forEach((d, i) => {
            const ph = (((t * 2.4 - i * 0.22) % 1) + 1) % 1;
            d.setAttribute("r", f(R * 0.055 * (1 + 0.4 * Math.max(0, Math.sin(ph * Math.PI * 2)))));
          });
        }
      }
    }

    this.drawParticles(tx, ty);
  }

  private drawParticles(tx: number, ty: number) {
    const fx = this.parts.fx;
    if (!fx) return;
    for (const p of this.particles) {
      if (p.age <= 0) continue;
      if (!p.el) p.el = makeParticle(p.type);
      if (!p.el.parentNode) fx.appendChild(p.el);
      const k = p.age / p.life;
      const a = k < 0.2 ? k / 0.2 : 1 - (k - 0.2) / 0.8;
      const px = CX + tx + (p.x + p.vx * p.age) * R * 1.3;
      const py = CY + ty + (p.y + p.vy * p.age) * R * 1.3;
      const sz = R * p.size * (1 + k * 0.4);
      let rot = 0;
      if (p.type === "heart") rot = Math.sin(p.age * 6) * 0.3;
      else if (p.type === "star") rot = p.rot + p.age * 2;
      else if (p.type === "spark") rot = p.rot;
      p.el.setAttribute("transform", `translate(${px.toFixed(2)} ${py.toFixed(2)}) rotate(${((rot * 180) / Math.PI).toFixed(1)}) scale(${(sz / 10).toFixed(3)})`);
      p.el.style.opacity = clamp(a, 0, 1).toFixed(2);
    }
  }
}

function star(ro: number, ri: number) {
  let d = "";
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    d += `${i ? "L" : "M"}${(Math.cos(a) * r).toFixed(2)} ${(Math.sin(a) * r).toFixed(2)}`;
  }
  return `${d}Z`;
}
export const HEART = "M0 3.8 C-10.5 -1.5 -5 -9.5 0 -3.8 C5 -9.5 10.5 -1.5 0 3.8 Z";
export const STAR = star(10.5, 4.6);
const SPARK = star(8, 1.8);

/** partículas desenhadas em unidades de 10 (o motor escala) */
function makeParticle(type: Particle["type"]): SVGElement {
  if (type === "z") {
    const t = document.createElementNS(NS, "text");
    t.textContent = "z";
    t.setAttribute("class", "bp-z");
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "middle");
    t.setAttribute("font-size", "19");
    t.setAttribute("font-weight", "700");
    return t;
  }
  const p = document.createElementNS(NS, "path");
  const d = { heart: HEART, star: STAR, spark: SPARK, sweat: "M0 -10 Q8 2 0 6 Q-8 2 0 -10 Z" }[type];
  p.setAttribute("d", d);
  p.setAttribute("class", `bp-${type}`);
  return p;
}

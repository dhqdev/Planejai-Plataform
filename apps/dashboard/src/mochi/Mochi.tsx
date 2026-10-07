import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import "./mochi.css";

/**
 * Mochi, o mascote do Planejai: uma pedrinha macia e branca desenhada em SVG, com carinhas,
 * efeitos de cada sentimento e roupinhas. Tudo é código (sem imagem), então escala do ícone da
 * barra até a tela do guarda-roupa.
 */

export type Mood =
  // estados do app
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "upload"
  | "greeting"
  // sentimentos
  | "happy"
  | "excited"
  | "surprised"
  | "sad"
  | "crying"
  | "angry"
  | "sleeping"
  | "sleepy"
  | "dizzy"
  | "love"
  | "shy"
  | "wink"
  | "laughing"
  | "tired"
  | "starstruck"
  | "yummy"
  | "uwu"
  | "cool"
  | "dancing"
  | "slap";

export const MOODS: { id: Mood; label: string }[] = [
  { id: "idle", label: "parado" },
  { id: "happy", label: "feliz" },
  { id: "excited", label: "animado" },
  { id: "surprised", label: "surpreso" },
  { id: "sad", label: "triste" },
  { id: "crying", label: "chorando" },
  { id: "angry", label: "bravo" },
  { id: "sleeping", label: "dormindo" },
  { id: "sleepy", label: "com sono" },
  { id: "dizzy", label: "confuso" },
  { id: "love", label: "apaixonado" },
  { id: "shy", label: "envergonhado" },
  { id: "wink", label: "piscando" },
  { id: "thinking", label: "pensando" },
  { id: "laughing", label: "dando risada" },
  { id: "tired", label: "cansado" },
  { id: "starstruck", label: "incrível" },
  { id: "yummy", label: "coisa boa" },
  { id: "uwu", label: "fofo" },
  { id: "cool", label: "estiloso" },
  { id: "dancing", label: "dançando" },
  { id: "slap", label: "tapa" },
  { id: "greeting", label: "oi" },
  { id: "working", label: "trabalhando" },
  { id: "searching", label: "pesquisando" },
  { id: "upload", label: "enviando" },
  { id: "approval", label: "aprovação" },
  { id: "question", label: "pergunta" },
  { id: "finished", label: "pronto" },
  { id: "error", label: "erro" },
  { id: "ratelimit", label: "no limite" },
];

export type Slot = "head" | "eyes" | "neck" | "costume";
export type Outfit = Partial<Record<Slot, string>>;

export const ITEMS: { id: string; slot: Slot; label: string }[] = [
  { id: "beanie", slot: "head", label: "Gorro" },
  { id: "santa", slot: "head", label: "Papai Noel" },
  { id: "party", slot: "head", label: "Festa" },
  { id: "crown", slot: "head", label: "Coroa" },
  { id: "witch", slot: "head", label: "Bruxa" },
  { id: "cap", slot: "head", label: "Boné" },
  { id: "headphones", slot: "head", label: "Fone" },
  { id: "bow", slot: "head", label: "Laço" },
  { id: "flower", slot: "head", label: "Flor" },
  { id: "sunglasses", slot: "eyes", label: "Óculos escuros" },
  { id: "glasses", slot: "eyes", label: "Óculos" },
  { id: "scarf", slot: "neck", label: "Cachecol" },
  { id: "bowtie", slot: "neck", label: "Gravatinha" },
  { id: "pumpkin", slot: "costume", label: "Abóbora" },
];

export const SLOTS: { id: Slot; label: string }[] = [
  { id: "head", label: "Cabeça" },
  { id: "eyes", label: "Olhos" },
  { id: "neck", label: "Pescoço" },
  { id: "costume", label: "Fantasia" },
];

/* ---------------- Carinhas ---------------- */

type EyeKind =
  | "dot"
  | "big"
  | "sparkle"
  | "happy"
  | "closed"
  | "line"
  | "lid"
  | "sadL"
  | "sadR"
  | "angryL"
  | "angryR"
  | "tearL"
  | "tearR"
  | "spiral"
  | "heart"
  | "starry"
  | "gt"
  | "lt"
  | "none";
type MouthKind = "o" | "open" | "smile" | "tongue" | "w" | "wavy" | "frown" | "smirk" | "yawn";
type Fx = "sparkles" | "stars" | "hearts" | "heart" | "spirals" | "zzz" | "z" | "rain" | "vein" | "sweat" | "notes" | "card" | "impact";
type Badge = { kind: "dots" | "!" | "?" | "dot"; color: string };

interface Face {
  l: EyeKind;
  r: EyeKind;
  mouth?: MouthKind;
  blush?: boolean;
  shades?: boolean;
  tint?: string;
  glow?: string;
  badge?: Badge;
  fx?: Fx[];
}

const BLUE = "#4f72f0";
const PURPLE = "#8b5cf0";
const FACES: Record<Mood, Face> = {
  idle: { l: "dot", r: "dot" },
  working: { l: "dot", r: "dot", tint: "#c3d4fb", glow: BLUE, badge: { kind: "dots", color: BLUE } },
  thinking: { l: "lid", r: "lid", tint: "#d9ccfb", glow: PURPLE, badge: { kind: "dots", color: PURPLE } },
  searching: { l: "dot", r: "dot", tint: "#cfcffb", glow: "#6a63ee", badge: { kind: "dots", color: "#6a63ee" } },
  approval: { l: "dot", r: "dot", mouth: "o", tint: "#fbd9a8", glow: "#f29a1f", badge: { kind: "!", color: "#f29a1f" } },
  question: { l: "dot", r: "big", tint: "#bfeaf3", glow: "#2bb3cf", badge: { kind: "?", color: "#2bb3cf" } },
  error: { l: "line", r: "line", mouth: "frown", tint: "#f8c0c8", glow: "#ef4b5f", badge: { kind: "dot", color: "#ef4b5f" }, fx: ["sweat"] },
  finished: { l: "happy", r: "happy", mouth: "smile", tint: "#c6eedc", glow: "#2fbf7f", badge: { kind: "dot", color: "#2fbf7f" }, fx: ["sparkles"] },
  ratelimit: { l: "line", r: "line", mouth: "wavy", tint: "#f9d8ba", glow: "#f2862b", badge: { kind: "dot", color: "#f2862b" }, fx: ["sweat"] },
  upload: { l: "dot", r: "dot", mouth: "smile", fx: ["card"] },
  greeting: { l: "happy", r: "happy", mouth: "open", blush: true, glow: "#ffd6e2" },
  happy: { l: "happy", r: "happy", mouth: "smile" },
  excited: { l: "sparkle", r: "sparkle", mouth: "open", blush: true, glow: "#ffb37a", fx: ["sparkles"] },
  surprised: { l: "big", r: "big", mouth: "o" },
  sad: { l: "sadL", r: "sadR", mouth: "frown", tint: "#d9e2f2", glow: "#6d8fd6" },
  crying: { l: "tearL", r: "tearR", mouth: "frown", tint: "#d3def5", glow: "#4f8cf0", fx: ["rain"] },
  angry: { l: "angryL", r: "angryR", mouth: "frown", tint: "#f9d0d0", glow: "#ef3b4f", fx: ["vein"] },
  sleeping: { l: "closed", r: "closed", glow: "#3b4fc4", fx: ["zzz"] },
  sleepy: { l: "line", r: "line", mouth: "yawn", fx: ["z"] },
  dizzy: { l: "spiral", r: "spiral", mouth: "wavy", tint: "#ecd3f6", glow: PURPLE, fx: ["spirals"] },
  love: { l: "heart", r: "heart", mouth: "open", blush: true, tint: "#f9dbe8", glow: "#ec4f9a", fx: ["hearts"] },
  shy: { l: "dot", r: "dot", mouth: "wavy", blush: true, glow: "#ff9fb7", fx: ["sweat"] },
  wink: { l: "happy", r: "dot", mouth: "tongue" },
  laughing: { l: "gt", r: "lt", mouth: "open", blush: true, glow: "#ffcf5c" },
  tired: { l: "closed", r: "closed", mouth: "smile", tint: "#eceaf3" },
  starstruck: { l: "starry", r: "starry", mouth: "open", glow: "#7b5cff", fx: ["stars"] },
  yummy: { l: "happy", r: "happy", mouth: "tongue", blush: true },
  uwu: { l: "happy", r: "happy", mouth: "w", fx: ["heart"], glow: "#c79bff" },
  cool: { l: "none", r: "none", mouth: "smirk", shades: true, glow: "#7b5cff" },
  dancing: { l: "happy", r: "happy", mouth: "open", glow: "#ff7ac6", fx: ["notes"] },
  slap: { l: "gt", r: "lt", mouth: "wavy", tint: "#f9cfd5", glow: "#ef4b5f", fx: ["impact", "vein"] },
};

const INK = "#16161a";
const LX = 46;
const RX = 74;
const EY = 77;
const MY = 89;
/** corpo: uma pedrinha arredondada, mais larga embaixo */
const BODY = "M60 43 C86 43 103 54 103 76 C103 98 87 106 60 106 C33 106 17 98 17 76 C17 54 34 43 60 43 Z";

function Eye({ kind, x, y = EY }: { kind: EyeKind; x: number; y?: number }) {
  const s = { stroke: INK, strokeWidth: 2.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  const glint = (r: number, dx = 1.3, dy = -1.6) => <circle cx={x + dx} cy={y + dy} r={r} fill="#fff" opacity={0.95} />;
  switch (kind) {
    case "none":
      return null;
    case "dot":
      return (
        <g className="m-eye">
          <ellipse cx={x} cy={y} rx={3.9} ry={4.6} fill={INK} />
          {glint(1)}
        </g>
      );
    case "big":
      return (
        <g className="m-eye">
          <ellipse cx={x} cy={y} rx={4.8} ry={5.6} fill={INK} />
          {glint(1.4, 1.6, -2)}
        </g>
      );
    case "sparkle":
      return (
        <g className="m-eye">
          <ellipse cx={x} cy={y} rx={5.4} ry={6} fill={INK} />
          {glint(2.1, 1.7, -2)}
          {glint(1, -2, 2.2)}
          <circle cx={x + 2.6} cy={y + 2.4} r={0.6} fill="#fff" />
        </g>
      );
    case "happy":
      return <path className="m-eye" d={`M${x - 5.5} ${y + 2} Q${x} ${y - 6} ${x + 5.5} ${y + 2}`} {...s} />;
    case "closed":
      return <path className="m-eye" d={`M${x - 5.5} ${y - 1.5} Q${x} ${y + 4.5} ${x + 5.5} ${y - 1.5}`} {...s} />;
    case "line":
      return <path className="m-eye" d={`M${x - 4.8} ${y} L${x + 4.8} ${y}`} {...s} />;
    case "lid":
      // olho meio fechado (pensando): pálpebra reta em cima
      return (
        <g className="m-eye">
          <path d={`M${x - 4.6} ${y - 1} A4.6 4.6 0 0 0 ${x + 4.6} ${y - 1} Z`} fill={INK} />
          <path d={`M${x - 6} ${y - 1.2} L${x + 6} ${y - 1.2}`} {...s} strokeWidth={2.2} />
        </g>
      );
    case "sadL":
    case "sadR": {
      const k = kind === "sadL" ? 1 : -1;
      return (
        <g className="m-eye">
          <ellipse cx={x} cy={y + 1} rx={3.6} ry={4.2} fill={INK} />
          {glint(0.9, 1.1, -0.6)}
          <path d={`M${x - 5 * k} ${y - 5} L${x + 4 * k} ${y - 8.5}`} {...s} strokeWidth={2.2} />
        </g>
      );
    }
    case "angryL":
    case "angryR": {
      const k = kind === "angryL" ? 1 : -1;
      return (
        <g className="m-eye">
          <ellipse cx={x} cy={y + 1.2} rx={3.9} ry={3.6} fill={INK} />
          <path d={`M${x - 6 * k} ${y - 7} L${x + 5 * k} ${y - 2.6}`} {...s} strokeWidth={3} />
        </g>
      );
    }
    case "tearL":
    case "tearR": {
      const k = kind === "tearL" ? 1 : -1;
      return (
        <g className="m-eye">
          <path d={`M${x - 5} ${y + 1} Q${x} ${y - 4} ${x + 5} ${y + 1}`} {...s} />
          <path d={`M${x - 5 * k} ${y - 6} L${x + 4 * k} ${y - 8.5}`} {...s} strokeWidth={2} />
          <path className="m-tear" d={`M${x + 1.5 * k} ${y + 2} C${x + 2 * k} ${y + 8} ${x + 0.5 * k} ${y + 13} ${x + 1.5 * k} ${y + 19}`} stroke="#4aa3ff" strokeWidth={3.2} strokeLinecap="round" fill="none" />
        </g>
      );
    }
    case "spiral":
      return (
        <g className="m-eye m-spin">
          <path
            d={`M${x} ${y} m-0.4 0 a0.8 0.8 0 1 1 1.6 0 a1.9 1.9 0 1 1 -3.8 0 a3 3 0 1 1 6 0 a4.2 4.2 0 1 1 -8.4 0`}
            stroke={INK}
            strokeWidth={1.6}
            strokeLinecap="round"
            fill="none"
          />
        </g>
      );
    case "heart":
      return (
        <g className="m-eye m-beat">
          <path d={heartPath(x, y, 1.15)} fill="#ff3d6a" />
          <ellipse cx={x - 2} cy={y - 2.4} rx={1.4} ry={0.9} fill="#fff" opacity={0.8} />
        </g>
      );
    case "starry":
      return (
        <g className="m-eye">
          <ellipse cx={x} cy={y} rx={5.6} ry={6} fill={INK} />
          <path className="m-twirl" d={sparklePath(x, y - 0.2, 3.6)} fill="#fff" />
        </g>
      );
    case "gt":
      return <path className="m-eye" d={`M${x - 4} ${y - 4.2} L${x + 3.6} ${y} L${x - 4} ${y + 4.2}`} {...s} />;
    case "lt":
      return <path className="m-eye" d={`M${x + 4} ${y - 4.2} L${x - 3.6} ${y} L${x + 4} ${y + 4.2}`} {...s} />;
  }
}

function Mouth({ kind }: { kind: MouthKind }) {
  const s = { stroke: INK, strokeWidth: 2.1, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  switch (kind) {
    case "o":
      return <ellipse cx={60} cy={MY + 1} rx={2.2} ry={2.6} fill={INK} />;
    case "yawn":
      return <ellipse className="m-yawn" cx={60} cy={MY + 1.5} rx={2.8} ry={3.6} fill="#2a1a1e" />;
    case "open":
      return (
        <g>
          <path d={`M54.5 ${MY - 1} Q60 ${MY} 65.5 ${MY - 1} Q65 ${MY + 6.5} 60 ${MY + 6.5} Q55 ${MY + 6.5} 54.5 ${MY - 1} Z`} fill="#2a1a1e" />
          <ellipse cx={60} cy={MY + 4.6} rx={3.1} ry={1.7} fill="#ff6b81" />
        </g>
      );
    case "smile":
      return <path d={`M56 ${MY} Q60 ${MY + 3.6} 64 ${MY}`} {...s} />;
    case "tongue":
      return (
        <g>
          <rect x={59.6} y={MY + 0.6} width={4.6} height={5} rx={2.3} fill="#ff6b81" />
          <path d={`M55.5 ${MY} Q60 ${MY + 3.4} 64.5 ${MY}`} {...s} />
        </g>
      );
    case "w":
      return <path d={`M54.5 ${MY - 0.5} Q57.25 ${MY + 3.4} 60 ${MY - 0.5} Q62.75 ${MY + 3.4} 65.5 ${MY - 0.5}`} {...s} strokeWidth={1.9} />;
    case "wavy":
      return <path d={`M53.5 ${MY + 1} Q55.5 ${MY - 1} 57.5 ${MY + 1} T61.5 ${MY + 1} T65.5 ${MY + 1}`} {...s} strokeWidth={1.8} />;
    case "frown":
      return <path d={`M56 ${MY + 2.5} Q60 ${MY - 1} 64 ${MY + 2.5}`} {...s} />;
    case "smirk":
      return <path d={`M56.5 ${MY + 1} Q61.5 ${MY + 2.6} 65 ${MY - 1.2}`} {...s} />;
  }
}

function heartPath(x: number, y: number, k = 1) {
  return `M${x} ${y + 4.6 * k} C${x - 7.4 * k} ${y - 0.4 * k} ${x - 5.2 * k} ${y - 6.4 * k} ${x} ${y - 2.6 * k} C${x + 5.2 * k} ${y - 6.4 * k} ${x + 7.4 * k} ${y - 0.4 * k} ${x} ${y + 4.6 * k} Z`;
}

function sparklePath(x: number, y: number, r: number) {
  const q = r * 0.18;
  return `M${x} ${y - r} Q${x + q} ${y - q} ${x + r} ${y} Q${x + q} ${y + q} ${x} ${y + r} Q${x - q} ${y + q} ${x - r} ${y} Q${x - q} ${y - q} ${x} ${y - r} Z`;
}

function starPath(cx: number, cy: number, r1: number, r2: number, n = 5) {
  let d = "";
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 ? r2 : r1;
    const a = (Math.PI / n) * i - Math.PI / 2;
    d += `${i ? "L" : "M"}${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * Math.sin(a)).toFixed(2)} `;
  }
  return d + "Z";
}

function Blush() {
  return (
    <g className="m-blush">
      <ellipse cx={36} cy={87} rx={5.6} ry={3} fill="#ff7f9d" opacity={0.45} />
      <ellipse cx={84} cy={87} rx={5.6} ry={3} fill="#ff7f9d" opacity={0.45} />
      <path d="M33.5 88.5 L35.5 85.5 M37 88.5 L39 85.5 M81 88.5 L83 85.5 M84.5 88.5 L86.5 85.5" stroke="#ff5c84" strokeWidth={0.9} strokeLinecap="round" opacity={0.7} />
    </g>
  );
}

function BadgeMark({ b }: { b: Badge }) {
  if (b.kind === "dots")
    return (
      <g className="m-badge">
        <rect x={13} y={44} width={20} height={9.5} rx={4.75} fill={b.color} />
        {[18, 23, 28].map((cx, i) => (
          <circle key={cx} className="m-typing" style={{ animationDelay: `${i * 0.16}s` }} cx={cx} cy={48.75} r={1.4} fill="#fff" />
        ))}
      </g>
    );
  return (
    <g className="m-badge">
      <circle cx={24} cy={50} r={b.kind === "dot" ? 4.2 : 5.4} fill={b.color} stroke="rgba(255,255,255,.95)" strokeWidth={1.3} />
      {b.kind !== "dot" && (
        <text x={24} y={52.6} textAnchor="middle" fontSize={7.4} fontWeight={800} fill="#fff" fontFamily="ui-sans-serif, system-ui, sans-serif">
          {b.kind}
        </text>
      )}
    </g>
  );
}

/* ---------------- Efeitos de cada sentimento ---------------- */

function Effects({ fx, u }: { fx: Fx[]; u: string }) {
  return (
    <>
      {fx.includes("sparkles") &&
        [
          [44, 36, 3.6, 0],
          [60, 28, 2.6, 0.45],
          [75, 37, 2.2, 0.9],
          [95, 52, 2, 1.2],
        ].map(([x, y, r, d]) => <path key={`${x}`} className="m-twinkle" style={{ animationDelay: `${d}s` }} d={sparklePath(x, y, r)} fill="#fff" />)}
      {fx.includes("stars") &&
        [
          [22, 46, 3.4, 0, "#ffe27a"],
          [98, 44, 4, 0.5, "#fff"],
          [104, 74, 2.6, 1, "#c9b6ff"],
          [14, 74, 2.4, 1.4, "#fff"],
          [60, 30, 3, 0.8, "#ffe27a"],
        ].map(([x, y, r, d, c]) => (
          <path key={`${x}`} className="m-twinkle" style={{ animationDelay: `${d}s` }} d={sparklePath(x as number, y as number, r as number)} fill={c as string} />
        ))}
      {fx.includes("hearts") &&
        [
          [20, 52, 1, 0],
          [100, 48, 1.2, 0.7],
          [88, 32, 0.8, 1.3],
          [30, 36, 0.7, 1.9],
        ].map(([x, y, k, d]) => (
          <path key={`${x}`} className="m-float-heart" style={{ animationDelay: `${d}s` }} d={heartPath(x, y, k)} fill="#ff4f8b" filter={`url(#${u}-neon)`} />
        ))}
      {fx.includes("heart") && <path className="m-float-heart" d={heartPath(96, 46, 0.9)} fill="#c27bff" filter={`url(#${u}-neon)`} />}
      {fx.includes("spirals") &&
        [
          [16, 50, 0],
          [104, 52, 0.4],
          [12, 92, 0.8],
          [108, 90, 1.2],
        ].map(([x, y, d]) => (
          <g key={`${x}`} className="m-orbit" style={{ animationDelay: `${d}s` }}>
            <path
              d={`M${x} ${y} m-0.4 0 a0.8 0.8 0 1 1 1.6 0 a1.9 1.9 0 1 1 -3.8 0 a3 3 0 1 1 6 0 a4.2 4.2 0 1 1 -8.4 0`}
              stroke="#a86bff"
              strokeWidth={1.6}
              strokeLinecap="round"
              fill="none"
              filter={`url(#${u}-neon)`}
            />
          </g>
        ))}
      {(fx.includes("zzz") || fx.includes("z")) && (
        <g className="m-zzz" fill="#8e8cff" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={800}>
          <text x={90} y={46} fontSize={8}>z</text>
          {fx.includes("zzz") && <text x={97} y={36} fontSize={10.5}>z</text>}
          {fx.includes("zzz") && <text x={105} y={24} fontSize={13}>Z</text>}
        </g>
      )}
      {fx.includes("rain") &&
        [20, 34, 50, 70, 86, 100].map((x, i) => (
          <line key={x} className="m-rain" style={{ animationDelay: `${i * 0.23}s` }} x1={x} y1={18} x2={x - 1.5} y2={26} stroke="#7fb3ff" strokeWidth={1.4} strokeLinecap="round" opacity={0.6} />
        ))}
      {fx.includes("vein") && (
        <g transform="translate(94 46)">
         <g className="m-vein" stroke="#ff3045" strokeWidth={2.2} strokeLinecap="round" fill="none">
          <path d="M-2 -7 Q-2 -2 -7 -2" />
          <path d="M2 -7 Q2 -2 7 -2" />
          <path d="M-2 7 Q-2 2 -7 2" />
          <path d="M2 7 Q2 2 7 2" />
         </g>
        </g>
      )}
      {fx.includes("sweat") && (
        <path className="m-sweat" d="M95 56 C98 61 99 64 96.5 65.5 C94 67 91.5 64.5 93 61 Z" fill="#7cc4ff" stroke="#fff" strokeWidth={0.6} />
      )}
      {fx.includes("notes") && (
        <g className="m-notes" fill="#ff7ac6" fontSize={12} fontWeight={700} fontFamily="ui-sans-serif, system-ui, sans-serif">
          <text x={96} y={50}>♪</text>
          <text x={14} y={56}>♫</text>
        </g>
      )}
      {fx.includes("card") && (
        <g className="m-card">
          <rect x={52} y={24} width={16} height={13} rx={2.5} fill="#fff" stroke="#d8d8de" strokeWidth={0.8} />
          <rect x={56} y={29} width={8} height={2.6} rx={1.3} fill="#ef4b5f" />
        </g>
      )}
      {fx.includes("impact") && (
        <g className="m-impact" stroke="#ef4b5f" strokeWidth={2.4} strokeLinecap="round">
          <path d="M106 66 L114 62 M108 76 L117 76 M106 86 L114 90" />
          <ellipse cx={85} cy={88} rx={6} ry={3.4} fill="#ff6f82" stroke="none" opacity={0.7} />
        </g>
      )}
    </>
  );
}

/* ---------------- Roupinhas ---------------- */

function Hat({ id, u }: { id: string; u: string }) {
  switch (id) {
    case "beanie":
      return (
        <g>
          <path d="M28 61 C27 38 42 27 60 27 C78 27 93 38 92 61 Z" fill={`url(#${u}-blue)`} />
          {[40, 46, 53, 60, 67, 74, 80].map((x) => (
            <path key={x} d={`M${x + (x - 60) * 0.1} 36 Q${x + (x - 60) * 0.2} 46 ${x + (x - 60) * 0.28} 55`} stroke="rgba(255,255,255,.16)" strokeWidth={2.2} fill="none" strokeLinecap="round" />
          ))}
          <path d="M40 34 C46 30 54 29 58 30" stroke="rgba(255,255,255,.5)" strokeWidth={2.4} fill="none" strokeLinecap="round" />
          <rect x={22} y={52} width={76} height={13} rx={6.5} fill={`url(#${u}-bluecuff)`} />
          {Array.from({ length: 14 }, (_, i) => (
            <rect key={i} x={25.5 + i * 5.1} y={54} width={2.6} height={9} rx={1.3} fill="rgba(0,0,0,.14)" />
          ))}
          <g>
            {[
              [60, 22, 7],
              [55, 25, 5],
              [65, 25, 5],
              [60, 27, 5],
            ].map(([x, y, r]) => (
              <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill={`url(#${u}-white)`} />
            ))}
            <circle cx={58} cy={19.5} r={2} fill="#fff" />
          </g>
        </g>
      );
    case "santa":
      return (
        <g>
          <path d="M27 60 C28 37 44 25 63 26 C80 27 94 38 100 58 C101 64 97 67 94 64 C92 54 86 45 80 42 C84 48 88 55 92 60 Z" fill={`url(#${u}-red)`} />
          <path d="M44 32 C50 28 58 27 63 28" stroke="rgba(255,255,255,.35)" strokeWidth={2.4} fill="none" strokeLinecap="round" />
          <g fill={`url(#${u}-white)`}>
            {[
              [97, 66, 6.6],
              [93, 68, 3.6],
              [101, 69, 3.6],
            ].map(([x, y, r]) => (
              <circle key={`${x}`} cx={x} cy={y} r={r} />
            ))}
          </g>
          <g fill={`url(#${u}-white)`}>
            {Array.from({ length: 11 }, (_, i) => (
              <circle key={i} cx={26 + i * 6.8} cy={58 + Math.sin(i * 1.7) * 0.8} r={6.2} />
            ))}
          </g>
        </g>
      );
    case "party":
      return (
        <g transform="rotate(12 60 56)">
          <path d="M44 57 L60 15 L76 57 Z" fill={`url(#${u}-pinkstripes)`} />
          <path d="M44 57 L60 15 L76 57 Z" fill={`url(#${u}-coneshade)`} />
          <path d="M44 57 Q60 61.5 76 57" stroke="#c43b8a" strokeWidth={2} fill="none" />
          {[-30, -10, 10, 30].map((a) => (
            <line key={a} x1={60} y1={14} x2={60 + Math.sin((a * Math.PI) / 180) * 7} y2={14 - Math.cos((a * Math.PI) / 180) * 7} stroke="#ffd34d" strokeWidth={1.6} strokeLinecap="round" />
          ))}
          <circle cx={60} cy={14} r={2.6} fill="#ffc22d" />
        </g>
      );
    case "crown":
      return (
        <g transform="rotate(-6 60 56)">
          <path d="M31 61 L28 35 L42 47 L51 29 L60 44 L69 29 L78 47 L92 35 L89 61 Z" fill={`url(#${u}-gold)`} stroke="#c98a12" strokeWidth={1} strokeLinejoin="round" />
          <path d="M33 58 L32 42 L41 50" stroke="rgba(255,255,255,.6)" strokeWidth={1.6} fill="none" strokeLinecap="round" />
          <rect x={30} y={53} width={60} height={8.5} rx={2.5} fill={`url(#${u}-goldband)`} />
          {[
            [28, 35],
            [51, 29],
            [69, 29],
            [92, 35],
          ].map(([x, y]) => (
            <circle key={x} cx={x} cy={y} r={2.6} fill="#fff4c4" stroke="#e0a62a" strokeWidth={0.6} />
          ))}
          {[
            [45, "#4f8cf0"],
            [60, "#ef4b5f"],
            [75, "#2fbf7f"],
          ].map(([x, c]) => (
            <g key={x as number}>
              <ellipse cx={x as number} cy={57.2} rx={2.8} ry={2.4} fill={c as string} />
              <circle cx={(x as number) - 0.9} cy={56.3} r={0.8} fill="#fff" opacity={0.8} />
            </g>
          ))}
        </g>
      );
    case "witch":
      return (
        <g>
          <path d="M36 57 C41 42 46 30 54 20 C59 13 70 7 85 10 C77 13 69 20 67 29 C69 39 76 48 84 57 Z" fill={`url(#${u}-purple)`} />
          <path d="M50 30 C53 24 57 19 62 15" stroke="rgba(255,255,255,.25)" strokeWidth={2.2} fill="none" strokeLinecap="round" />
          <path d="M39 50 C52 46 70 46 81 50 L83 56 C70 52 50 52 37 56 Z" fill="#ff8a2a" />
          <rect x={55.5} y={47.4} width={8} height={7} rx={1.4} fill="none" stroke="#ffd34d" strokeWidth={1.7} />
          <ellipse cx={60} cy={58} rx={46} ry={8} fill={`url(#${u}-brim)`} />
          <ellipse cx={60} cy={56.6} rx={40} ry={4.8} fill="#7a46d0" />
          <path d="M86 18 l1 2.4 2.4 0.4 -1.8 1.6 0.5 2.4 -2.1 -1.3 -2.1 1.3 0.5 -2.4 -1.8 -1.6 2.4 -0.4 Z" fill="#ffe27a" className="m-twinkle" />
        </g>
      );
    case "cap":
      return (
        <g>
          <path d="M29 62 C28 40 42 30 60 30 C78 30 92 40 91 62 Z" fill={`url(#${u}-brand)`} />
          <path d="M60 30 L60 61" stroke="rgba(0,0,0,.15)" strokeWidth={1.2} />
          <path d="M42 36 C48 32 55 31 59 31" stroke="rgba(255,255,255,.4)" strokeWidth={2.4} fill="none" strokeLinecap="round" />
          <circle cx={60} cy={30.5} r={2.6} fill="#c2185b" />
          <path d="M70 58 C84 55 104 57 110 63 C104 67 86 66 70 64 Z" fill="#c2185b" />
          <path d="M70 58 C84 55 104 57 110 63" stroke="rgba(255,255,255,.3)" strokeWidth={1.4} fill="none" />
        </g>
      );
    case "headphones":
      return (
        <g>
          <path d="M22 76 C20 44 38 33 60 33 C82 33 100 44 98 76" stroke={`url(#${u}-dark)`} strokeWidth={6} fill="none" strokeLinecap="round" />
          <path d="M28 58 C34 42 46 38 60 38" stroke="rgba(255,255,255,.25)" strokeWidth={1.6} fill="none" strokeLinecap="round" />
          {[16, 104].map((x) => (
            <g key={x}>
              <rect x={x - 7} y={66} width={14} height={22} rx={7} fill={`url(#${u}-dark)`} />
              <rect x={x - 4} y={70} width={8} height={14} rx={4} fill="#8b5cf0" className="m-pulse" />
            </g>
          ))}
        </g>
      );
    case "bow":
      return (
        <g transform="rotate(-12 82 52)">
          <path d="M82 52 L76 63 L79 63.5 L82 58 Z M82 52 L88 63 L85 63.5 L82 58 Z" fill="#e2589f" />
          <path d="M82 52 C73 41 64 44 66 52 C64 60 73 63 82 52 Z" fill={`url(#${u}-pink)`} />
          <path d="M82 52 C91 41 100 44 98 52 C100 60 91 63 82 52 Z" fill={`url(#${u}-pink)`} />
          <path d="M70 49 Q74 52 70 55 M94 49 Q90 52 94 55" stroke="rgba(170,30,110,.35)" strokeWidth={1.2} fill="none" strokeLinecap="round" />
          <ellipse cx={82} cy={52} rx={3.4} ry={4} fill="#e2589f" />
          <ellipse cx={81} cy={50.6} rx={1.2} ry={1} fill="#fff" opacity={0.6} />
        </g>
      );
    case "flower":
      return (
        <g transform="translate(82 49) scale(1.45)">
         <g className="m-sway">
          <path d="M0 4 Q-2 10 -6 13" stroke="#4c9a3a" strokeWidth={1.8} fill="none" strokeLinecap="round" />
          {Array.from({ length: 8 }, (_, i) => (
            <ellipse key={i} cx={0} cy={-6} rx={3.2} ry={6} fill="#fff" stroke="#f0d6e4" strokeWidth={0.6} transform={`rotate(${i * 45})`} />
          ))}
          <circle r={4} fill="#ffc83d" />
          <circle cx={-1.2} cy={-1.2} r={1.2} fill="#fff3b0" />
         </g>
        </g>
      );
  }
  return null;
}

function EyeWear({ id, u }: { id: string; u: string }) {
  if (id === "sunglasses") return <Shades u={u} />;
  if (id === "glasses")
    return (
      <g fill="none" stroke="#a8742f" strokeWidth={2}>
        <path d="M18.5 76 L36.5 78 M83.5 78 L101.5 76" strokeLinecap="round" />
        <path d="M53.5 78 Q60 74.5 66.5 78" strokeLinecap="round" />
        <circle cx={LX} cy={EY} r={8.8} fill="rgba(255,255,255,.16)" />
        <circle cx={RX} cy={EY} r={8.8} fill="rgba(255,255,255,.16)" />
        <path d={`M${LX - 5} ${EY - 4} Q${LX - 3} ${EY - 6} ${LX} ${EY - 6.4}`} stroke="rgba(255,255,255,.8)" strokeWidth={1.2} strokeLinecap="round" />
        <path d={`M${RX - 5} ${EY - 4} Q${RX - 3} ${EY - 6} ${RX} ${EY - 6.4}`} stroke="rgba(255,255,255,.8)" strokeWidth={1.2} strokeLinecap="round" />
      </g>
    );
  return null;
}

/** óculos escuros estilo wayfarer, com brilho */
function Shades({ u }: { u: string }) {
  return (
    <g>
      <path d="M17.5 73.5 L33 72.5 M87 72.5 L102.5 73.5" stroke="#111" strokeWidth={2.4} strokeLinecap="round" />
      <path d="M32 70.5 L57 70.5 Q58 70.5 57.6 72 L55.5 82 Q54.6 86 50.5 86 L38.5 86 Q34.3 86 33.4 82 L31 72.3 Q30.7 70.5 32 70.5 Z" fill={`url(#${u}-lens)`} />
      <path d="M88 70.5 L63 70.5 Q62 70.5 62.4 72 L64.5 82 Q65.4 86 69.5 86 L81.5 86 Q85.7 86 86.6 82 L89 72.3 Q89.3 70.5 88 70.5 Z" fill={`url(#${u}-lens)`} />
      <path d="M57 72.5 Q60 70.8 63 72.5" stroke="#111" strokeWidth={2.6} fill="none" />
      <path d="M35 74 L41 74 M66 74 L72 74" stroke="rgba(255,255,255,.55)" strokeWidth={1.8} strokeLinecap="round" />
      <path d="M46 83 L52 76 M77 83 L83 76" stroke="rgba(255,255,255,.12)" strokeWidth={2.4} strokeLinecap="round" />
    </g>
  );
}

function Neck({ id, u }: { id: string; u: string }) {
  if (id === "scarf")
    return (
      <g transform="translate(0 5.5)">
        <path d="M77 95 L75.5 110 Q80.5 113 86.5 110.5 L88.5 94 Z" fill={`url(#${u}-stripes)`} />
        <path d="M75.5 110 L74.8 114 M78.5 111.5 L78 115.5 M81.5 112 L81.5 116 M84.5 111.6 L85 115.5 M86.5 110.5 L87.2 114" stroke="#e23a48" strokeWidth={1.5} strokeLinecap="round" />
        <path d="M18 84 C33 96 87 96 102 84 L101 93 C87 105 33 105 19 93 Z" fill={`url(#${u}-stripes)`} />
        <path d="M18 84 C33 96 87 96 102 84 L101 93 C87 105 33 105 19 93 Z" fill={`url(#${u}-scarfshade)`} />
        <path d="M24 89 C38 99 82 99 96 89" stroke="rgba(255,255,255,.35)" strokeWidth={1.2} fill="none" />
      </g>
    );
  if (id === "bowtie")
    return (
      <g transform="translate(60 103)">
        <path d="M0 0 L-11 -6 Q-13 0 -11 6 Z" fill={`url(#${u}-redtie)`} />
        <path d="M0 0 L11 -6 Q13 0 11 6 Z" fill={`url(#${u}-redtie)`} />
        <rect x={-3} y={-3.4} width={6} height={6.8} rx={2} fill="#b8172a" />
        <path d="M-9 -3 L-4 -1 M9 -3 L4 -1" stroke="rgba(255,255,255,.35)" strokeWidth={1} strokeLinecap="round" />
      </g>
    );
  return null;
}

function Pumpkin({ u }: { u: string }) {
  return (
    <g>
      <ellipse cx={32} cy={78} rx={15} ry={24} fill={`url(#${u}-orange)`} />
      <ellipse cx={88} cy={78} rx={15} ry={24} fill={`url(#${u}-orange)`} />
      <ellipse cx={46} cy={78} rx={20} ry={27} fill={`url(#${u}-orange)`} stroke="#d4561a" strokeWidth={0.8} />
      <ellipse cx={74} cy={78} rx={20} ry={27} fill={`url(#${u}-orange)`} stroke="#d4561a" strokeWidth={0.8} />
      <ellipse cx={60} cy={78} rx={17} ry={28} fill={`url(#${u}-orange)`} stroke="#d4561a" strokeWidth={0.8} />
      <ellipse cx={52} cy={60} rx={8} ry={3} fill="rgba(255,255,255,.35)" />
      <path d="M58 52 C57 46 58 42 61 39 L65 41 C62 44 62 48 63 52 Z" fill="#4c8a2e" />
      <path d="M64 44 C70 38 78 40 80 44 C74 47 69 46 64 44 Z" fill="#6cb33f" />
      <path d="M64 41 C68 36 72 37 71 33" stroke="#4c8a2e" strokeWidth={1.2} fill="none" strokeLinecap="round" />
    </g>
  );
}

function Defs({ u, tint }: { u: string; tint: string }) {
  const lin = (id: string, a: string, b: string, x2 = "0.3") => (
    <linearGradient id={`${u}-${id}`} x1="0" y1="0" x2={x2} y2="1">
      <stop offset="0" stopColor={a} />
      <stop offset="1" stopColor={b} />
    </linearGradient>
  );
  return (
    <defs>
      <radialGradient id={`${u}-body`} cx="0.44" cy="0.3" r="0.9">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.5" stopColor="#fbfafd" />
        <stop offset="0.82" stopColor="#ebe9f1" />
        <stop offset="1" stopColor="#d9d6e3" />
      </radialGradient>
      <clipPath id={`${u}-clip`}>
        <path d={BODY} />
      </clipPath>
      <filter id={`${u}-plush`} x="-10%" y="-10%" width="120%" height="120%">
        <feGaussianBlur stdDeviation="0.45" />
      </filter>
      <filter id={`${u}-deep`} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="5" />
      </filter>
      <filter id={`${u}-grain`} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="1.6" numOctaves="2" seed="7" />
        <feColorMatrix values="0 0 0 0 0.86  0 0 0 0 0.85  0 0 0 0 0.9  0.5 0 0 0 -0.18" />
      </filter>
      <radialGradient id={`${u}-tint`} cx="0.45" cy="0.3" r="0.9">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.55" stopColor={tint} className="m-tint-stop" />
        <stop offset="1" stopColor={tint} className="m-tint-stop" />
      </radialGradient>
      <linearGradient id={`${u}-under`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.55" stopColor="#000" stopOpacity="0" />
        <stop offset="1" stopColor="#000" stopOpacity="0.09" />
      </linearGradient>
      <radialGradient id={`${u}-white`} cx="0.38" cy="0.3" r="0.8">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="1" stopColor="#d9d8e0" />
      </radialGradient>
      {lin("blue", "#79a5fb", "#3557c9", "0.4")}
      {lin("bluecuff", "#4b6fdc", "#2c47a6", "0")}
      {lin("red", "#ff5560", "#b3142a")}
      {lin("redtie", "#ff5565", "#c01a32")}
      {lin("pink", "#ffc0e2", "#ec5fae")}
      {lin("gold", "#fff0a8", "#eaa526", "0")}
      {lin("goldband", "#f6c241", "#d68e14", "0")}
      {lin("purple", "#a87cf6", "#4e239a", "0.4")}
      {lin("brim", "#6a39bd", "#3c1a7c", "0")}
      {lin("brand", "#ff8a2a", "#e23382", "0.8")}
      {lin("dark", "#3a3a44", "#121216", "0")}
      <linearGradient id={`${u}-lens`} x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0" stopColor="#3b3b44" />
        <stop offset="0.5" stopColor="#111114" />
        <stop offset="1" stopColor="#050506" />
      </linearGradient>
      <linearGradient id={`${u}-coneshade`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#fff" stopOpacity="0.25" />
        <stop offset="0.5" stopColor="#fff" stopOpacity="0" />
        <stop offset="1" stopColor="#000" stopOpacity="0.18" />
      </linearGradient>
      <linearGradient id={`${u}-scarfshade`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#000" stopOpacity="0" />
        <stop offset="1" stopColor="#000" stopOpacity="0.22" />
      </linearGradient>
      <radialGradient id={`${u}-orange`} cx="0.4" cy="0.3" r="0.9">
        <stop offset="0" stopColor="#ffb065" />
        <stop offset="1" stopColor="#e5621d" />
      </radialGradient>
      <pattern id={`${u}-stripes`} width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(80)">
        <rect width="9" height="9" fill="#e23a48" />
        <rect width="3.4" height="9" fill="#fff4f4" />
      </pattern>
      <pattern id={`${u}-pinkstripes`} width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(-35)">
        <rect width="8" height="8" fill="#ff7ac0" />
        <rect width="3.2" height="8" fill="#ffe36b" />
      </pattern>
      <filter id={`${u}-blur`} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2.4" />
      </filter>
      <filter id={`${u}-glow`} x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="11" />
      </filter>
      <filter id={`${u}-soft`} x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="1.4" />
      </filter>
      <filter id={`${u}-neon`} x="-80%" y="-80%" width="260%" height="260%">
        <feGaussianBlur stdDeviation="1.2" result="b" />
        <feMerge>
          <feMergeNode in="b" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
    </defs>
  );
}

export function Mochi({
  mood = "idle",
  outfit = {},
  size = 64,
  follow = false,
  still = false,
  crop = false,
  className,
  style,
  title,
}: {
  mood?: Mood;
  outfit?: Outfit;
  size?: number;
  /** olhinhos seguem o dedo/mouse */
  follow?: boolean;
  /** sem animação (miniaturas) */
  still?: boolean;
  /** caixa justa no corpo (chapéus passam por cima da caixa): para ícones na barra */
  crop?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  const u = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const look = useRef<SVGGElement>(null);
  const svg = useRef<SVGSVGElement>(null);

  useEffect(() => {
    if (!follow) return;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const el = svg.current;
        const g = look.current;
        if (!el || !g) return;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height * 0.64);
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / 260);
        g.style.transform = `translate(${((dx / d) * 3.4 * k).toFixed(2)}px, ${((dy / d) * 2.4 * k).toFixed(2)}px)`;
      });
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
    };
  }, [follow]);

  const face = FACES[mood] ?? FACES.idle;
  const pumpkin = outfit.costume === "pumpkin";
  const tint = pumpkin ? "#ffffff" : (face.tint ?? "#ffffff");
  const glow = face.glow ?? "#9b86ff";
  const texture = !still && size >= 80;
  const shadesUp = outfit.eyes === "sunglasses" && !(face.l === "dot" && face.r === "dot");

  return (
    <svg
      ref={svg}
      className={`mochi m-${mood} ${still ? "m-still" : ""} ${className ?? ""}`}
      width={size}
      height={crop ? Math.round((size * 80) / 104) : size}
      viewBox={crop ? "8 35 104 80" : "0 0 120 120"}
      role="img"
      aria-label={title ?? "Mochi"}
      style={style}
    >
      <Defs u={u} tint={tint} />
      {!still && <ellipse key={`g-${mood}`} className="m-glow" cx={60} cy={80} rx={50} ry={40} fill={glow} filter={`url(#${u}-glow)`} />}
      <ellipse className="m-shadow" cx={60} cy={111} rx={31} ry={4.2} fill="#000" opacity={0.26} filter={`url(#${u}-blur)`} />
      <ellipse className="m-floor" cx={60} cy={108.5} rx={36} ry={5} fill={glow} opacity={0.28} filter={`url(#${u}-blur)`} />
      <g className="m-move">
        <g className="m-pop" key={mood}>
          <g className="m-squish">
            {pumpkin ? (
              <Pumpkin u={u} />
            ) : (
              <>
                {/* silicone macio: base fosca, sombra interna embaixo, luz colorida nas bordas, brilho largo em cima e granulado fino */}
                <path d={BODY} fill={`url(#${u}-body)`} filter={`url(#${u}-plush)`} />
                <path d={BODY} fill={`url(#${u}-tint)`} style={{ mixBlendMode: "multiply" }} />
                <g clipPath={`url(#${u}-clip)`}>
                  <ellipse cx={60} cy={112} rx={46} ry={16} fill="#5b5670" opacity={0.28} filter={`url(#${u}-deep)`} />
                  <path d={BODY} fill="none" stroke={glow} strokeOpacity={0.55} strokeWidth={7} filter={`url(#${u}-deep)`} className="m-rim" />
                  <path d={BODY} fill="none" stroke="#fff" strokeOpacity={0.9} strokeWidth={3} filter={`url(#${u}-soft)`} transform="translate(0 1.2)" />
                  <ellipse cx={50} cy={55} rx={27} ry={11} fill="#fff" opacity={0.95} filter={`url(#${u}-deep)`} />
                  <ellipse cx={47} cy={51.5} rx={11} ry={3.2} fill="#fff" opacity={0.9} filter={`url(#${u}-soft)`} />
                  {texture && <rect x={14} y={40} width={92} height={70} filter={`url(#${u}-grain)`} opacity={0.5} style={{ mixBlendMode: "multiply" }} />}
                </g>
              </>
            )}

            {outfit.neck && !pumpkin && <Neck id={outfit.neck} u={u} />}

            <g className="m-look" ref={look}>
              <g className="m-face">
                <g className="m-eyes">
                  <g className="m-blink">
                    <Eye kind={face.l} x={LX} />
                    <Eye kind={face.r} x={RX} />
                  </g>
                </g>
                {face.blush && !outfit.eyes && <Blush />}
                {face.mouth && <Mouth kind={face.mouth} />}
              </g>
              {face.shades && <Shades u={u} />}
              {outfit.eyes && !face.shades && (
                // óculos escuros sobem para a testa quando a carinha precisa aparecer
                <g className="m-wear" style={shadesUp ? { transform: "translateY(-13px) scale(0.92)" } : undefined}>
                  <EyeWear id={outfit.eyes} u={u} />
                </g>
              )}
            </g>

            {outfit.head && (
              <g transform="translate(0 -5.5)">
                <Hat id={outfit.head} u={u} />
              </g>
            )}
          </g>

          {face.badge && <BadgeMark b={face.badge} />}
          {face.fx && <Effects fx={face.fx} u={u} />}
        </g>
      </g>
    </svg>
  );
}

/** Mochi num quadrinho escuro, como na grade de expressões. */
export function MochiTile({ children, active, onClick, label }: { children: ReactNode; active?: boolean; onClick?: () => void; label: string }) {
  return (
    <button type="button" className={`mochi-tile ${active ? "active" : ""}`} onClick={onClick} aria-pressed={active}>
      <span className="mochi-tile-art">{children}</span>
      <span className="mochi-tile-label">{label}</span>
    </button>
  );
}

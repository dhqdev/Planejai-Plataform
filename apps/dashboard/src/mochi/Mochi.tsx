import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import "./mochi.css";

/**
 * Mochi, o mascote do Planejai: uma bolinha branca, fosca e sólida, desenhada em SVG.
 * O corpo fica parado; quem fala são os olhos: seguem o mouse/dedo, passeiam sozinhos, piscam
 * e mudam de forma em cada expressão. Ao tocar, ele amassa e reage.
 */

export type Mood =
  | "idle"
  | "greeting"
  | "happy"
  | "finished"
  | "working"
  | "searching"
  | "thinking"
  | "curious"
  | "surprised"
  | "wink"
  | "laughing"
  | "sleepy"
  | "sleeping"
  | "annoyed"
  | "angry"
  | "sad"
  | "shy"
  | "dizzy"
  | "error";

export const MOODS: { id: Mood; label: string }[] = [
  { id: "idle", label: "parado" },
  { id: "happy", label: "feliz" },
  { id: "surprised", label: "surpreso" },
  { id: "curious", label: "curioso" },
  { id: "thinking", label: "pensando" },
  { id: "searching", label: "procurando" },
  { id: "wink", label: "piscando" },
  { id: "laughing", label: "rindo" },
  { id: "sleepy", label: "com sono" },
  { id: "sleeping", label: "dormindo" },
  { id: "annoyed", label: "entediado" },
  { id: "angry", label: "bravo" },
  { id: "sad", label: "triste" },
  { id: "shy", label: "tímido" },
  { id: "dizzy", label: "tonto" },
  { id: "error", label: "erro" },
];

export type Slot = "head" | "eyes" | "neck" | "costume";
export type Outfit = Partial<Record<Slot, string>>;

/** top = ponto mais alto do item (no viewBox 0..120), para o ícone recortado não cortar o chapéu */
export const ITEMS: { id: string; slot: Slot; label: string; top?: number }[] = [
  { id: "beanie", slot: "head", label: "Gorro", top: 12 },
  { id: "santa", slot: "head", label: "Papai Noel", top: 18 },
  { id: "party", slot: "head", label: "Festa", top: 5 },
  { id: "crown", slot: "head", label: "Coroa", top: 18 },
  { id: "witch", slot: "head", label: "Bruxa", top: 2 },
  { id: "cap", slot: "head", label: "Boné", top: 23 },
  { id: "headphones", slot: "head", label: "Fone", top: 27 },
  { id: "bow", slot: "head", label: "Laço", top: 34 },
  { id: "flower", slot: "head", label: "Flor", top: 30 },
  { id: "beret", slot: "head", label: "Boina", top: 28 },
  { id: "chef", slot: "head", label: "Chef", top: 8 },
  { id: "grad", slot: "head", label: "Formatura", top: 22 },
  { id: "cowboy", slot: "head", label: "Caubói", top: 25 },
  { id: "catears", slot: "head", label: "Gatinho", top: 22 },
  { id: "halo", slot: "head", label: "Auréola", top: 16 },
  { id: "sprout", slot: "head", label: "Brotinho", top: 20 },
  { id: "sunglasses", slot: "eyes", label: "Óculos escuros" },
  { id: "glasses", slot: "eyes", label: "Óculos" },
  { id: "hearts", slot: "eyes", label: "Coração" },
  { id: "mask", slot: "eyes", label: "Máscara" },
  { id: "monocle", slot: "eyes", label: "Monóculo" },
  { id: "scarf", slot: "neck", label: "Cachecol" },
  { id: "bowtie", slot: "neck", label: "Gravatinha" },
  { id: "tie", slot: "neck", label: "Gravata" },
  { id: "pearls", slot: "neck", label: "Colar" },
  { id: "medal", slot: "neck", label: "Medalha" },
  { id: "bandana", slot: "neck", label: "Bandana" },
  { id: "pumpkin", slot: "costume", label: "Abóbora", top: 30 },
  { id: "bear", slot: "costume", label: "Ursinho", top: 26 },
  { id: "dino", slot: "costume", label: "Dino", top: 24 },
  { id: "astronaut", slot: "costume", label: "Astronauta", top: 24 },
];

export const SLOTS: { id: Slot; label: string }[] = [
  { id: "head", label: "Cabeça" },
  { id: "eyes", label: "Olhos" },
  { id: "neck", label: "Pescoço" },
  { id: "costume", label: "Fantasia" },
];

/* ---------------- Olhos ---------------- */

/** pálpebra: corta o olho acima de uma linha (y relativo ao centro, lado de fora e lado de dentro) */
type Lid = { out: number; in: number };
type EyeShape =
  | { k: "dot"; s?: number; lid?: Lid }
  | { k: "happy" }
  | { k: "closed" }
  | { k: "line" }
  | { k: "gt" }
  | { k: "lt" }
  | { k: "spiral" };

interface Face {
  l: EyeShape;
  r: EyeShape;
  /** olhar fixo (não segue o mouse) */
  gaze?: [number, number];
  /** olhos procurando de um lado para o outro */
  scan?: "slow" | "fast";
}

const DOT: EyeShape = { k: "dot" };
const FACES: Record<Mood, Face> = {
  idle: { l: DOT, r: DOT },
  greeting: { l: { k: "happy" }, r: { k: "happy" } },
  happy: { l: { k: "happy" }, r: { k: "happy" } },
  finished: { l: { k: "happy" }, r: { k: "happy" } },
  working: { l: DOT, r: DOT, scan: "slow" },
  searching: { l: DOT, r: DOT, scan: "fast" },
  thinking: { l: { k: "dot", lid: { out: -2.5, in: -2.5 } }, r: { k: "dot", lid: { out: -2.5, in: -2.5 } }, gaze: [4, -3.5] },
  curious: { l: { k: "dot", s: 0.85 }, r: { k: "dot", s: 1.3 } },
  surprised: { l: { k: "dot", s: 1.3 }, r: { k: "dot", s: 1.3 } },
  wink: { l: DOT, r: { k: "happy" } },
  laughing: { l: { k: "gt" }, r: { k: "lt" } },
  sleepy: { l: { k: "dot", lid: { out: 0.6, in: 0.6 } }, r: { k: "dot", lid: { out: 0.6, in: 0.6 } }, gaze: [0, 1.5] },
  sleeping: { l: { k: "closed" }, r: { k: "closed" } },
  annoyed: { l: { k: "dot", lid: { out: -0.8, in: -0.8 } }, r: { k: "dot", lid: { out: -0.8, in: -0.8 } }, gaze: [5, 0.5] },
  angry: { l: { k: "dot", lid: { out: -4.5, in: 0.4 } }, r: { k: "dot", lid: { out: -4.5, in: 0.4 } } },
  sad: { l: { k: "dot", lid: { out: 0.2, in: -4.5 } }, r: { k: "dot", lid: { out: 0.2, in: -4.5 } }, gaze: [0, 3] },
  shy: { l: { k: "dot", s: 0.85 }, r: { k: "dot", s: 0.85 }, gaze: [-5, 3] },
  dizzy: { l: { k: "spiral" }, r: { k: "spiral" } },
  error: { l: { k: "line" }, r: { k: "line" } },
};

const INK = "#121214";
const LX = 45;
const RX = 75;
const EY = 78.5;
/** corpo como na referência: topo largo e quase reto, laterais retas, cantos bem arredondados */
const BODY = "M60 42 C88 42 102 45.5 102 64 L102 82 C102 100 88 106 60 106 C32 106 18 100 18 82 L18 64 C18 45.5 32 42 60 42 Z";

function Eye({ shape, x, side, u }: { shape: EyeShape; x: number; side: "l" | "r"; u: string }) {
  const y = EY;
  const s = { stroke: INK, strokeWidth: 2.9, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  switch (shape.k) {
    case "dot": {
      const k = shape.s ?? 1;
      const lid = shape.lid;
      // o lado "de dentro" do olho esquerdo é a direita, e vice-versa
      const yl = lid ? y + (side === "l" ? lid.out : lid.in) : 0;
      const yr = lid ? y + (side === "l" ? lid.in : lid.out) : 0;
      const id = `${u}-lid-${side}`;
      return (
        <g className="m-eye">
          {lid && (
            <clipPath id={id}>
              <path className="m-lid" d={`M${x - 9} ${yl} L${x + 9} ${yr} L${x + 9} ${y + 12} L${x - 9} ${y + 12} Z`} />
            </clipPath>
          )}
          <g clipPath={lid ? `url(#${id})` : undefined}>
            <ellipse cx={x} cy={y} rx={4.4 * k} ry={5.1 * k} fill={INK} />
            {/* reflexo pequeno: olho de vidro, não de tinta */}
            <ellipse cx={x + 1.5 * k} cy={y - 2.1 * k} rx={1.25 * k} ry={1.05 * k} fill="#fff" opacity={0.92} />
          </g>
        </g>
      );
    }
    case "happy":
      return <path className="m-eye" d={`M${x - 5.6} ${y + 2.2} Q${x} ${y - 6} ${x + 5.6} ${y + 2.2}`} {...s} />;
    case "closed":
      return <path className="m-eye" d={`M${x - 5.6} ${y - 1} Q${x} ${y + 5} ${x + 5.6} ${y - 1}`} {...s} />;
    case "line":
      return <path className="m-eye" d={`M${x - 5} ${y} L${x + 5} ${y}`} {...s} />;
    case "gt":
      return <path className="m-eye" d={`M${x - 4} ${y - 4.4} L${x + 3.8} ${y} L${x - 4} ${y + 4.4}`} {...s} />;
    case "lt":
      return <path className="m-eye" d={`M${x + 4} ${y - 4.4} L${x - 3.8} ${y} L${x + 4} ${y + 4.4}`} {...s} />;
    case "spiral":
      return (
        <g className="m-eye m-spin">
          <path d={`M${x} ${y} m-0.4 0 a0.8 0.8 0 1 1 1.6 0 a1.9 1.9 0 1 1 -3.8 0 a3 3 0 1 1 6 0 a4.2 4.2 0 1 1 -8.4 0`} stroke={INK} strokeWidth={1.7} strokeLinecap="round" fill="none" />
        </g>
      );
  }
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
          <path d="M86 18 l1 2.4 2.4 0.4 -1.8 1.6 0.5 2.4 -2.1 -1.3 -2.1 1.3 0.5 -2.4 -1.8 -1.6 2.4 -0.4 Z" fill="#ffe27a" />
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
          <path d="M20 74 C18 44 38 34 60 34 C82 34 102 44 100 74" stroke={`url(#${u}-dark)`} strokeWidth={5.5} fill="none" strokeLinecap="round" />
          <path d="M28 58 C34 42 46 38 60 38" stroke="rgba(255,255,255,.25)" strokeWidth={1.6} fill="none" strokeLinecap="round" />
          {[19, 101].map((x) => (
            <g key={x}>
              <rect x={x - 6.5} y={70} width={13} height={22} rx={6.5} fill={`url(#${u}-dark)`} />
              <rect x={x - 3.8} y={74} width={7.6} height={14} rx={3.8} fill="#8b5cf0" />
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
         <g>
          <path d="M0 4 Q-2 10 -6 13" stroke="#4c9a3a" strokeWidth={1.8} fill="none" strokeLinecap="round" />
          {Array.from({ length: 8 }, (_, i) => (
            <ellipse key={i} cx={0} cy={-6} rx={3.2} ry={6} fill="#fff" stroke="#f0d6e4" strokeWidth={0.6} transform={`rotate(${i * 45})`} />
          ))}
          <circle r={4} fill="#ffc83d" />
          <circle cx={-1.2} cy={-1.2} r={1.2} fill="#fff3b0" />
         </g>
        </g>
      );
    case "beret":
      return (
        <g transform="rotate(-8 58 52)">
          <path d="M56 37 l1.5 -5.5" stroke="#3a1730" strokeWidth={2.6} strokeLinecap="round" />
          <ellipse cx={58} cy={49} rx={36} ry={12.5} fill={`url(#${u}-wine)`} />
          <ellipse cx={58} cy={56.5} rx={30} ry={4.4} fill="#5e1a3c" />
          <path d="M34 44 C42 39 54 37.5 64 38" stroke="rgba(255,255,255,.3)" strokeWidth={2.4} fill="none" strokeLinecap="round" />
        </g>
      );
    case "chef":
      return (
        <g>
          <rect x={39} y={30} width={42} height={28} rx={4} fill={`url(#${u}-white)`} />
          {[
            [45, 28, 11],
            [60, 22, 13],
            [75, 28, 11],
            [52, 32, 9],
            [68, 32, 9],
          ].map(([x, y, r]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={r} fill={`url(#${u}-white)`} />
          ))}
          <path d="M48 36 L49 52 M60 34 L60 52 M72 36 L71 52" stroke="rgba(0,0,0,.07)" strokeWidth={1.6} strokeLinecap="round" />
          <rect x={36} y={51} width={48} height={11} rx={4} fill={`url(#${u}-white)`} stroke="rgba(0,0,0,.08)" strokeWidth={0.8} />
        </g>
      );
    case "grad":
      return (
        <g>
          <path d="M40 48 Q60 43 80 48 L80 60 Q60 55 40 60 Z" fill={`url(#${u}-dark)`} />
          <path d="M60 28 L100 38.5 L60 49 L20 38.5 Z" fill={`url(#${u}-dark)`} />
          <path d="M60 30 L94 38.5" stroke="rgba(255,255,255,.22)" strokeWidth={1.4} strokeLinecap="round" />
          <circle cx={60} cy={38.5} r={2.2} fill="#ffc83d" />
          <path d="M60 38.5 Q80 40 90 42 L91 56" stroke="#ffc83d" strokeWidth={1.6} fill="none" strokeLinecap="round" />
          <path d="M88.5 55 L93.5 55 L94.5 63 L87.5 63 Z" fill="#ffc83d" />
        </g>
      );
    case "cowboy":
      return (
        <g transform="translate(0 5)">
          <path d="M36 56 C34 41 38 30 46 29.5 C52 29 56 33 60 33 C64 33 68 29 74 29.5 C82 30 86 41 84 56 Z" fill={`url(#${u}-leather)`} />
          <path d="M60 33.5 L60 45" stroke="rgba(0,0,0,.18)" strokeWidth={1.6} strokeLinecap="round" />
          <rect x={36} y={48} width={48} height={7} rx={2} fill="#5a3416" />
          <path d="M10 53 C16 47 24 51 30 55 C46 61 74 61 90 55 C96 51 104 47 110 53 C106 63 86 66 60 66 C34 66 14 63 10 53 Z" fill={`url(#${u}-leather)`} />
          <path d="M42 34 C46 31 50 31 53 32" stroke="rgba(255,255,255,.3)" strokeWidth={2} fill="none" strokeLinecap="round" />
        </g>
      );
    case "catears":
      return (
        <g stroke="#2a2a33" strokeWidth={3} strokeLinejoin="round" strokeLinecap="round">
          <path d="M24 60 C30 52 44 47 60 47 C76 47 90 52 96 60" fill="none" />
          <path d="M27 55 L32 29 L50 49 Z" fill="#2a2a33" />
          <path d="M93 55 L88 29 L70 49 Z" fill="#2a2a33" />
          <path d="M32.5 49 L34.5 37 L43 47 Z M87.5 49 L85.5 37 L77 47 Z" fill="#ff9ec9" stroke="#ff9ec9" strokeWidth={1.4} />
        </g>
      );
    case "halo":
      return (
        <g>
          <ellipse cx={60} cy={30} rx={24} ry={7} fill="none" stroke="#ffe27a" strokeWidth={7} opacity={0.35} filter={`url(#${u}-soft)`} />
          <ellipse cx={60} cy={30} rx={22} ry={6} fill="none" stroke={`url(#${u}-gold)`} strokeWidth={3.6} />
          <path d="M44 27 Q52 24.5 60 24.5" stroke="#fff8d6" strokeWidth={1.3} fill="none" strokeLinecap="round" />
        </g>
      );
    case "sprout":
      return (
        <g>
          <path d="M60 52 C60 46 59 40 61 34" stroke="#4c9a3a" strokeWidth={2.4} fill="none" strokeLinecap="round" />
          <path d="M61 35 C54 26 44 28 41 33 C48 38 56 38 61 35 Z" fill="#6cc04a" />
          <path d="M61 35 C66 24 78 24 81 29 C75 35 67 37 61 35 Z" fill="#82d35a" />
          <path d="M45 32.5 C50 32 56 33.5 60 35 M64 33.5 C69 30 74 28.5 78 29" stroke="rgba(0,0,0,.12)" strokeWidth={0.9} fill="none" strokeLinecap="round" />
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
  if (id === "hearts")
    return (
      <g>
        <path d="M18.5 75 L33.5 77 M86.5 77 L101.5 75" stroke="#e0306f" strokeWidth={2} strokeLinecap="round" />
        <path d="M54.5 77 Q60 74 65.5 77" stroke="#e0306f" strokeWidth={2} fill="none" strokeLinecap="round" />
        {[LX, RX].map((x) => (
          <path key={x} transform={`translate(${x} ${EY + 1.5}) scale(1.05)`} d="M0 9.5 C-14 1 -12 -10 -5 -10 C-2 -10 0 -8 0 -6 C0 -8 2 -10 5 -10 C12 -10 14 1 0 9.5 Z" fill="#ff5c93" fillOpacity={0.45} stroke="#e0306f" strokeWidth={1.9} strokeLinejoin="round" />
        ))}
        <path d={`M${LX - 8} ${EY - 4} Q${LX - 7} ${EY - 7.5} ${LX - 3.5} ${EY - 8}`} stroke="rgba(255,255,255,.85)" strokeWidth={1.3} fill="none" strokeLinecap="round" />
      </g>
    );
  if (id === "mask")
    return (
      <g>
        <path d="M100 74 C106 76 110 82 108 90 M100 76 C104 82 104 88 100 94" stroke="#1b1b22" strokeWidth={2.6} fill="none" strokeLinecap="round" />
        <path
          fillRule="evenodd"
          fill={`url(#${u}-dark)`}
          d={`M18 71 C34 66 48 69 60 72 C72 69 86 66 102 71 L101 84 C88 90 72 88 60 85 C48 88 32 90 19 84 Z M${LX} ${EY - 7} a9.5 7.5 0 1 0 0.01 0 Z M${RX} ${EY - 7} a9.5 7.5 0 1 0 0.01 0 Z`}
        />
        <path d="M24 71.5 C34 68.5 44 69 52 70.5" stroke="rgba(255,255,255,.25)" strokeWidth={1.4} fill="none" strokeLinecap="round" />
      </g>
    );
  if (id === "monocle")
    return (
      <g>
        <path d={`M${RX + 6.5} ${EY + 6.5} C${RX + 10} ${EY + 16} ${RX + 18} ${EY + 18} ${RX + 22} ${EY + 24}`} stroke="#c99a2e" strokeWidth={1.2} fill="none" strokeDasharray="1.6 1.4" strokeLinecap="round" />
        <circle cx={RX} cy={EY} r={9.2} fill="rgba(255,255,255,.18)" stroke={`url(#${u}-gold)`} strokeWidth={2.4} />
        <path d={`M${RX - 5} ${EY - 4.5} Q${RX - 3} ${EY - 6.6} ${RX} ${EY - 6.8}`} stroke="rgba(255,255,255,.85)" strokeWidth={1.2} fill="none" strokeLinecap="round" />
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
      <g transform="translate(60 98.5)">
        <path d="M0 0 L-11 -6 Q-13 0 -11 6 Z" fill={`url(#${u}-redtie)`} />
        <path d="M0 0 L11 -6 Q13 0 11 6 Z" fill={`url(#${u}-redtie)`} />
        <rect x={-3} y={-3.4} width={6} height={6.8} rx={2} fill="#b8172a" />
        <path d="M-9 -3 L-4 -1 M9 -3 L4 -1" stroke="rgba(255,255,255,.35)" strokeWidth={1} strokeLinecap="round" />
      </g>
    );
  if (id === "tie")
    return (
      <g>
        <path d="M51.5 87 L68.5 87 L65 94.5 L55 94.5 Z" fill="#1f3f8f" />
        <path d="M55 94.5 L65 94.5 L70.5 107 L60 113 L49.5 107 Z" fill={`url(#${u}-navy)`} />
        <path d="M53 100 L67 97 M51.5 105.5 L69 102" stroke="rgba(255,255,255,.28)" strokeWidth={1.6} strokeLinecap="round" />
      </g>
    );
  if (id === "pearls")
    return (
      <g>
        {Array.from({ length: 13 }, (_, i) => {
          const t = i / 12;
          const x = 26 + t * 68;
          const y = 88 + Math.sin(t * Math.PI) * 10;
          return (
            <g key={i}>
              <circle cx={x} cy={y} r={i === 6 ? 3.6 : 2.7} fill={`url(#${u}-white)`} stroke="rgba(0,0,0,.12)" strokeWidth={0.5} />
              <circle cx={x - 0.8} cy={y - 0.9} r={0.8} fill="#fff" />
            </g>
          );
        })}
      </g>
    );
  if (id === "medal")
    return (
      <g>
        <path d="M44 86 L55 99 L60 95 L51 84 Z" fill="#3f6fdc" />
        <path d="M76 86 L65 99 L60 95 L69 84 Z" fill="#e23a48" />
        <circle cx={60} cy={100} r={6.6} fill={`url(#${u}-gold)`} stroke="#c98a12" strokeWidth={0.8} />
        <path d="M60 96.6 l1 2.2 2.4 0.3 -1.8 1.6 0.5 2.4 -2.1 -1.2 -2.1 1.2 0.5 -2.4 -1.8 -1.6 2.4 -0.3 Z" fill="#fff4c4" />
      </g>
    );
  if (id === "bandana")
    return (
      <g>
        <path d="M20 86 C34 94 86 94 100 86 L98 93 C88 98 74 100 68 101 L60 110 L52 101 C46 100 32 98 22 93 Z" fill={`url(#${u}-red)`} />
        {[
          [34, 93],
          [48, 96.5],
          [72, 96.5],
          [86, 93],
          [60, 102],
        ].map(([x, y]) => (
          <circle key={x} cx={x} cy={y} r={1.3} fill="#fff" opacity={0.9} />
        ))}
        <path d="M26 89 C40 95 80 95 94 89" stroke="rgba(255,255,255,.35)" strokeWidth={1} fill="none" />
      </g>
    );
  return null;
}

/** capuz de bichinho por cima do corpo, com o rosto aparecendo */
const HOOD = "M60 36 C92 36 107 41 107 62 L107 92 C107 101 100 106 90 106 L30 106 C20 106 13 101 13 92 L13 62 C13 41 28 36 60 36 Z";
const FACE_HOLE = "M60 63 C80 63 92 68 92 80 C92 93 80 98 60 98 C40 98 28 93 28 80 C28 68 40 63 60 63 Z";

function Hood({ id, u }: { id: string; u: string }) {
  const fill = id === "bear" ? `url(#${u}-fur)` : `url(#${u}-dino)`;
  return (
    <g>
      {id === "bear" &&
        [26, 94].map((x) => (
          <g key={x}>
            <circle cx={x} cy={40} r={12} fill={`url(#${u}-fur)`} />
            <circle cx={x} cy={40.5} r={6.5} fill="#e7b98c" />
          </g>
        ))}
      {id === "dino" &&
        [
          [43, 39, 9],
          [60, 37, 13],
          [77, 39, 9],
        ].map(([x, y, h]) => (
          <path key={x} d={`M${x - 7} ${y + 3} Q${x} ${y - h * 2} ${x + 7} ${y + 3} Z`} fill="#ffb84d" stroke="#e8902a" strokeWidth={0.8} />
        ))}
      <path fillRule="evenodd" d={`${HOOD} ${FACE_HOLE}`} fill={fill} />
      <path fillRule="evenodd" d={`${HOOD} ${FACE_HOLE}`} fill={`url(#${u}-shade)`} />
      <path d={FACE_HOLE} fill="none" stroke="rgba(0,0,0,.18)" strokeWidth={1.6} />
      <path d="M34 44 C44 39.5 54 38.5 64 39" stroke="rgba(255,255,255,.28)" strokeWidth={2.6} fill="none" strokeLinecap="round" />
      {id === "dino" &&
        [
          [22, 70],
          [98, 72],
          [26, 94],
          [95, 95],
        ].map(([x, y]) => <circle key={x} cx={x} cy={y} r={3} fill="#3e9a4f" opacity={0.7} />)}
    </g>
  );
}

/** capacete de astronauta: vidro por cima e gola embaixo */
function Helmet({ u }: { u: string }) {
  return (
    <g>
      <path d="M60 24 C92 24 112 44 112 70 C112 84 108 92 104 96 L16 96 C12 92 8 84 8 70 C8 44 28 24 60 24 Z" fill={`url(#${u}-glass)`} stroke="rgba(160,190,230,.9)" strokeWidth={1.6} />
      <path d="M30 40 C38 32 50 29 60 29" stroke="#fff" strokeOpacity={0.85} strokeWidth={3} fill="none" strokeLinecap="round" />
      <path d="M100 52 C104 58 106 64 106 70" stroke="#fff" strokeOpacity={0.55} strokeWidth={2} fill="none" strokeLinecap="round" />
      <rect x={12} y={94} width={96} height={14} rx={7} fill={`url(#${u}-white)`} stroke="rgba(0,0,0,.12)" strokeWidth={0.8} />
      <rect x={28} y={98} width={10} height={6} rx={2} fill="#ef4b5f" />
      <rect x={42} y={98} width={6} height={6} rx={2} fill="#4f8cf0" />
      <circle cx={88} cy={101} r={3} fill="#2fbf7f" />
    </g>
  );
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


function Defs({ u }: { u: string }) {
  const lin = (id: string, a: string, b: string, x2 = "0.3") => (
    <linearGradient id={`${u}-${id}`} x1="0" y1="0" x2={x2} y2="1">
      <stop offset="0" stopColor={a} />
      <stop offset="1" stopColor={b} />
    </linearGradient>
  );
  return (
    <defs>
      {/* corpo fosco: luz vindo de cima à direita, sombra suave embaixo e à esquerda */}
      <radialGradient id={`${u}-body`} cx="0.6" cy="0.2" r="0.95" fx="0.62" fy="0.18">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.35" stopColor="#f3f3f5" />
        <stop offset="0.7" stopColor="#dcdce0" />
        <stop offset="1" stopColor="#b9b9bf" />
      </radialGradient>
      <linearGradient id={`${u}-shade`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.5" stopColor="#000" stopOpacity="0" />
        <stop offset="1" stopColor="#000" stopOpacity="0.12" />
      </linearGradient>
      <linearGradient id={`${u}-side`} x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stopColor="#000" stopOpacity="0.08" />
        <stop offset="0.25" stopColor="#000" stopOpacity="0" />
        <stop offset="1" stopColor="#000" stopOpacity="0" />
      </linearGradient>
      <clipPath id={`${u}-clip`}>
        <path d={BODY} />
      </clipPath>
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
      {lin("wine", "#c2457a", "#6e1e48", "0.4")}
      {lin("leather", "#c98a4b", "#7a4a1e", "0.4")}
      {lin("navy", "#3a63c9", "#1a3480", "0")}
      {lin("fur", "#b98353", "#7c4f2c", "0.4")}
      {lin("dino", "#7fd36b", "#3f9a4c", "0.4")}
      <linearGradient id={`${u}-glass`} x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stopColor="#dbeaff" stopOpacity="0.45" />
        <stop offset="1" stopColor="#a9c8f0" stopOpacity="0.12" />
      </linearGradient>
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
      <filter id={`${u}-shadow`} x="-50%" y="-200%" width="200%" height="500%">
        <feGaussianBlur stdDeviation="3.2" />
      </filter>
      <filter id={`${u}-contact`} x="-50%" y="-300%" width="200%" height="700%">
        <feGaussianBlur stdDeviation="1.6" />
      </filter>
      <filter id={`${u}-soft`} x="-30%" y="-60%" width="160%" height="220%">
        <feGaussianBlur stdDeviation="4" />
      </filter>
    </defs>
  );
}

/* ---------------- Comportamento dos olhos ---------------- */

const POKES: Mood[] = ["happy", "surprised", "laughing", "wink", "happy", "curious"];
const RANGE_X = 6.5;
const RANGE_Y = 4.5;

export function Mochi({
  mood = "idle",
  outfit = {},
  size = 64,
  still = false,
  crop = false,
  follow,
  className,
  style,
  title,
}: {
  mood?: Mood;
  outfit?: Outfit;
  size?: number;
  /** sem vida (miniaturas da grade) */
  still?: boolean;
  /** caixa justa no corpo (chapéus passam por cima da caixa): para ícones na barra */
  crop?: boolean;
  /** compatibilidade: os olhos sempre seguem o mouse quando ele não está parado */
  follow?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
}) {
  void follow;
  const u = "m" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const svg = useRef<SVGSVGElement>(null);
  const look = useRef<SVGGElement>(null);
  const lids = useRef<SVGGElement>(null);
  const [poke, setPoke] = useState<Mood | null>(null);
  const [squish, setSquish] = useState(0);
  const clicks = useRef<number[]>([]);

  const shown: Mood = poke ?? mood;
  const face = FACES[shown] ?? FACES.idle;
  const fixed = face.gaze;
  const scanning = !!face.scan;

  // olhar: segue o ponteiro; parado, os olhos passeiam sozinhos (pulinhos rápidos como olhos de verdade)
  useEffect(() => {
    if (still) return;
    const g = look.current;
    const el = svg.current;
    if (!g || !el) return;
    const set = (x: number, y: number) => {
      g.style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px)`;
    };
    if (fixed) {
      set(fixed[0], fixed[1]);
      return;
    }
    if (scanning) {
      set(0, 0);
      return;
    }
    let lastMove = 0;
    let raf = 0;
    const onMove = (e: PointerEvent) => {
      lastMove = Date.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        if (!r.width) return;
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height * 0.62);
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / (r.width * 1.6));
        set((dx / d) * RANGE_X * k, (dy / d) * RANGE_Y * k);
      });
    };
    let t: ReturnType<typeof setTimeout>;
    const wander = () => {
      if (Date.now() - lastMove > 2500 && !document.hidden) {
        const r = Math.random();
        if (r < 0.3) set(0, 0);
        else set((Math.random() * 2 - 1) * RANGE_X, (Math.random() * 2 - 1) * RANGE_Y * 0.8);
      }
      t = setTimeout(wander, 700 + Math.random() * 2300);
    };
    t = setTimeout(wander, 900);
    window.addEventListener("pointermove", onMove);
    return () => {
      clearTimeout(t);
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
    };
  }, [still, fixed?.[0], fixed?.[1], scanning]);

  // piscar: intervalo aleatório, às vezes duas vezes seguidas
  useEffect(() => {
    if (still || shown === "sleeping") return;
    const g = lids.current;
    if (!g) return;
    let t: ReturnType<typeof setTimeout>;
    const blink = (twice: boolean) => {
      g.classList.add("m-blinking");
      setTimeout(() => {
        g.classList.remove("m-blinking");
        if (twice) setTimeout(() => blink(false), 140);
      }, 130);
    };
    const loop = () => {
      blink(Math.random() < 0.25);
      t = setTimeout(loop, (shown === "sleepy" ? 1400 : 2200) + Math.random() * 3800);
    };
    t = setTimeout(loop, 1200 + Math.random() * 2000);
    return () => clearTimeout(t);
  }, [still, shown]);

  // reação ao toque some depois de um tempinho
  useEffect(() => {
    if (!poke) return;
    const t = setTimeout(() => setPoke(null), poke === "dizzy" ? 2200 : 1100);
    return () => clearTimeout(t);
  }, [poke, squish]);

  const onPoke = () => {
    if (still) return;
    const now = Date.now();
    clicks.current = [...clicks.current.filter((c) => now - c < 2000), now];
    setSquish((n) => n + 1);
    setPoke(clicks.current.length >= 5 ? "dizzy" : POKES[Math.floor(Math.random() * POKES.length)]);
  };

  const pumpkin = outfit.costume === "pumpkin";
  const hood = outfit.costume === "bear" || outfit.costume === "dino";
  const astronaut = outfit.costume === "astronaut";
  // recorte justo no corpo; se tem chapéu, a caixa cresce para cima (mesma proporção) e nada fica cortado
  const top = Math.min(34, ...ITEMS.filter((i) => i.top !== undefined && outfit[i.slot] === i.id && !(astronaut && i.slot === "head")).map((i) => (i.top as number) - 2));
  const ch = 114 - top;
  const cw = (ch * 104) / 80;
  const cropBox = `${(60 - cw / 2).toFixed(1)} ${top} ${cw.toFixed(1)} ${ch}`;
  const shadesUp = outfit.eyes === "sunglasses" && !(face.l.k === "dot" && face.r.k === "dot" && !face.l.lid && !face.l.s);

  return (
    <svg
      ref={svg}
      className={`mochi ${still ? "m-still" : ""} ${face.scan ? `m-scan-${face.scan}` : ""} ${className ?? ""}`}
      width={size}
      height={crop ? Math.round((size * 80) / 104) : size}
      viewBox={crop ? cropBox : "0 0 120 120"}
      role="img"
      aria-label={title ?? "Mochi"}
      style={style}
      onPointerDown={onPoke}
    >
      <Defs u={u} />
      <ellipse className="m-shadow" cx={60} cy={108.5} rx={40} ry={4} fill="#000" opacity={0.22} filter={`url(#${u}-shadow)`} />
      <ellipse className="m-shadow" cx={60} cy={106.4} rx={30} ry={2.4} fill="#000" opacity={0.42} filter={`url(#${u}-contact)`} />
      <g className={squish ? `m-squish m-squish-${squish % 2}` : "m-squish"}>
        {pumpkin ? (
          <Pumpkin u={u} />
        ) : (
          <>
            <path d={BODY} fill={`url(#${u}-body)`} />
            <path d={BODY} fill={`url(#${u}-shade)`} />
            <path d={BODY} fill={`url(#${u}-side)`} />
            {/* brilho largo e difuso no alto à direita (acabamento fosco) */}
            <g clipPath={`url(#${u}-clip)`}>
              <ellipse cx={70} cy={52} rx={24} ry={9} fill="#fff" opacity={0.75} filter={`url(#${u}-soft)`} />
              {/* luz que volta do chão na borda de baixo: dá volume */}
              <ellipse cx={58} cy={106} rx={32} ry={4.5} fill="#fff" opacity={0.45} filter={`url(#${u}-soft)`} />
            </g>
            <path d={BODY} fill="none" stroke="#000" strokeOpacity={0.07} strokeWidth={0.8} />
          </>
        )}

        {hood && <Hood id={outfit.costume as string} u={u} />}
        {outfit.neck && !pumpkin && !astronaut && <Neck id={outfit.neck} u={u} />}

        <g className="m-look" ref={look}>
          <g className={`m-eyes ${face.scan ? "m-scanning" : ""}`}>
            <g className="m-blink" ref={lids} key={shown}>
              <Eye shape={face.l} x={LX} side="l" u={u} />
              <Eye shape={face.r} x={RX} side="r" u={u} />
            </g>
          </g>
        </g>
        {outfit.eyes && (
          // óculos escuros sobem para a testa quando a expressão precisa aparecer
          <g className="m-wear" style={shadesUp ? { transform: "translateY(-14px) scale(0.92)" } : undefined}>
            <EyeWear id={outfit.eyes} u={u} />
          </g>
        )}

        {outfit.head && !astronaut && (
          <g transform={hood ? "translate(0 -9)" : "translate(0 -6.5)"}>
            <Hat id={outfit.head} u={u} />
          </g>
        )}
        {astronaut && <Helmet u={u} />}
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

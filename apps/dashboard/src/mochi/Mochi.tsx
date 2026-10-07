import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import "./mochi.css";

/**
 * Mochi, o mascote do Planejai: uma bolinha macia desenhada em SVG, com expressões e roupinhas.
 * Tudo é código (sem imagem), então escala do ícone da barra até a tela de roupinhas.
 */

export type Mood =
  | "idle"
  | "working"
  | "thinking"
  | "searching"
  | "approval"
  | "question"
  | "error"
  | "finished"
  | "ratelimit"
  | "sleeping"
  | "dizzy"
  | "greeting"
  | "love"
  | "surprised"
  | "proud"
  | "wink"
  | "yawn"
  | "annoyed"
  | "upload"
  | "dancing";

export const MOODS: { id: Mood; label: string }[] = [
  { id: "idle", label: "parado" },
  { id: "working", label: "trabalhando" },
  { id: "thinking", label: "pensando" },
  { id: "searching", label: "pesquisando" },
  { id: "approval", label: "aprovação" },
  { id: "question", label: "pergunta" },
  { id: "error", label: "erro" },
  { id: "finished", label: "pronto" },
  { id: "ratelimit", label: "no limite" },
  { id: "sleeping", label: "dormindo" },
  { id: "dizzy", label: "tonto" },
  { id: "greeting", label: "oi" },
  { id: "love", label: "amor" },
  { id: "surprised", label: "surpreso" },
  { id: "proud", label: "orgulhoso" },
  { id: "wink", label: "piscadinha" },
  { id: "yawn", label: "bocejo" },
  { id: "annoyed", label: "bravinho" },
  { id: "upload", label: "enviando" },
  { id: "dancing", label: "dançando" },
];

export type Slot = "head" | "eyes" | "neck" | "costume";
export type Outfit = Partial<Record<Slot, string>>;

export const ITEMS: { id: string; slot: Slot; label: string }[] = [
  { id: "beanie", slot: "head", label: "Gorro" },
  { id: "santa", slot: "head", label: "Papai Noel" },
  { id: "party", slot: "head", label: "Festa" },
  { id: "crown", slot: "head", label: "Coroa" },
  { id: "witch", slot: "head", label: "Bruxa" },
  { id: "bow", slot: "head", label: "Laço" },
  { id: "sunglasses", slot: "eyes", label: "Óculos escuros" },
  { id: "glasses", slot: "eyes", label: "Óculos" },
  { id: "scarf", slot: "neck", label: "Cachecol" },
  { id: "pumpkin", slot: "costume", label: "Abóbora" },
];

export const SLOTS: { id: Slot; label: string }[] = [
  { id: "head", label: "Cabeça" },
  { id: "eyes", label: "Olhos" },
  { id: "neck", label: "Pescoço" },
  { id: "costume", label: "Fantasia" },
];

/** Cor de cada humor (multiplicada sobre o branco, então a luz e a sombra continuam). */
const TINT: Partial<Record<Mood, string>> = {
  working: "#bcd0fb",
  thinking: "#d6c8fb",
  searching: "#cbcbfa",
  approval: "#fbd7a4",
  question: "#b9eaf3",
  error: "#f8bcc4",
  finished: "#c2ecd9",
  ratelimit: "#f9d6b6",
  dizzy: "#f6c4e4",
  love: "#c9dcfb",
  proud: "#d2eec8",
};

const BADGE: Partial<Record<Mood, { kind: "dots" | "!" | "?" | "dot"; color: string }>> = {
  working: { kind: "dots", color: "#4f72f0" },
  thinking: { kind: "dots", color: "#8b5cf0" },
  searching: { kind: "dots", color: "#6a63ee" },
  love: { kind: "dots", color: "#4f72f0" },
  approval: { kind: "!", color: "#f29a1f" },
  question: { kind: "?", color: "#2bb3cf" },
  error: { kind: "dot", color: "#ef4b5f" },
  finished: { kind: "dot", color: "#2fbf7f" },
  ratelimit: { kind: "dot", color: "#f2862b" },
  proud: { kind: "dot", color: "#2fbf7f" },
};

const INK = "#17171b";
const LX = 45;
const RX = 75;
const EY = 80;
const BODY = "M60 49 C85 49 101 51 101 73 C101 95 88 105 60 105 C32 105 19 95 19 73 C19 51 35 49 60 49 Z";

type EyeKind = "dot" | "big" | "happy" | "sleepy" | "line" | "spiral" | "heart" | "star" | "annoyedL" | "annoyedR";

const EYES: Record<Mood, [EyeKind, EyeKind]> = {
  idle: ["dot", "dot"],
  working: ["dot", "dot"],
  thinking: ["dot", "dot"],
  searching: ["dot", "dot"],
  approval: ["dot", "dot"],
  question: ["dot", "big"],
  error: ["line", "line"],
  finished: ["happy", "happy"],
  ratelimit: ["line", "line"],
  sleeping: ["sleepy", "sleepy"],
  dizzy: ["spiral", "spiral"],
  greeting: ["happy", "happy"],
  love: ["heart", "heart"],
  surprised: ["big", "big"],
  proud: ["star", "star"],
  wink: ["dot", "happy"],
  yawn: ["sleepy", "sleepy"],
  annoyed: ["annoyedL", "annoyedR"],
  upload: ["dot", "dot"],
  dancing: ["happy", "happy"],
};

function Eye({ kind, x, y = EY }: { kind: EyeKind; x: number; y?: number }) {
  const s = { stroke: INK, strokeWidth: 2.7, strokeLinecap: "round" as const, fill: "none" };
  switch (kind) {
    case "dot":
      return <ellipse className="m-eye" cx={x} cy={y} rx={4.1} ry={4.7} fill={INK} />;
    case "big":
      return (
        <g className="m-eye">
          <ellipse cx={x} cy={y} rx={4.9} ry={5.7} fill={INK} />
          <circle cx={x + 1.6} cy={y - 2} r={1.3} fill="#fff" />
        </g>
      );
    case "happy":
      return <path className="m-eye" d={`M${x - 5.5} ${y + 2} Q${x} ${y - 6} ${x + 5.5} ${y + 2}`} {...s} />;
    case "sleepy":
      return <path className="m-eye" d={`M${x - 5.5} ${y - 1.5} Q${x} ${y + 4.5} ${x + 5.5} ${y - 1.5}`} {...s} />;
    case "line":
      return <path className="m-eye" d={`M${x - 4.8} ${y} L${x + 4.8} ${y}`} {...s} />;
    case "annoyedL":
      return <path className="m-eye" d={`M${x - 5} ${y - 1.5} L${x + 4.5} ${y + 1}`} {...s} />;
    case "annoyedR":
      return <path className="m-eye" d={`M${x - 4.5} ${y + 1} L${x + 5} ${y - 1.5}`} {...s} />;
    case "spiral":
      return (
        <g className="m-eye m-spin">
          <path
            d={`M${x} ${y} m-0.4 0 a0.8 0.8 0 1 1 1.6 0 a1.9 1.9 0 1 1 -3.8 0 a3 3 0 1 1 6 0 a4.2 4.2 0 1 1 -8.4 0`}
            stroke={INK}
            strokeWidth={1.5}
            strokeLinecap="round"
            fill="none"
          />
        </g>
      );
    case "heart":
      return (
        <path
          className="m-eye m-beat"
          d={`M${x} ${y + 4.5} C${x - 7} ${y - 0.5} ${x - 5} ${y - 6} ${x} ${y - 2.6} C${x + 5} ${y - 6} ${x + 7} ${y - 0.5} ${x} ${y + 4.5} Z`}
          fill="#ec4f73"
        />
      );
    case "star":
      return <path className="m-eye m-twirl" d={starPath(x, y, 5.6, 2.5)} fill="#f4c542" stroke="#e0a91f" strokeWidth={0.6} strokeLinejoin="round" />;
  }
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

function Sparkle({ x, y, r, delay, color = "#fff" }: { x: number; y: number; r: number; delay: number; color?: string }) {
  return <path className="m-twinkle" style={{ animationDelay: `${delay}s` }} d={`M${x} ${y - r} Q${x} ${y} ${x + r} ${y} Q${x} ${y} ${x} ${y + r} Q${x} ${y} ${x - r} ${y} Q${x} ${y} ${x} ${y - r} Z`} fill={color} />;
}

function Badge({ mood }: { mood: Mood }) {
  const b = BADGE[mood];
  if (!b) return null;
  if (b.kind === "dots")
    return (
      <g className="m-badge">
        <rect x={14} y={44} width={19} height={9} rx={4.5} fill={b.color} />
        {[18.5, 23.5, 28.5].map((cx, i) => (
          <circle key={cx} className="m-typing" style={{ animationDelay: `${i * 0.18}s` }} cx={cx} cy={48.5} r={1.35} fill="#fff" />
        ))}
      </g>
    );
  return (
    <g className="m-badge">
      <circle cx={24} cy={50} r={b.kind === "dot" ? 4 : 5.2} fill={b.color} stroke="rgba(255,255,255,.9)" strokeWidth={1.2} />
      {b.kind !== "dot" && (
        <text x={24} y={52.6} textAnchor="middle" fontSize={7.4} fontWeight={800} fill="#fff" fontFamily="ui-sans-serif, system-ui, sans-serif">
          {b.kind}
        </text>
      )}
    </g>
  );
}

/* ---------------- Roupinhas ---------------- */

function Hat({ id, u }: { id: string; u: string }) {
  switch (id) {
    case "beanie":
      return (
        <g>
          <path d="M27 60 C26 37 41 27 60 27 C79 27 94 37 93 60 Z" fill={`url(#${u}-blue)`} />
          {[38, 46, 54, 62, 70, 78].map((x) => (
            <path key={x} d={`M${x + 1} 31 Q${x + 2 + (x - 60) * 0.1} 45 ${x + 1 + (x - 60) * 0.15} 56`} stroke="rgba(255,255,255,.14)" strokeWidth={1.6} fill="none" />
          ))}
          <rect x={23} y={52} width={74} height={11} rx={5.5} fill="#3456c4" />
          {Array.from({ length: 12 }, (_, i) => (
            <line key={i} x1={28 + i * 5.8} y1={54} x2={28 + i * 5.8} y2={61} stroke="rgba(0,0,0,.16)" strokeWidth={1.4} strokeLinecap="round" />
          ))}
          <circle cx={60} cy={25} r={8} fill={`url(#${u}-white)`} />
        </g>
      );
    case "santa":
      return (
        <g>
          <path d="M28 58 C29 36 44 25 63 26 C79 27 91 36 99 52 C94 50 89 50 86 52 C83 46 79 42 77 43 C82 48 86 53 88 58 Z" fill={`url(#${u}-red)`} />
          <circle cx={99} cy={54} r={6.5} fill={`url(#${u}-white)`} />
          <rect x={22} y={51} width={76} height={12} rx={6} fill={`url(#${u}-white)`} />
        </g>
      );
    case "party":
      return (
        <g transform="rotate(10 60 54)">
          <path d="M45 56 L60 16 L75 56 Z" fill={`url(#${u}-pink)`} />
          {[
            [56, 30],
            [64, 38],
            [54, 45],
            [66, 50],
            [60, 23],
          ].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r={1.6} fill="#fff6b0" />
          ))}
          <path d="M45 56 Q60 60 75 56" stroke="#d94f9c" strokeWidth={2} fill="none" />
          <circle cx={60} cy={15} r={4} fill="#ffd34d" />
        </g>
      );
    case "crown":
      return (
        <g>
          <path d="M31 60 L29 36 L42 47 L51 31 L60 45 L69 31 L78 47 L91 36 L89 60 Z" fill={`url(#${u}-gold)`} stroke="#c98a12" strokeWidth={1} strokeLinejoin="round" />
          <rect x={30} y={53} width={60} height={8} rx={2} fill="#e6a623" />
          {[29, 51, 69, 91].map((x, i) => (
            <circle key={x} cx={x} cy={i === 0 || i === 3 ? 36 : 31} r={2.4} fill="#fff2b8" />
          ))}
          <circle cx={45} cy={57} r={2.2} fill="#4f8cf0" />
          <circle cx={60} cy={57} r={2.6} fill="#ef4b5f" />
          <circle cx={75} cy={57} r={2.2} fill="#2fbf7f" />
        </g>
      );
    case "witch":
      return (
        <g>
          <path d="M36 57 C41 42 46 30 54 20 C59 13 70 7 84 9 C75 13 68 20 67 29 C69 39 76 48 84 57 Z" fill={`url(#${u}-purple)`} />
          <path d="M39 50 C52 46 70 46 81 50 L83 56 C70 52 50 52 37 56 Z" fill="#f0892b" />
          <rect x={55.5} y={47} width={8} height={7} rx={1.2} fill="none" stroke="#ffd34d" strokeWidth={1.6} />
          <ellipse cx={60} cy={57} rx={46} ry={7.5} fill="#5b2fa8" />
          <ellipse cx={60} cy={55.8} rx={40} ry={4.6} fill="#7240c7" />
        </g>
      );
    case "bow":
      return (
        <g transform="rotate(-12 82 52)">
          <path d="M82 52 C74 42 65 45 67 52 C65 59 74 62 82 52 Z" fill={`url(#${u}-pink)`} />
          <path d="M82 52 C90 42 99 45 97 52 C99 59 90 62 82 52 Z" fill={`url(#${u}-pink)`} />
          <circle cx={82} cy={52} r={3.4} fill="#e2589f" />
        </g>
      );
  }
  return null;
}

function EyeWear({ id }: { id: string }) {
  if (id === "sunglasses")
    return (
      <g>
        <path d="M19 76 L34 77 M86 77 L101 76" stroke="#111" strokeWidth={2} strokeLinecap="round" />
        <path d="M54 78 Q60 75 66 78" stroke="#111" strokeWidth={2.4} fill="none" strokeLinecap="round" />
        <rect x={34} y={72} width={21} height={14} rx={6} fill="#141418" />
        <rect x={65} y={72} width={21} height={14} rx={6} fill="#141418" />
        <path d="M38 76 L43 76 M69 76 L74 76" stroke="rgba(255,255,255,.35)" strokeWidth={1.8} strokeLinecap="round" />
      </g>
    );
  if (id === "glasses")
    return (
      <g fill="none" stroke="#9a6b2f" strokeWidth={1.9}>
        <path d="M19 77 L36.5 79 M83.5 79 L101 77" strokeLinecap="round" />
        <path d="M53 79 Q60 75.5 67 79" strokeLinecap="round" />
        <circle cx={LX} cy={EY} r={8.5} fill="rgba(255,255,255,.18)" />
        <circle cx={RX} cy={EY} r={8.5} fill="rgba(255,255,255,.18)" />
      </g>
    );
  return null;
}

function Neck({ id, u }: { id: string; u: string }) {
  if (id !== "scarf") return null;
  return (
    <g>
      <path d="M78 96 L76 116 Q80 119 86 116 L88 95 Z" fill={`url(#${u}-stripes)`} stroke="#b9202f" strokeWidth={0.6} />
      <path d="M19.5 86 C34 98 86 98 100.5 86 L100 96 C86 108 34 108 20 96 Z" fill={`url(#${u}-stripes)`} stroke="#b9202f" strokeWidth={0.6} />
      <path d="M76 116 L75 120 M79 117 L78.5 121 M82 117 L82 121 M85 116 L85.5 120" stroke="#e23a48" strokeWidth={1.4} strokeLinecap="round" />
    </g>
  );
}

function Pumpkin({ u }: { u: string }) {
  return (
    <g>
      <ellipse cx={33} cy={78} rx={15} ry={24} fill={`url(#${u}-orange)`} />
      <ellipse cx={87} cy={78} rx={15} ry={24} fill={`url(#${u}-orange)`} />
      <ellipse cx={46} cy={78} rx={20} ry={27} fill={`url(#${u}-orange)`} stroke="#d4561a" strokeWidth={0.8} />
      <ellipse cx={74} cy={78} rx={20} ry={27} fill={`url(#${u}-orange)`} stroke="#d4561a" strokeWidth={0.8} />
      <ellipse cx={60} cy={78} rx={17} ry={28} fill={`url(#${u}-orange)`} stroke="#d4561a" strokeWidth={0.8} />
      <ellipse cx={52} cy={60} rx={8} ry={3} fill="rgba(255,255,255,.35)" />
      <path d="M58 52 C57 46 58 42 61 39 L65 41 C62 44 62 48 63 52 Z" fill="#4c8a2e" />
      <path d="M64 44 C70 38 78 40 80 44 C74 47 69 46 64 44 Z" fill="#6cb33f" />
    </g>
  );
}

function Defs({ u, tint }: { u: string; tint: string }) {
  return (
    <defs>
      <radialGradient id={`${u}-body`} cx="0.4" cy="0.22" r="0.95">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.42" stopColor="#f4f4f6" />
        <stop offset="0.78" stopColor="#dcdce2" />
        <stop offset="1" stopColor="#c3c3cc" />
      </radialGradient>
      <radialGradient id={`${u}-tint`} cx="0.45" cy="0.3" r="0.9">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="0.55" stopColor={tint} className="m-tint-stop" />
        <stop offset="1" stopColor={tint} className="m-tint-stop" />
      </radialGradient>
      <linearGradient id={`${u}-under`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0.55" stopColor="#000" stopOpacity="0" />
        <stop offset="1" stopColor="#000" stopOpacity="0.1" />
      </linearGradient>
      <radialGradient id={`${u}-white`} cx="0.38" cy="0.3" r="0.8">
        <stop offset="0" stopColor="#ffffff" />
        <stop offset="1" stopColor="#d7d7de" />
      </radialGradient>
      <linearGradient id={`${u}-blue`} x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stopColor="#6f9cf7" />
        <stop offset="1" stopColor="#3b5fd0" />
      </linearGradient>
      <linearGradient id={`${u}-red`} x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0" stopColor="#f2474f" />
        <stop offset="1" stopColor="#b8172a" />
      </linearGradient>
      <linearGradient id={`${u}-pink`} x1="0" y1="0" x2="0.3" y2="1">
        <stop offset="0" stopColor="#ffb3dc" />
        <stop offset="1" stopColor="#ec69b3" />
      </linearGradient>
      <linearGradient id={`${u}-gold`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffe68f" />
        <stop offset="1" stopColor="#efb02e" />
      </linearGradient>
      <linearGradient id={`${u}-purple`} x1="0" y1="0" x2="0.4" y2="1">
        <stop offset="0" stopColor="#9b6af0" />
        <stop offset="1" stopColor="#5a2aa6" />
      </linearGradient>
      <radialGradient id={`${u}-orange`} cx="0.4" cy="0.3" r="0.9">
        <stop offset="0" stopColor="#ffab5c" />
        <stop offset="1" stopColor="#e9651f" />
      </radialGradient>
      <pattern id={`${u}-stripes`} width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(80)">
        <rect width="9" height="9" fill="#e23a48" />
        <rect width="3.4" height="9" fill="#fff4f4" />
      </pattern>
      <filter id={`${u}-blur`} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="2.2" />
      </filter>
      <filter id={`${u}-soft`} x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur stdDeviation="1.4" />
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
        const dy = e.clientY - (r.top + r.height * 0.66);
        const d = Math.hypot(dx, dy) || 1;
        const k = Math.min(1, d / 260);
        g.style.transform = `translate(${((dx / d) * 3.2 * k).toFixed(2)}px, ${((dy / d) * 2.4 * k).toFixed(2)}px)`;
      });
    };
    window.addEventListener("pointermove", onMove);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
    };
  }, [follow]);

  const pumpkin = outfit.costume === "pumpkin";
  const tint = pumpkin ? "#ffffff" : (TINT[mood] ?? "#ffffff");
  const [le, re] = EYES[mood];
  const nubs = mood === "greeting" || mood === "dancing";
  const eyeLift = mood === "thinking" ? { transform: "translate(2px,-2.5px)" } : undefined;

  return (
    <svg
      ref={svg}
      className={`mochi m-${mood} ${still ? "m-still" : ""} ${className ?? ""}`}
      width={size}
      height={crop ? Math.round((size * 80) / 104) : size}
      viewBox={crop ? "8 38 104 80" : "0 0 120 120"}
      role="img"
      aria-label={title ?? "Mochi"}
      style={style}
    >
      <Defs u={u} tint={tint} />
      <ellipse className="m-shadow" cx={60} cy={113} rx={30} ry={4} fill="#000" opacity={0.22} filter={`url(#${u}-blur)`} />
      <g className="m-move">
        <g className="m-pop" key={mood}>
          {mood === "upload" && (
            <g className="m-card">
              <rect x={52} y={26} width={16} height={13} rx={2.5} fill="#fff" stroke="#d8d8de" strokeWidth={0.8} />
              <rect x={56} y={31} width={8} height={2.6} rx={1.3} fill="#ef4b5f" />
            </g>
          )}
          {nubs && <circle className="m-nub m-nub-l" cx={18} cy={96} r={7.5} fill={`url(#${u}-white)`} />}
          {nubs && <circle className="m-nub m-nub-r" cx={103} cy={66} r={7.5} fill={`url(#${u}-white)`} />}

          <g className="m-squish">
            {pumpkin ? (
              <Pumpkin u={u} />
            ) : (
              <>
                <path d={BODY} fill={`url(#${u}-body)`} />
                <path d={BODY} fill={`url(#${u}-tint)`} style={{ mixBlendMode: "multiply" }} />
                <path d={BODY} fill={`url(#${u}-under)`} />
                <ellipse cx={50} cy={57} rx={19} ry={5} fill="#fff" opacity={0.75} filter={`url(#${u}-soft)`} />
              </>
            )}

            {outfit.neck && !pumpkin && <Neck id={outfit.neck} u={u} />}

            <g className="m-look" ref={look}>
              <g className="m-eyes" style={eyeLift}>
                <g className="m-blink">
                  <Eye kind={le} x={LX} />
                  <Eye kind={re} x={RX} />
                </g>
              </g>
              {(mood === "love" || mood === "proud" || mood === "greeting") && !outfit.eyes && (
                <g opacity={0.5}>
                  <ellipse cx={37} cy={89} rx={5} ry={2.6} fill="#ff8fa8" />
                  <ellipse cx={83} cy={89} rx={5} ry={2.6} fill="#ff8fa8" />
                </g>
              )}
              {mood === "yawn" && <ellipse className="m-yawn" cx={60} cy={92} rx={3} ry={3.8} fill="#3a2a2e" />}
              {mood === "surprised" && <ellipse cx={60} cy={93} rx={2.2} ry={2.6} fill={INK} />}
              {outfit.eyes && <EyeWear id={outfit.eyes} />}
            </g>

            {outfit.head && <Hat id={outfit.head} u={u} />}
          </g>

          <Badge mood={mood} />

          {(mood === "finished" || mood === "proud") && (
            <g>
              <Sparkle x={50} y={36} r={3.4} delay={0} color={mood === "proud" ? "#f4c542" : "#ffffff"} />
              <Sparkle x={60} y={29} r={2.4} delay={0.4} color={mood === "proud" ? "#f4c542" : "#ffffff"} />
              <Sparkle x={70} y={37} r={2} delay={0.8} color={mood === "proud" ? "#f4c542" : "#ffffff"} />
            </g>
          )}
          {(mood === "sleeping" || mood === "yawn") && (
            <g className="m-zzz" fill="currentColor" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={700}>
              <text x={92} y={44} fontSize={8}>z</text>
              <text x={99} y={34} fontSize={10}>z</text>
              {mood === "sleeping" && <text x={106} y={22} fontSize={12}>z</text>}
            </g>
          )}
          {mood === "love" && (
            <g>
              {[
                [26, 46, 0],
                [95, 52, 0.7],
                [84, 34, 1.3],
              ].map(([x, y, d]) => (
                <path
                  key={`${x}`}
                  className="m-float-heart"
                  style={{ animationDelay: `${d}s` }}
                  d={`M${x} ${y + 3} C${x - 5} ${y - 0.5} ${x - 3.5} ${y - 4.5} ${x} ${y - 2} C${x + 3.5} ${y - 4.5} ${x + 5} ${y - 0.5} ${x} ${y + 3} Z`}
                  fill="#ec4f73"
                />
              ))}
            </g>
          )}
        </g>
      </g>
    </svg>
  );
}

/** Mochi com um fundo de vidro escuro, como um ícone. */
export function MochiTile({ children, active, onClick, label }: { children: ReactNode; active?: boolean; onClick?: () => void; label: string }) {
  return (
    <button type="button" className={`mochi-tile ${active ? "active" : ""}`} onClick={onClick} aria-pressed={active}>
      <span className="mochi-tile-art">{children}</span>
      <span className="mochi-tile-label">{label}</span>
    </button>
  );
}

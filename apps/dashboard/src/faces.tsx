import { useId } from "react";

/**
 * Carinhas dos agentes: pessoinhas desenhadas a traço (preto e branco) dentro de um círculo pastel.
 * O servidor guarda só a combinação (faceFor), então cada agente novo ganha a sua:
 * color = fundo pastel, eyes = olhar, mouth = boca, extra = cabelo/acessório
 * (crown coque, antenna cacheado, cap boné, bow cabelo comprido, headset fone, leaf espetado, none repartido).
 */
export interface Face {
  color: number;
  eyes: string;
  mouth: string;
  extra: string;
}

/** Fundos pastel, um tom claro de cada cor da paleta. */
export const FACE_COLORS = ["#FFE6D3", "#FFE0E3", "#FBE3F0", "#F3E2F8", "#EAE2FC", "#E0E5FD", "#DCEBFB", "#D9F1EC"];
const INK = "#111111";
const SKIN = "#FFFFFF";
const line = { stroke: INK, strokeWidth: 2.4, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

function HairBack({ kind }: { kind: string }) {
  if (kind === "antenna")
    return (
      <g fill={INK}>
        {[[35, 31, 8.5], [43, 22, 9], [55, 21, 9.5], [64, 29, 8.5], [67, 40, 6.5], [33, 41, 6.5]].map(([x, y, r]) => <circle key={`${x}-${y}`} cx={x} cy={y} r={r} />)}
      </g>
    );
  if (kind === "bow") return <path d="M31 42 C30 25 40 18 50 18 C61 18 70 25 69 42 L71 69 Q62 73 57 66 L43 66 Q38 73 29 69 Z" fill={INK} />;
  if (kind === "crown") return <circle cx={48} cy={19} r={5.5} fill={INK} />;
  return null;
}

function HairFront({ kind }: { kind: string }) {
  switch (kind) {
    case "crown":
      return <path d="M33 44 C31 29 40 22 50 22 C60 22 67 27 67 37 C61 36 55 33 52 29 C48 34 41 36 37 45 Z" fill={INK} />;
    case "antenna":
      return <path d="M34 43 C35 30 45 25 54 26 C61 27 67 32 66 41 C60 34 52 33 46 35 C41 37 37 39 34 43 Z" fill={INK} />;
    case "cap":
      return (
        <>
          <path d="M33 40 C33 27 41 21 50 21 C59 21 67 27 67 40 Z" fill={INK} />
          <path d="M52 37 L77 38 Q79 40.5 77 43 L53 41 Z" fill={INK} />
        </>
      );
    case "bow":
      return <path d="M34 43 C34 29 42 23 50 23 C58 23 66 29 66 43 C61 35 55 31 50 31 C46 34 40 37 34 43 Z" fill={INK} />;
    case "headset":
      return (
        <>
          <path d="M34 41 C33 28 41 22 51 22 C60 22 67 28 66 39 C62 33 56 30 50 30 C46 34 40 37 34 41 Z" fill={INK} />
          <path d="M31 46 C31 19 69 19 69 46" fill="none" {...line} strokeWidth={3} />
          <rect x={27.5} y={41} width={7} height={11} rx={3.5} fill={INK} />
          <rect x={65.5} y={41} width={7} height={11} rx={3.5} fill={INK} />
          <path d="M31 51 Q33 60 43 59" fill="none" {...line} strokeWidth={2} />
        </>
      );
    case "leaf":
      return <path d="M34 41 L35 28 L40 31 L42 21 L47 27 L51 19 L54 26 L59 21 L60 28 L66 26 L66 40 C60 33 50 31 43 34 C39 35 36 38 34 41 Z" fill={INK} />;
    default:
      return <path d="M34 42 C33 28 41 22 51 22 C60 22 67 28 66 40 C62 33 56 30 50 30 C46 34 40 37 34 42 Z" fill={INK} />;
  }
}

function Eyes({ kind }: { kind: string }) {
  const L = 44.5;
  const R = 56.5;
  const Y = 46;
  const dot = (x: number) => <ellipse key={x} cx={x} cy={Y} rx={1.6} ry={2.2} fill={INK} />;
  const brow = (x: number, tilt = 0) => <path key={`b${x}`} d={`M${x - 3} ${Y - 5 + tilt} q3 -1.8 6 ${-tilt}`} fill="none" {...line} strokeWidth={2} />;
  switch (kind) {
    case "happy":
      return <>{[L, R].map((x) => <path key={x} d={`M${x - 2.6} ${Y + 0.8} q2.6 -3.4 5.2 0`} fill="none" {...line} strokeWidth={2} />)}{brow(L)}{brow(R)}</>;
    case "wide":
      return <>{[L, R].map((x) => <g key={x}><circle cx={x} cy={Y} r={2.6} fill={INK} /><circle cx={x + 0.8} cy={Y - 0.9} r={0.8} fill="#fff" /></g>)}{brow(L, -1)}{brow(R, 1)}</>;
    case "wink":
      return <>{dot(L)}<path d={`M${R - 2.6} ${Y} q2.6 -2.6 5.2 0`} fill="none" {...line} strokeWidth={2} />{brow(L)}{brow(R)}</>;
    case "glasses":
      return (
        <>
          <circle cx={L} cy={Y} r={4.2} fill="none" {...line} strokeWidth={2} />
          <circle cx={R} cy={Y} r={4.2} fill="none" {...line} strokeWidth={2} />
          <path d={`M${L + 4.2} ${Y} h${R - L - 8.4}`} {...line} strokeWidth={2} />
          {dot(L)}
          {dot(R)}
        </>
      );
    case "sleepy":
      return (
        <>
          {[L, R].map((x) => (
            <g key={x}>
              <path d={`M${x - 3} ${Y - 1.2} h6`} {...line} strokeWidth={2.2} />
              <ellipse cx={x} cy={Y + 0.6} rx={1.3} ry={1.4} fill={INK} />
            </g>
          ))}
          {brow(L, 1)}
          {brow(R, -1)}
        </>
      );
    default:
      return <>{dot(L)}{dot(R)}{brow(L, 0.5)}{brow(R, -0.5)}</>;
  }
}

function Mouth({ kind }: { kind: string }) {
  switch (kind) {
    case "open":
      return <path d="M46.5 56 q4 5 8 0 z" fill={INK} {...line} strokeWidth={1.6} />;
    case "cat":
      return <path d="M45.5 56 q2.5 2.5 5 0 q2.5 2.5 5 0" fill="none" {...line} strokeWidth={2} />;
    case "grin":
      return <path d="M46 55.5 h9 q0 4.5 -4.5 4.5 q-4.5 0 -4.5 -4.5 z" fill="#fff" {...line} strokeWidth={1.8} />;
    case "o":
      return <ellipse cx={50.5} cy={57} rx={1.5} ry={1.9} fill={INK} />;
    case "flat":
      return <path d="M47.5 57 q3 1 6 -0.5" fill="none" {...line} strokeWidth={2} />;
    default:
      return <path d="M46.5 55.5 q4 3.5 8 0" fill="none" {...line} strokeWidth={2} />;
  }
}

export function AgentFace({ face, size = 40, title }: { face?: Face | null; size?: number; title?: string }) {
  const clip = useId().replace(/:/g, "");
  const f = face ?? { color: 5, eyes: "dot", mouth: "smile", extra: "none" };
  const idx = ((f.color % FACE_COLORS.length) + FACE_COLORS.length) % FACE_COLORS.length;
  const darkShirt = idx % 2 === 0;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={title ?? "agente"} className="agent-face">
      <defs>
        <clipPath id={clip}>
          <circle cx={50} cy={50} r={50} />
        </clipPath>
      </defs>
      <circle cx={50} cy={50} r={50} fill={FACE_COLORS[idx]} />
      <g clipPath={`url(#${clip})`}>
        <g transform="translate(50 62) scale(1.2) translate(-50 -56)">
        <HairBack kind={f.extra} />
        {/* corpo: jaqueta aberta e camiseta */}
        <path d="M12 106 C14 88 22 79 38 75 L62 75 C78 79 86 88 88 106 Z" fill={SKIN} {...line} />
        <path d="M41 75 L44 106 L56 106 L59 75 Z" fill={darkShirt ? INK : SKIN} {...line} />
        {darkShirt && <path d="M48 86 L53 90 L48.5 91 L53 96" fill="none" stroke="#fff" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />}
        <path d="M38 75 L33 83 L39 97 M62 75 L67 83 L61 97" fill="none" {...line} />
        <path d="M44 64 L44 76 Q50 79 56 76 L56 64" fill={SKIN} {...line} />
        {/* orelha e cabeça */}
        <ellipse cx={34.5} cy={48} rx={3.4} ry={5.2} fill={SKIN} {...line} />
        <path d="M34 45 C34 30 42 24 50 24 C59 24 66 30 66 45 C66 57 60 66 50 66 C41 66 34 58 34 45 Z" fill={SKIN} {...line} />
        <HairFront kind={f.extra} />
        <Eyes kind={f.eyes} />
        <path d="M49.5 50 q3 -1.2 3.2 1.2 q-0.6 2 -4 1.2" fill="none" {...line} strokeWidth={1.8} />
        <Mouth kind={f.mouth} />
        </g>
      </g>
    </svg>
  );
}

/** Time fixo (espelho de apps/server/src/agent/team.ts) para telas que só têm o id do agente. */
export const CORE_FACES: Record<string, { persona: string; face: Face }> = {
  cto: { persona: "Téo", face: { color: 4, eyes: "happy", mouth: "smile", extra: "crown" } },
  pesquisador: { persona: "Pipo", face: { color: 6, eyes: "glasses", mouth: "open", extra: "antenna" } },
  agenda: { persona: "Lia", face: { color: 2, eyes: "happy", mouth: "smile", extra: "bow" } },
  financeiro: { persona: "Nico", face: { color: 7, eyes: "dot", mouth: "grin", extra: "cap" } },
  comunicacao: { persona: "Bia", face: { color: 1, eyes: "wink", mouth: "cat", extra: "headset" } },
  produtividade: { persona: "Duda", face: { color: 0, eyes: "wide", mouth: "smile", extra: "leaf" } },
};

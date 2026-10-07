/**
 * Carinhas dos agentes: um robozinho de corpo colorido (paleta do Planejai) com visor branco,
 * olhos, boca e um acessório. Tudo SVG, sem imagem. Os agentes novos ganham uma combinação
 * sorteada pelo servidor (faceFor), então cada um tem a sua.
 */
export interface Face {
  color: number;
  eyes: string;
  mouth: string;
  extra: string;
}

export const FACE_COLORS = ["#FF7A1A", "#FF4458", "#E23382", "#B830C8", "#8B2BE2", "#5B45E8", "#2F7BEA", "#16A3A3"];
const INK = "#18181B";

function Eyes({ kind }: { kind: string }) {
  const L = 25;
  const R = 39;
  const Y = 37;
  const dot = (x: number) => (
    <g key={x}>
      <circle cx={x} cy={Y} r={3.4} fill={INK} />
      <circle cx={x + 1.1} cy={Y - 1.2} r={1} fill="#fff" />
    </g>
  );
  const happy = (x: number) => <path key={x} d={`M${x - 3.5} ${Y + 1} q3.5 -4.5 7 0`} stroke={INK} strokeWidth={2.4} fill="none" strokeLinecap="round" />;
  switch (kind) {
    case "happy":
      return <>{happy(L)}{happy(R)}</>;
    case "wide":
      return (
        <>
          {[L, R].map((x) => (
            <g key={x}>
              <circle cx={x} cy={Y} r={4.6} fill={INK} />
              <circle cx={x + 1.4} cy={Y - 1.6} r={1.6} fill="#fff" />
              <circle cx={x - 1.4} cy={Y + 1.6} r={0.7} fill="#fff" />
            </g>
          ))}
        </>
      );
    case "wink":
      return <>{dot(L)}{happy(R)}</>;
    case "glasses":
      return (
        <>
          <circle cx={L} cy={Y} r={5.6} stroke={INK} strokeWidth={2} fill="none" />
          <circle cx={R} cy={Y} r={5.6} stroke={INK} strokeWidth={2} fill="none" />
          <path d={`M${L + 5.6} ${Y} h${R - L - 11.2}`} stroke={INK} strokeWidth={2} />
          <circle cx={L} cy={Y} r={2.2} fill={INK} />
          <circle cx={R} cy={Y} r={2.2} fill={INK} />
        </>
      );
    case "sleepy":
      return (
        <>
          {[L, R].map((x) => (
            <path key={x} d={`M${x - 3.5} ${Y - 0.5} q3.5 3.5 7 0`} stroke={INK} strokeWidth={2.4} fill="none" strokeLinecap="round" />
          ))}
        </>
      );
    default:
      return <>{dot(L)}{dot(R)}</>;
  }
}

function Mouth({ kind }: { kind: string }) {
  const p = { stroke: INK, strokeWidth: 2.2, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (kind) {
    case "open":
      return <path d="M28 44 q4 6.5 8 0 z" fill={INK} stroke={INK} strokeWidth={1.4} strokeLinejoin="round" />;
    case "cat":
      return <path d="M27 44 q2.5 3 5 0 q2.5 3 5 0" {...p} />;
    case "grin":
      return <path d="M27 43.5 h10 q0 5.5 -5 5.5 q-5 0 -5 -5.5 z" fill="#fff" stroke={INK} strokeWidth={2} strokeLinejoin="round" />;
    case "o":
      return <ellipse cx={32} cy={45.5} rx={2.2} ry={2.6} fill={INK} />;
    case "flat":
      return <path d="M28.5 45.5 h7" {...p} />;
    default:
      return <path d="M27.5 44 q4.5 4.5 9 0" {...p} />;
  }
}

function Extra({ kind, color }: { kind: string; color: string }) {
  switch (kind) {
    case "antenna":
      return (
        <>
          <path d="M32 18 v-9" stroke={color} strokeWidth={3} strokeLinecap="round" />
          <circle cx={32} cy={7} r={4} fill={color} />
        </>
      );
    case "cap":
      return (
        <>
          <path d="M12 26 C12 13 21 9 32 9 C43 9 52 13 52 26 Z" fill={INK} />
          <path d="M42 23 h17 a2.5 2.5 0 0 1 0 5 h-17 z" fill={INK} />
          <circle cx={32} cy={9.5} r={2.2} fill={color} />
        </>
      );
    case "bow":
      return (
        <g transform="translate(47 15) rotate(18)">
          <path d="M0 0 L-8 -5.5 V5.5 Z M0 0 L8 -5.5 V5.5 Z" fill="#FF4458" stroke="#fff" strokeWidth={1.4} strokeLinejoin="round" />
          <circle r={2.6} fill="#FF4458" stroke="#fff" strokeWidth={1.4} />
        </g>
      );
    case "headset":
      return (
        <>
          <path d="M8 36 a24 24 0 0 1 48 0" stroke={INK} strokeWidth={3} fill="none" strokeLinecap="round" />
          <rect x={3} y={31} width={8} height={14} rx={4} fill={INK} />
          <rect x={53} y={31} width={8} height={14} rx={4} fill={INK} />
          <path d="M7 44 q1 9 13 8" stroke={INK} strokeWidth={2} fill="none" strokeLinecap="round" />
          <circle cx={21} cy={52} r={2.2} fill={INK} />
        </>
      );
    case "leaf":
      return (
        <>
          <path d="M32 18 v-7" stroke="#16A3A3" strokeWidth={2.6} strokeLinecap="round" />
          <path d="M32 12 C28 4 20 4 18 6 C20 12 27 13 32 12 Z" fill="#16A3A3" />
          <path d="M32 11 C35 5 41 4 44 6 C42 11 37 12 32 11 Z" fill="#2FC4A8" />
        </>
      );
    case "crown":
      return <path d="M19 19 L21 7 L27 13 L32 5 L37 13 L43 7 L45 19 Z" fill="#FFB524" stroke="#fff" strokeWidth={1.4} strokeLinejoin="round" />;
    default:
      return null;
  }
}

/** Acessórios que ficam na frente do corpo (o resto fica atrás, saindo pelo topo). */
const FRONT = new Set(["cap", "headset", "bow"]);

export function AgentFace({ face, size = 40, title }: { face?: Face | null; size?: number; title?: string }) {
  const f = face ?? { color: 4, eyes: "dot", mouth: "smile", extra: "none" };
  const color = FACE_COLORS[((f.color % FACE_COLORS.length) + FACE_COLORS.length) % FACE_COLORS.length]!;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-label={title ?? "agente"} className="agent-face">
      {!FRONT.has(f.extra) && <Extra kind={f.extra} color={color} />}
      <rect x={9} y={18} width={46} height={42} rx={17} fill={color} />
      <rect x={14.5} y={27} width={35} height={25} rx={12.5} fill="#fff" />
      <circle cx={19.5} cy={45} r={2.6} fill={color} opacity={0.35} />
      <circle cx={44.5} cy={45} r={2.6} fill={color} opacity={0.35} />
      <Eyes kind={f.eyes} />
      <Mouth kind={f.mouth} />
      {FRONT.has(f.extra) && <Extra kind={f.extra} color={color} />}
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

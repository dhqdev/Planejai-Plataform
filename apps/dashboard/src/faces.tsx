import { Mochi, type Mood, type Outfit } from "./mochi/Mochi";

/**
 * Carinhas dos agentes: todo agente é o Mochi, cada um com a sua roupinha, dentro de um círculo pastel.
 * O servidor guarda só a combinação (faceFor), e daqui ela vira roupa e jeito de olhar,
 * então agente novo já nasce com o mascote vestido de um jeito só dele:
 * color = fundo pastel e o que vai no pescoço, extra = o que vai na cabeça, eyes = óculos e humor.
 */
export interface Face {
  color: number;
  eyes: string;
  mouth: string;
  extra: string;
}

/** Fundos pastel, um tom claro de cada cor da paleta. */
export const FACE_COLORS = ["#FFE6D3", "#FFE0E3", "#FBE3F0", "#F3E2F8", "#EAE2FC", "#E0E5FD", "#DCEBFB", "#D9F1EC"];

const HEAD: Record<string, string | undefined> = { crown: "crown", cap: "cap", bow: "bow", headset: "headphones", leaf: "flower", antenna: "party", none: "beanie" };
const NECK = [undefined, "bowtie", "scarf"];
const MOOD: Record<string, Mood> = { happy: "happy", wink: "wink", wide: "curious", sleepy: "sleepy" };

const DEFAULT: Face = { color: 5, eyes: "dot", mouth: "smile", extra: "none" };
const index = (n: number, len: number) => ((n % len) + len) % len;

/** Roupinha do Mochi para esta combinação. */
export function outfitFor(face?: Face | null): Outfit {
  const f = face ?? DEFAULT;
  const out: Outfit = {};
  const head = HEAD[f.extra];
  if (head) out.head = head;
  if (f.eyes === "glasses") out.eyes = "glasses";
  // quem tem a boca de gatinho usa óculos escuros: mais um jeito de diferenciar sem mexer no servidor
  else if (f.mouth === "cat") out.eyes = "sunglasses";
  const neck = NECK[index(f.color, NECK.length)];
  if (neck) out.neck = neck;
  return out;
}

export function AgentFace({ face, size = 40, title }: { face?: Face | null; size?: number; title?: string }) {
  const f = face ?? DEFAULT;
  return (
    <span className="agent-face" role="img" aria-label={title ?? "agente"} style={{ width: size, height: size, background: FACE_COLORS[index(f.color, FACE_COLORS.length)] }}>
      {/* parado (sem seguir o mouse): há telas com dezenas deles */}
      <Mochi still mood={MOOD[f.eyes] ?? "idle"} outfit={outfitFor(f)} size={Math.round(size * 0.92)} title={title} />
    </span>
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

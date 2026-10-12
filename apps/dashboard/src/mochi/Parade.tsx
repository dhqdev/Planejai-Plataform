import type { CSSProperties } from "react";
import { Mochi, type Mood, type Outfit } from "./Mochi";

/**
 * Mochis do cadastro: um no palco, que troca de fantasia e de cara a cada etapa e entra pulando,
 * e alguns pequenos flutuando em volta, cada um vestido de um jeito. Só enfeite: nada aqui é clicável.
 */

export interface Look {
  outfit: Outfit;
  mood: Mood;
}

/** Um visual por etapa do cadastro e das perguntas de boas-vindas (vai repetindo se houver mais etapas). */
export const LOOKS: Look[] = [
  { outfit: { head: "party" }, mood: "greeting" },
  { outfit: { eyes: "glasses", neck: "bowtie" }, mood: "curious" },
  { outfit: { head: "cap", eyes: "sunglasses" }, mood: "wink" },
  { outfit: { head: "crown", neck: "scarf" }, mood: "happy" },
  { outfit: { head: "headphones" }, mood: "thinking" },
  { outfit: { head: "flower" }, mood: "laughing" },
  { outfit: { head: "witch" }, mood: "surprised" },
  { outfit: { head: "beanie", neck: "scarf" }, mood: "shy" },
  { outfit: { costume: "pumpkin" }, mood: "happy" },
  { outfit: { head: "bow", eyes: "glasses" }, mood: "wink" },
];

export const lookAt = (i: number) => LOOKS[((i % LOOKS.length) + LOOKS.length) % LOOKS.length]!;

/** O Mochi do palco. Mudou a etapa (key), ele sai do chão de novo com a fantasia nova. */
export function StageMochi({ step, look, mood, size = 120, say }: { step: string | number; look: Look; mood?: Mood; size?: number; say?: string }) {
  return (
    <div className="stage-mochi" key={step}>
      {say && <span className="stage-say">{say}</span>}
      <span className="stage-mochi-body">
        <Mochi size={size} outfit={look.outfit} mood={mood ?? look.mood} />
      </span>
    </div>
  );
}

/** Onde os pequenos ficam (em % da área) e com que atraso cada um começa a boiar. */
const SPOTS: { x: number; y: number; size: number; delay: number; look: Look }[] = [
  { x: 8, y: 12, size: 38, delay: 0, look: { outfit: { head: "santa" }, mood: "laughing" } },
  { x: 84, y: 8, size: 30, delay: 0.6, look: { outfit: { head: "witch" }, mood: "wink" } },
  { x: 90, y: 62, size: 42, delay: 1.1, look: { outfit: { costume: "pumpkin" }, mood: "happy" } },
  { x: 4, y: 74, size: 32, delay: 1.7, look: { outfit: { head: "headphones", eyes: "sunglasses" }, mood: "curious" } },
  { x: 62, y: 88, size: 28, delay: 2.2, look: { outfit: { head: "flower" }, mood: "shy" } },
  { x: 30, y: 4, size: 26, delay: 2.8, look: { outfit: { head: "crown" }, mood: "surprised" } },
];

/** No celular, só nas faixas de cima e de baixo, para não passar por cima do formulário. */
const EDGES: typeof SPOTS = [
  { ...SPOTS[0]!, x: 7, y: 5 },
  { ...SPOTS[1]!, x: 82, y: 3 },
  { ...SPOTS[2]!, x: 76, y: 91 },
  { ...SPOTS[3]!, x: 10, y: 93 },
];

/** Os pequenos flutuando. `edges` deixa só os das bordas (celular). */
export function FloatingMochis({ edges, className }: { edges?: boolean; className?: string }) {
  return (
    <div className={className ? `float-mochis ${className}` : "float-mochis"} aria-hidden="true">
      {(edges ? EDGES : SPOTS).map((s, i) => (
        <span
          key={i}
          className="float-mochi"
          style={{ left: `${s.x}%`, top: `${s.y}%`, ["--d" as string]: `${s.delay}s`, ["--r" as string]: `${i % 2 ? 8 : -8}deg` } as CSSProperties}
        >
          <Mochi size={s.size} outfit={s.look.outfit} mood={s.look.mood} still />
        </span>
      ))}
    </div>
  );
}

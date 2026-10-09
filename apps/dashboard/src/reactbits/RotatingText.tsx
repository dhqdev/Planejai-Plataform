/*
 * RotatingText, do React Bits (reactbits.dev), MIT + Commons Clause: aviso em ./LICENSE.md.
 * Adaptado: sem motion. Cada letra entra de baixo com mola (CSS) e o texto anterior sai para cima ao mesmo tempo.
 * Pode girar sozinho (auto) ou seguir um índice de fora (index), como a conversa do topo da landing faz.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "./reactbits.css";

export interface RotatingTextProps {
  texts: string[];
  /** índice controlado de fora; sem ele gira sozinho a cada rotationInterval */
  index?: number;
  rotationInterval?: number;
  auto?: boolean;
  /** atraso entre letras (s) */
  staggerDuration?: number;
  staggerFrom?: "first" | "last" | "center";
  className?: string;
}

const segment = (text: string): string[] => {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const seg = new Intl.Segmenter("pt-BR", { granularity: "grapheme" });
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  return Array.from(text);
};

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function Word({ text, phase, stagger, from }: { text: string; phase: "in" | "out"; stagger: number; from: RotatingTextProps["staggerFrom"] }) {
  const chars = useMemo(() => segment(text), [text]);
  const delay = (i: number) => {
    const n = chars.length;
    if (from === "last") return (n - 1 - i) * stagger;
    if (from === "center") return Math.abs(Math.floor(n / 2) - i) * stagger;
    return i * stagger;
  };
  return (
    <span className={`rb-rot-word ${phase}`} aria-hidden="true">
      {chars.map((c, i) => (
        <span key={i} className="rb-rot-char" style={{ ["--rb-d" as string]: `${delay(i)}s` } as CSSProperties}>
          {c === " " ? " " : c}
        </span>
      ))}
    </span>
  );
}

export function RotatingText({ texts, index, rotationInterval = 2200, auto = true, staggerDuration = 0.025, staggerFrom = "first", className = "" }: RotatingTextProps) {
  const [own, setOwn] = useState(0);
  const cur = index ?? own;
  const prev = useRef(cur);
  const [leaving, setLeaving] = useState<{ text: string; key: number } | null>(null);

  useEffect(() => {
    if (index !== undefined || !auto || reduced()) return;
    const t = setInterval(() => setOwn((i) => (i + 1) % texts.length), rotationInterval);
    return () => clearInterval(t);
  }, [index, auto, rotationInterval, texts.length]);

  // o texto que saiu fica na tela o tempo da saída
  useEffect(() => {
    if (prev.current === cur) return;
    const old = texts[prev.current] ?? "";
    prev.current = cur;
    if (reduced()) return;
    setLeaving({ text: old, key: Date.now() });
    const t = setTimeout(() => setLeaving(null), 520);
    return () => clearTimeout(t);
  }, [cur, texts]);

  const text = texts[cur] ?? "";
  return (
    // a palavra que sai fica por cima (absoluta); a largura é a da que entra
    <span className={`rb-rot ${className}`}>
      <span className="rb-rot-sr">{text}</span>
      {leaving && <Word key={`o${leaving.key}`} text={leaving.text} phase="out" stagger={staggerDuration} from={staggerFrom} />}
      <Word key={`i${cur}`} text={text} phase="in" stagger={staggerDuration} from={staggerFrom} />
    </span>
  );
}

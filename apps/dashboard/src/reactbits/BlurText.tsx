/*
 * BlurText, no estilo do React Bits (reactbits.dev), MIT + Commons Clause: aviso em ./LICENSE.md.
 * Cada palavra entra desfocada e sobe até o lugar, uma depois da outra. Adaptado: só CSS (sem motion),
 * roda uma vez ao montar e aparece pronto com movimento reduzido.
 */
import "./reactbits.css";

export function BlurText({ text, delay = 0.09, start = 0, className = "" }: { text: string; delay?: number; start?: number; className?: string }) {
  const words = text.split(" ");
  return (
    <span className={`rb-blur ${className}`}>
      {words.map((w, i) => (
        <span key={`${w}-${i}`} className="rb-blur-w" style={{ ["--rb-d" as string]: `${start + i * delay}s` }}>
          {w}
          {i < words.length - 1 ? " " : ""}
        </span>
      ))}
    </span>
  );
}

/*
 * ShinyText, no estilo do React Bits (reactbits.dev), MIT + Commons Clause: aviso em ./LICENSE.md.
 * Um brilho passa pelo texto de tempos em tempos. Só CSS (background-clip), parado com movimento reduzido.
 */
import type { ReactNode } from "react";
import "./reactbits.css";

export function ShinyText({ children, speed = 3.2, className = "" }: { children: ReactNode; speed?: number; className?: string }) {
  return (
    <span className={`rb-shiny ${className}`} style={{ ["--rb-shiny-s" as string]: `${speed}s` }}>
      {children}
    </span>
  );
}

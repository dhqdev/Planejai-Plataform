/*
 * GlareHover, do React Bits (reactbits.dev), MIT + Commons Clause: aviso em ./LICENSE.md.
 * Um reflexo que atravessa o cartão ao passar o mouse (ou ao focar com o teclado). Só CSS.
 * Adaptado: tamanho e fundo vêm da classe de quem usa; só o brilho é configurado aqui.
 */
import type { CSSProperties, ReactNode } from "react";
import "./reactbits.css";

interface GlareHoverProps {
  children?: ReactNode;
  glareColor?: string;
  glareOpacity?: number;
  glareAngle?: number;
  glareSize?: number;
  /** ms */
  transitionDuration?: number;
  playOnce?: boolean;
  className?: string;
  style?: CSSProperties;
}

const toRgba = (hex: string, a: number) => {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  if (!/^[0-9a-f]{6}$/i.test(full)) return hex;
  const n = Number.parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export function GlareHover({ children, glareColor = "#ffffff", glareOpacity = 0.5, glareAngle = -45, glareSize = 250, transitionDuration = 650, playOnce = false, className = "", style }: GlareHoverProps) {
  const vars = {
    "--gh-angle": `${glareAngle}deg`,
    "--gh-duration": `${transitionDuration}ms`,
    "--gh-size": `${glareSize}%`,
    "--gh-rgba": toRgba(glareColor, glareOpacity),
  } as CSSProperties;
  return (
    <div className={`rb-glare ${playOnce ? "rb-glare--once" : ""} ${className}`} style={{ ...vars, ...style }}>
      {children}
    </div>
  );
}

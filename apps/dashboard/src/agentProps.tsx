import type { Mood } from "./mochi/Mochi";
import "./agents.css";

/**
 * O que cada agente está fazendo, ao lado do Mochi dele: um objeto pequeno que se mexe (a batuta do Maestro,
 * a lupa da Lupa, o sino da Sininho...). O corpo do Mochi continua parado; quem se mexe é o objeto e os olhos.
 * Tudo em CSS (agents.css), desligado com movimento reduzido.
 */

const INK = "#121214";
const line = { stroke: INK, strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };

/** Expressões que cada agente alterna quando está "vivo" (olhos), na ordem. */
export const ROLE_MOODS: Record<string, Mood[]> = {
  cto: ["happy", "idle", "thinking", "wink"],
  pesquisador: ["searching", "curious", "idle", "searching"],
  agenda: ["idle", "thinking", "happy"],
  financeiro: ["working", "happy", "idle"],
  comunicacao: ["idle", "wink", "working"],
  produtividade: ["working", "finished", "idle"],
  recados: ["curious", "idle", "happy"],
};
export const CLIENT_MOODS: Mood[] = ["idle", "happy", "curious"];

/** O que cada um está fazendo agora (frases curtas que se revezam no cartão do time). */
export const ROLE_DOING: Record<string, string[]> = {
  cto: ["regendo o time", "lendo sua mensagem", "chamando quem sabe"],
  pesquisador: ["comparando preços", "lendo três sites", "achando o mais perto"],
  agenda: ["de olho no relógio", "anotando o lembrete", "arrumando a semana"],
  financeiro: ["somando os centavos", "lendo o comprovante", "vendo os limites"],
  comunicacao: ["achando o importante", "resumindo e-mails", "rascunhando resposta"],
  produtividade: ["riscando a lista", "rodando suas rotinas", "organizando tarefas"],
  recados: ["levando seu recado", "esperando resposta", "marcando o horário"],
};
export const CLIENT_DOING = ["estudando o assunto", "vendo o que você gosta"];

/** Desenho do objeto de cada agente (viewBox 40x40). */
export function PropArt({ agent }: { agent: string }) {
  switch (agent) {
    case "cto":
      return (
        <g>
          <g className="ap-note n1"><ellipse cx={27} cy={15} rx={2.6} ry={2} fill={INK} /><path d="M29.4 15 V7.5" {...line} strokeWidth={1.6} /></g>
          <g className="ap-note n2"><ellipse cx={31} cy={20} rx={2.2} ry={1.7} fill="var(--ap-accent)" /><path d="M33 20 V13.5" {...line} stroke="var(--ap-accent)" strokeWidth={1.5} /></g>
          <g className="ap-baton">
            <path d="M10 31 L25 13" {...line} strokeWidth={2.4} />
            <circle cx={10} cy={31} r={2.8} fill={INK} />
            <circle cx={25.4} cy={12.5} r={1.4} fill="var(--ap-accent)" />
          </g>
        </g>
      );
    case "pesquisador":
      return (
        <g className="ap-lens">
          <circle cx={17} cy={17} r={8} fill="#fff" stroke={INK} strokeWidth={2.4} />
          <path d="M13 14.5 Q14.5 12 17.5 11.6" stroke="var(--ap-accent)" strokeWidth={1.8} strokeLinecap="round" fill="none" />
          <path d="M23 23 L31 31" {...line} strokeWidth={3.4} />
        </g>
      );
    case "agenda":
      return (
        <g>
          <path className="ap-ring l" d="M8 14 Q5.5 18 8 22" {...line} strokeWidth={1.6} stroke="var(--ap-accent)" />
          <path className="ap-ring r" d="M32 14 Q34.5 18 32 22" {...line} strokeWidth={1.6} stroke="var(--ap-accent)" />
          <g className="ap-bell">
            <path d="M20 7 V9" {...line} />
            <path d="M12.5 26 C13 24 13.4 21.5 13.5 18.5 C13.7 13.5 16.4 10.5 20 10.5 C23.6 10.5 26.3 13.5 26.5 18.5 C26.6 21.5 27 24 27.5 26 Z" fill="#fff" stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
            <circle className="ap-clapper" cx={20} cy={29} r={2.2} fill={INK} />
          </g>
        </g>
      );
    case "financeiro":
      return (
        <g>
          <ellipse cx={20} cy={32} rx={9} ry={3} fill="#fff" stroke={INK} strokeWidth={2} />
          <path d="M11 29 V32 M29 29 V32" {...line} strokeWidth={2} />
          <ellipse cx={20} cy={29} rx={9} ry={3} fill="#fff" stroke={INK} strokeWidth={2} />
          <g className="ap-coin">
            <circle cx={20} cy={14} r={7.5} fill="var(--ap-accent)" stroke={INK} strokeWidth={2} />
            <circle cx={20} cy={14} r={4.4} fill="none" stroke="#fff" strokeWidth={1.4} opacity={0.9} />
          </g>
        </g>
      );
    case "comunicacao":
      return (
        <g className="ap-mail">
          <rect className="ap-letter" x={13} y={12} width={14} height={13} rx={1.5} fill="#fff" stroke={INK} strokeWidth={1.6} />
          <path className="ap-letter" d="M16 16.5 H24 M16 19.5 H22" stroke="var(--ap-accent)" strokeWidth={1.6} strokeLinecap="round" />
          <rect x={8} y={18} width={24} height={15} rx={2.5} fill="#fff" stroke={INK} strokeWidth={2.2} />
          <path d="M8.8 32 L17.5 25 M31.2 32 L22.5 25" {...line} strokeWidth={1.6} />
          <path className="ap-flap" d="M8.6 19 L20 27 L31.4 19" {...line} />
        </g>
      );
    case "produtividade":
      return (
        <g>
          <rect x={9} y={7} width={22} height={27} rx={3} fill="#fff" stroke={INK} strokeWidth={2.2} />
          {[14, 21, 28].map((y, i) => (
            <g key={y}>
              <path className={`ap-check c${i}`} d={`M12.5 ${y} l2 2 l3.2 -4`} stroke="var(--ap-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" pathLength={1} />
              <path d={`M20.5 ${y} H27.5`} stroke={INK} strokeWidth={1.8} strokeLinecap="round" opacity={0.35} />
            </g>
          ))}
        </g>
      );
    case "recados":
      return (
        <g className="ap-bubble">
          <path d="M8 11 C8 8.8 9.8 7 12 7 H28 C30.2 7 32 8.8 32 11 V23 C32 25.2 30.2 27 28 27 H17 L11 32 V27 C9.3 26.6 8 25 8 23 Z" fill="#fff" stroke={INK} strokeWidth={2.2} strokeLinejoin="round" />
          {[14.5, 20, 25.5].map((x, i) => (
            <circle key={x} className={`ap-dot d${i}`} cx={x} cy={17} r={1.9} fill={i === 1 ? "var(--ap-accent)" : INK} />
          ))}
        </g>
      );
    default:
      return (
        <g className="ap-spark">
          <path d="M20 6 C21 15 25 19 34 20 C25 21 21 25 20 34 C19 25 15 21 6 20 C15 19 19 15 20 6 Z" fill="var(--ap-accent)" stroke={INK} strokeWidth={1.6} strokeLinejoin="round" />
        </g>
      );
  }
}

/** O objeto num disquinho branco, encostado no canto do rosto. */
export function AgentProp({ agent }: { agent: string }) {
  return (
    <span className="agent-prop" aria-hidden="true">
      <svg viewBox="0 0 40 40" width="100%" height="100%">
        <PropArt agent={agent} />
      </svg>
    </span>
  );
}

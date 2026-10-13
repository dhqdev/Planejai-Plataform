import { useEffect, useRef, useState } from "react";
import { AgentFace, CORE_FACES, type Face } from "../faces";
import "../styles/landing-time.css";

/**
 * "O time" da landing, contado pela rolagem: de um lado o agente da vez (grande, vivo, com o objeto dele trabalhando),
 * do outro um pedido de verdade e a resposta dele. Rolou, troca o agente. No celular o agente da vez fica preso no topo
 * numa faixa pequena e as conversas passam embaixo. Só o que o agente faz de verdade (agent/team.ts).
 */
interface Member {
  id: string;
  /** Nina (compras) não está em CORE_FACES: nome e carinha vêm daqui (espelho de team.ts). */
  persona?: string;
  face?: Face;
  role: string;
  ask: string;
  answer: string;
}

const TEAM: Member[] = [
  { id: "cto", role: "Conversa com você e chama o time", ask: "paguei 80 no almoço e amanhã tenho dentista às 15h", answer: "Anotei R$ 80,00 em Alimentação e marquei o dentista amanhã às 15h." },
  { id: "financeiro", role: "Cuida do seu dinheiro", ask: "quanto gastei com mercado esse mês?", answer: "R$ 612,40. Ainda cabem R$ 187,60 no seu limite." },
  { id: "agenda", role: "Cuida do seu tempo", ask: "me lembra de pagar a luz dia 10", answer: "Fechado. Dia 10 às 9h eu te chamo." },
  { id: "pesquisador", role: "Procura por você", ask: "tem pizzaria aberta perto de mim?", answer: "Três abertas agora. A mais perto fica a 800 m." },
  { id: "recados", role: "Fala com lojas e lugares", ask: "vê se a barbearia tem horário sábado cedo", answer: "Pergunto pra Barbearia do Zé se tem às 9h. Posso mandar?" },
  { id: "comunicacao", role: "Manda mensagem por você", ask: "amanhã às 8h manda parabéns pra Ana", answer: "Deixo agendado pra amanhã às 8h. Confirma?" },
  {
    id: "compras",
    persona: "Nina",
    face: { color: 5, eyes: "happy", mouth: "smile", extra: "none" },
    role: "Acha o menor preço",
    ask: "air fryer boa até 400 reais",
    answer: "A melhor sai por R$ 389,90 no Mercado Livre. Quer o link?",
  },
  { id: "produtividade", role: "Automatiza o resto", ask: "toda segunda me manda a lista da semana", answer: "Combinado. Toda segunda às 8h ela chega aqui." },
];

const nameOf = (m: Member) => m.persona ?? CORE_FACES[m.id]?.persona ?? m.id;
const faceOf = (m: Member) => m.face ?? CORE_FACES[m.id]?.face;

export function TeamScroll() {
  const [on, setOn] = useState(0);
  const acts = useRef<HTMLOListElement>(null);

  // o agente da vez é o capítulo que passa pela faixa do meio da tela
  useEffect(() => {
    const list = acts.current;
    if (!list || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setOn(Number((e.target as HTMLElement).dataset.i));
      },
      { rootMargin: "-48% 0px -48% 0px" },
    );
    for (const li of list.children) io.observe(li);
    return () => io.disconnect();
  }, []);

  return (
    <div className="lt-scrolly" style={{ ["--n" as string]: TEAM.length }}>
      <div className="lt-stage-col">
        <div className="lt-stage" aria-hidden="true">
          <div className="lt-faces">
            {TEAM.map((m, i) => (
              <div key={m.id} className={`lt-face ${i === on ? "on" : i < on ? "past" : ""}`}>
                <AgentFace face={faceOf(m)} size={260} agent={m.id} live={i === on} />
              </div>
            ))}
          </div>
          <div className="lt-tag">
            {TEAM.map((m, i) => (
              <b key={m.id} className={i === on ? "on" : ""}>
                {nameOf(m)}
              </b>
            ))}
          </div>
          <div className="lt-dots">
            {TEAM.map((m, i) => (
              <i key={m.id} className={i === on ? "on" : ""} />
            ))}
          </div>
        </div>
      </div>

      <ol className="lt-acts" ref={acts}>
        {TEAM.map((m, i) => (
          <li key={m.id} data-i={i} className={i === on ? "on" : ""}>
            <span className="lt-who">{nameOf(m)}</span>
            <h3>{m.role}</h3>
            <div className="lt-chat">
              <div className="lt-b me">{m.ask}</div>
              <div className="lt-b bot">{m.answer}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

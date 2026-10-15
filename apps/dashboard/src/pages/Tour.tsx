import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "../api";
import { useMedia } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";
import { Mascote, type Outfit } from "../mascote/Mascote";
import { MASCOTE, MASCOTES } from "../mascote/nome";
import { useOutfit } from "../mascote/state";

/**
 * Tour animado do primeiro login (uma vez por conta, `accounts.tour_seen_at`): seis cenas curtas com o
 * mascote mostrando como o Planejai funciona. Notebook: cartão de duas colunas no meio da tela; celular:
 * tela cheia com os botões no pé. Arrastar para o lado, setas e Esc funcionam. Movimento reduzido: só troca.
 */

const d = (s: number) => ({ ["--d" as string]: `${s}s` }) as CSSProperties;

function Bubble({ me, at, children }: { me?: boolean; at: number; children: ReactNode }) {
  return (
    <span className={me ? "tour-bubble me" : "tour-bubble"} style={d(at)}>
      {children}
    </span>
  );
}

function ChatScene() {
  return (
    <div className="tour-chat">
      <Bubble me at={0.15}>gastei 42 no mercado</Bubble>
      <span className="tour-typing" style={d(0.7)} aria-hidden="true"><i /><i /><i /></span>
      <Bubble at={1.35}>Anotei <b>R$ 42,00</b> em Mercado ✅</Bubble>
      <Bubble me at={2.1}>me lembra amanhã às 9h do dentista</Bubble>
      <Bubble at={2.9}>Combinado! Te aviso amanhã às 9h ⏰</Bubble>
    </div>
  );
}

const BARS = [38, 62, 46, 80, 54, 70];
function PanelScene() {
  return (
    <div className="tour-panel">
      <div className="tour-tile tour-cal" style={d(0.1)}>
        <span className="tour-tile-h"><Icon name="calendar" size={14} /> Agenda</span>
        <div className="tour-cal-grid" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <i key={i} className={i === 9 ? "today" : undefined} />
          ))}
        </div>
        <span className="tour-event" style={d(0.9)}>9:00 · Dentista</span>
      </div>
      <div className="tour-tile tour-money" style={d(0.3)}>
        <span className="tour-tile-h"><Icon name="wallet" size={14} /> Finanças</span>
        <div className="tour-bars" aria-hidden="true">
          {BARS.map((h, i) => (
            <i key={i} style={{ ...d(0.5 + i * 0.08), height: `${h}%` }} />
          ))}
        </div>
      </div>
      <div className="tour-tile tour-row" style={d(1.4)}>
        <span className="tour-row-ico"><Icon name="cart" size={15} /></span>
        <span className="tour-row-t">Mercado<small>agora há pouco</small></span>
        <b>R$ 42,00</b>
      </div>
    </div>
  );
}

const TEAM: { outfit: Outfit; label: string }[] = [
  { outfit: { eyes: "glasses", neck: "bowtie" }, label: "Finanças" },
  { outfit: { head: "headphones" }, label: "Agenda" },
  { outfit: { head: "cap", eyes: "sunglasses" }, label: "Pesquisa" },
  { outfit: { head: "beanie", neck: "scarf" }, label: "Recados" },
];
function TeamScene({ small }: { small: boolean }) {
  return (
    <div className="tour-team">
      <div className="tour-team-row">
        {TEAM.map((m, i) => (
          <span key={m.label} className="tour-team-one" style={d(0.15 + i * 0.18)}>
            <span className="tour-team-hop" style={d(1.2 + i * 0.35)}>
              <Mascote size={small ? 64 : 78} outfit={m.outfit} mood={i % 2 ? "happy" : "curious"} />
            </span>
            <small>{m.label}</small>
          </span>
        ))}
      </div>
      <span className="tour-link" style={d(1)} aria-hidden="true" />
      <span className="tour-note" style={d(1.9)}>“Conferi com a Agenda: dia 12 você já tem compromisso.”</span>
    </div>
  );
}

function YesScene() {
  return (
    <div className="tour-yes">
      <Bubble at={0.15}>
        Mando pra <b>Ana</b>: “chego às 19h”?
      </Bubble>
      <div className="tour-yes-btns" style={d(0.6)}>
        <span className="tour-yes-btn sim">Sim</span>
        <span className="tour-yes-btn">Não</span>
        <span className="tour-finger" style={d(1.1)} aria-hidden="true" />
      </div>
      <span className="tour-sent" style={d(1.9)}>
        <Icon name="check" size={14} /> Enviado para Ana
      </span>
    </div>
  );
}

const RAIL = ["home", "calendar", "wallet", "eye", "send", "users", "file"];
function WhereScene({ phone }: { phone: boolean }) {
  if (phone)
    return (
      <div className="tour-where phone">
        <div className="tour-mini-screen" aria-hidden="true">
          <i style={d(0.2)} /><i style={d(0.3)} /><i className="short" style={d(0.4)} />
        </div>
        <div className="tour-mini-bar" aria-hidden="true">
          {["home", "calendar", "wallet", "more"].map((n, i) => (
            <span key={n} style={d(0.7 + i * 0.35)}><Icon name={n} size={16} /></span>
          ))}
        </div>
      </div>
    );
  return (
    <div className="tour-where">
      <div className="tour-mini-rail" aria-hidden="true">
        <span className="tour-mini-brand" />
        {RAIL.map((n, i) => (
          <span key={n} className="tour-mini-ico" style={d(0.5 + i * 0.22)}><Icon name={n} size={15} /></span>
        ))}
        <span className="tour-mini-gap" />
        <span className="tour-mini-ico" style={d(0.5 + RAIL.length * 0.22)}><Icon name="bell" size={15} /></span>
        <span className="tour-mini-me" style={d(0.7 + RAIL.length * 0.22)} />
      </div>
      <div className="tour-mini-screen" aria-hidden="true">
        <i style={d(0.2)} /><i style={d(0.3)} /><i className="short" style={d(0.4)} />
      </div>
    </div>
  );
}

interface Step {
  id: string;
  title: string;
  text: string;
  scene: ReactNode;
}

export function Tour({ name, onDone }: { name?: string | null; onDone: () => void }) {
  const phone = useMedia("(max-width: 767px)");
  const [outfit] = useOutfit();
  const [i, setI] = useState(0);
  const [dir, setDir] = useState<"next" | "prev">("next");
  const [leaving, setLeaving] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  const first = (name ?? "").trim().split(/\s+/)[0];

  const steps: Step[] = [
    {
      id: "oi",
      title: first ? `Oi, ${first}! Eu sou o ${MASCOTE}.` : `Oi! Eu sou o ${MASCOTE}.`,
      text: "Você fala comigo no WhatsApp e eu organizo o resto. Aqui no painel você vê tudo arrumadinho.",
      scene: (
        <div className="tour-hello">
          <span className="tour-hello-glow" aria-hidden="true" />
          <Mascote size={phone ? 150 : 180} outfit={Object.keys(outfit).length ? outfit : { head: "party" }} mood="greeting" />
        </div>
      ),
    },
    {
      id: "chat",
      title: "Fala do seu jeito",
      text: "Texto, áudio ou foto. Gasto, lembrete ou pergunta: manda como mandaria pra um amigo.",
      scene: <ChatScene />,
    },
    {
      id: "painel",
      title: "Tudo aparece aqui",
      text: "Agenda, finanças, documentos e contatos se atualizam sozinhos enquanto vocês conversam.",
      scene: <PanelScene />,
    },
    {
      id: "time",
      title: `Um time de ${MASCOTES} por trás`,
      text: "Cada um cuida de um assunto, e eles conversam entre si antes de te responder.",
      scene: <TeamScene small={phone} />,
    },
    {
      id: "sim",
      title: "Nada sai sem o seu sim",
      text: "Mensagem pra alguém, pagamento ou apagar alguma coisa: eu mostro antes e espero você responder sim.",
      scene: <YesScene />,
    },
    {
      id: "onde",
      title: "Onde fica cada coisa",
      text: phone
        ? "As telas principais ficam na barra de baixo. O resto mora em Mais, junto com a sua conta."
        : "O menu fica à esquerda. Avisos e a sua conta ficam no pé dele.",
      scene: <WhereScene phone={phone} />,
    },
  ];
  const last = i === steps.length - 1;
  const step = steps[i]!;

  const close = () => {
    if (leaving) return;
    setLeaving(true);
    void api("/api/me/tour", { method: "PUT" }).catch(() => {});
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(onDone, calm ? 0 : 240);
  };
  const go = (to: number) => {
    if (to < 0 || to === i) return;
    if (to >= steps.length) return close();
    haptic();
    setDir(to > i ? "next" : "prev");
    setI(to);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(i + 1);
      else if (e.key === "ArrowLeft") go(i - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  // foco no cartão ao abrir (leitor de tela e teclado começam aqui, sem anel de foco no botão a cada etapa)
  useEffect(() => card.current?.focus({ preventScroll: true }), []);

  return (
    <div className={leaving ? "tour out" : "tour"} role="dialog" aria-modal="true" aria-labelledby="tour-title" aria-describedby="tour-text">
      <div
        ref={card}
        tabIndex={-1}
        className="tour-card"
        onPointerDown={(e) => (drag.current = { x: e.clientX, y: e.clientY })}
        onPointerUp={(e) => {
          const s = drag.current;
          drag.current = null;
          if (!s) return;
          const dx = e.clientX - s.x;
          if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.5) go(i + (dx < 0 ? 1 : -1));
        }}
        onPointerCancel={() => (drag.current = null)}
      >
        <button className="tour-skip" onClick={close}>
          Pular
        </button>
        <div className="tour-scene">
          <div className={`tour-scene-in ${dir}`} key={step.id}>
            {step.scene}
          </div>
        </div>
        <div className="tour-side">
          <div className={`tour-copy ${dir}`} key={step.id} aria-live="polite">
            <span className="tour-count">
              {i + 1} de {steps.length}
            </span>
            <h2 id="tour-title">{step.title}</h2>
            <p id="tour-text">{step.text}</p>
          </div>
          <div className="tour-foot">
            <div className="tour-dots" role="tablist" aria-label="Etapas do tour">
              {steps.map((s, n) => (
                <button key={s.id} role="tab" aria-selected={n === i} aria-label={`Etapa ${n + 1}`} className={n === i ? "on" : undefined} onClick={() => go(n)} />
              ))}
            </div>
            <div className="tour-btns">
              {i > 0 && (
                <button className={phone ? "btn btn-lg" : "btn"} onClick={() => go(i - 1)}>
                  Voltar
                </button>
              )}
              <button className={phone ? "btn btn-primary btn-lg" : "btn btn-primary"} onClick={() => go(i + 1)}>
                {last ? "Começar" : "Próximo"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

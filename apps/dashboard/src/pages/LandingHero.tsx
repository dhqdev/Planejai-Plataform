import { useEffect, useRef, useState, type ReactNode } from "react";
import { Mochi, type Mood, type Outfit } from "../mochi/Mochi";
import { CountUp } from "../reactbits/CountUp";
import { RotatingText } from "../reactbits/RotatingText";

/**
 * Topo da landing: título curto com o verbo girando (RotatingText) junto com uma conversa de WhatsApp que se
 * repete em três cenas (cinema, gasto, lembrete). Em cada uma a mensagem chega, o Mochi reage com um emoji,
 * digita e responde com um cartão. Os botões embaixo pulam para a cena. Para fora da tela e com a aba escondida;
 * com movimento reduzido, mostra a cena pronta.
 */

interface Scene {
  id: string;
  tab: string;
  verb: string;
  me: ReactNode;
  react: string;
  outfit: Outfit;
  mood: Mood;
  reply: (play: number) => ReactNode;
}

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

export const SCENES: Scene[] = [
  {
    id: "cinema",
    tab: "Cinema",
    verb: "acha o cinema.",
    me: "tem Duna hoje no Iguatemi?",
    react: "🍿",
    outfit: { eyes: "sunglasses" },
    mood: "happy",
    reply: () => (
      <>
        <span className="hc-card">
          <span className="hc-poster" aria-hidden="true" />
          <span>
            <b>Duna</b>
            <small>Iguatemi, hoje</small>
            <span className="hc-times">
              {["16h30", "19h10", "21h50"].map((t, i) => (
                <i key={t} className={i === 1 ? "on" : ""} style={{ ["--i" as string]: i }}>
                  {t}
                </i>
              ))}
            </span>
          </span>
        </span>
        Tem sim! Te lembro 1h antes?
      </>
    ),
  },
  {
    id: "gasto",
    tab: "Gasto",
    verb: "anota o gasto.",
    me: "gastei 42,90 no mercado",
    react: "🛒",
    outfit: { eyes: "monocle", neck: "bowtie" },
    mood: "finished",
    reply: (play) => (
      <>
        <span className="hc-card hc-money">
          <span className="hc-row">
            <span>
              <b>Mercado</b>
              <small>Alimentação</small>
            </span>
            <b>R$ 42,90</b>
          </span>
          <span className="hc-limit">
            <small>No mês</small>
            <b>
              <CountUp from={569.5} to={612.4} duration={1.2} delay={0.35} replay={play} format={brl} /> <small>de R$ 800,00</small>
            </b>
            <i>
              <em />
            </i>
          </span>
        </span>
        Anotado!
      </>
    ),
  },
  {
    id: "lembrete",
    tab: "Lembrete",
    verb: "te lembra.",
    me: (
      <span className="hc-audio">
        <span className="hc-play" aria-hidden="true" />
        <span className="hc-wave" aria-hidden="true">
          {Array.from({ length: 16 }, (_, i) => (
            <i key={i} style={{ ["--h" as string]: `${30 + ((i * 37) % 70)}%`, ["--i" as string]: i }} />
          ))}
        </span>
        <small>0:07</small>
      </span>
    ),
    react: "⏰",
    outfit: { head: "headphones" },
    mood: "wink",
    reply: () => (
      <>
        <span className="hc-card hc-bell">
          <span className="hc-bell-ico" aria-hidden="true">
            <svg viewBox="0 0 40 40" width={20} height={20}>
              <path d="M12.5 26 C13 24 13.4 21.5 13.5 18.5 C13.7 13.5 16.4 10.5 20 10.5 C23.6 10.5 26.3 13.5 26.5 18.5 C26.6 21.5 27 24 27.5 26 Z" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinejoin="round" />
              <circle cx={20} cy={30} r={2.4} fill="currentColor" />
            </svg>
          </span>
          <span>
            <b>Pagar a luz</b>
            <small>dia 10, 9h00</small>
          </span>
        </span>
        Ouvi seu áudio. Dia 10 eu te chamo!
      </>
    ),
  },
];

/** Passos de cada cena: chega a mensagem, o Mochi reage, digita, responde, segura e some. Duração de cada um (ms). */
const STEPS = [260, 900, 650, 1150, 4300, 460];
const MOOD_AT: Mood[] = ["idle", "curious", "surprised", "thinking"];

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function useLive<T extends Element>() {
  const ref = useRef<T>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setLive(true);
    let seen = false;
    const sync = () => setLive(seen && !document.hidden);
    const io = new IntersectionObserver(([e]) => {
      seen = !!e?.isIntersecting;
      sync();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", sync);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);
  return [ref, live] as const;
}

export function HeroChat({ scene, onScene }: { scene: number; onScene: (i: number) => void }) {
  const [box, live] = useLive<HTMLDivElement>();
  const still = reduced();
  const [step, setStep] = useState(still ? 4 : 0);
  const [play, setPlay] = useState(0);
  const s = SCENES[scene]!;

  useEffect(() => {
    if (still || !live) return;
    const t = setTimeout(() => {
      if (step < STEPS.length - 1) return setStep(step + 1);
      setStep(0);
      setPlay((n) => n + 1);
      onScene((scene + 1) % SCENES.length);
    }, STEPS[step]);
    return () => clearTimeout(t);
  }, [step, live, still, scene, onScene]);

  const pick = (i: number) => {
    onScene(i);
    setPlay((n) => n + 1);
    setStep(still ? 4 : 1);
  };

  const mood = step >= 4 ? s.mood : (MOOD_AT[step] ?? "idle");
  const leaving = step === 5;

  return (
    <div className="hc" ref={box}>
      <div className="hc-mochi" aria-hidden="true">
        <span className="hc-mochi-in" key={s.id}>
          <Mochi size={120} mood={mood} outfit={s.outfit} />
        </span>
      </div>
      <div className="hc-win" role="img" aria-label={`Exemplo de conversa no WhatsApp: você pede e ele ${s.verb}`}>
        <div className="hc-top" aria-hidden="true">
          <span className="hc-avatar">
            <Mochi size={28} still mood="happy" />
          </span>
          <span>
            <strong>Planejai</strong>
            <small>{step === 3 ? "digitando…" : "online"}</small>
          </span>
        </div>
        <div className={`hc-chat ${leaving ? "out" : ""}`} aria-hidden="true" key={`${s.id}-${play}`}>
          {step >= 1 && (
            <div className="hc-b me">
              {s.me}
              {step >= 2 && <span className="hc-react">{s.react}</span>}
              <span className="hc-tick">✓✓</span>
            </div>
          )}
          {step === 3 && (
            <div className="hc-b bot hc-typing">
              <i />
              <i />
              <i />
            </div>
          )}
          {step >= 4 && <div className="hc-b bot">{s.reply(play)}</div>}
        </div>
      </div>
      <div className="hc-tabs" role="tablist" aria-label="Escolha um exemplo">
        {SCENES.map((x, i) => (
          <button key={x.id} type="button" role="tab" aria-selected={i === scene} className={i === scene ? "on" : ""} onClick={() => pick(i)}>
            {x.tab}
            {i === scene && live && !still && <i className="hc-tab-bar" key={play} />}
          </button>
        ))}
      </div>
    </div>
  );
}

export function HeroTitle({ scene }: { scene: number }) {
  return (
    <h1 className="hc-title" aria-label="Você manda no WhatsApp. Ele resolve.">
      <span className="hc-l1" aria-hidden="true">
        Você manda.
      </span>
      <span className="hc-l2" aria-hidden="true">
        Ele <RotatingText texts={SCENES.map((x) => x.verb)} index={scene} staggerDuration={0.02} />
      </span>
    </h1>
  );
}

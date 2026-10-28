import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../icons";
import { Mascote, type Mood } from "../mascote/Mascote";
import { CountUp } from "../reactbits/CountUp";
import "../styles/landing-painel.css";
import { HeroChat, moodAt, SCENES } from "./LandingHero";

/**
 * Janela do painel no topo da landing (no estilo do Notion, que mostra o produto aberto): menu do lado, o Início com
 * agenda, gastos e lembretes, e a conversa do WhatsApp encaixada à direita. Quando a conversa responde, o item da cena
 * aparece no cartão certo, com um brilho roxo rápido: o que você manda no WhatsApp cai no painel. No celular fica só a
 * conversa e o cartão da cena atual. Em cima da janela o Bolinho anda de um lado para o outro (pedido do David): para
 * quando chega a mensagem, reage e, quando responde, sai andando de novo. Com movimento reduzido, mostra tudo pronto.
 */

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

const MENU: [string, string][] = [
  ["home", "Início"],
  ["calendar", "Agenda"],
  ["wallet", "Finanças"],
  ["bell", "Lembretes"],
  ["cart", "Compras"],
  ["users", "Contatos"],
];

const TEAM = ["Juvenal", "Moacir", "Cotinha", "Clotilde"];

/** px por segundo, o mesmo passo do Mascote que passeia no app */
const SPEED = 90;

/**
 * O Bolinho andando na borda de cima da janela, indo e vindo. Anda enquanto a conversa está parada (resposta na tela,
 * troca de cena) e para virado para a pessoa quando chega mensagem nova, com a cara de cada passo. Tocou nele: pula e
 * acena. Os olhos seguem o mouse quando ele está parado.
 */
function Walker({ scene, step }: { scene: number; step: number }) {
  const track = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const x = useRef<number | null>(null);
  const anim = useRef<Animation | null>(null);
  const [walking, setWalking] = useState(false);
  const [dir, setDir] = useState<1 | -1>(-1);
  const [wave, setWave] = useState(false);
  const still = reduced();
  // anda depois que a resposta aparece e na troca de cena; para quando chega a mensagem nova
  const wants = !still && (step === 0 || step >= 4);

  const size = () => (track.current && track.current.clientWidth < 600 ? 76 : 108);
  const place = (v: number) => {
    x.current = v;
    if (body.current) body.current.style.transform = `translateX(${v}px)`;
  };

  useEffect(() => {
    const el = track.current;
    if (!el || x.current !== null) return;
    place(el.clientWidth - size() - 12);
  });

  useEffect(() => {
    const el = track.current;
    const b = body.current;
    if (!el || !b || !wants) return;
    let alive = true;
    // espera a cara da resposta aparecer antes de sair andando
    const t = setTimeout(() => {
      if (!alive) return;
      const w = el.clientWidth - size();
      const from = x.current ?? w;
      const left = from > w / 2;
      const to = Math.round(w * (left ? 0.04 + Math.random() * 0.3 : 0.62 + Math.random() * 0.34));
      setDir(to > from ? 1 : -1);
      setWalking(true);
      const a = b.animate([{ transform: `translateX(${from}px)` }, { transform: `translateX(${to}px)` }], {
        duration: (Math.abs(to - from) / SPEED) * 1000,
        easing: "linear",
        fill: "forwards",
      });
      anim.current = a;
      a.onfinish = () => {
        place(to);
        a.cancel();
        setWalking(false);
      };
    }, step >= 4 ? 700 : 0);
    return () => {
      alive = false;
      clearTimeout(t);
      const a = anim.current;
      anim.current = null;
      if (a && a.playState === "running") {
        place(new DOMMatrix(getComputedStyle(b).transform).m41);
        a.cancel();
      }
      setWalking(false);
    };
  }, [wants, step === 0]);

  const tap = () => {
    if (still || wave) return;
    setWave(true);
    body.current?.firstElementChild?.animate(
      [{ transform: "none" }, { transform: "translateY(-22px) scale(1.04, .96)" }, { transform: "translateY(2px) scale(.97, 1.03)" }, { transform: "none" }],
      { duration: 560, easing: "cubic-bezier(.34, 1.56, .64, 1)" },
    );
    setTimeout(() => setWave(false), 1800);
  };

  const s = SCENES[scene]!;
  const mood: Mood = wave ? "greeting" : walking ? "happy" : moodAt(scene, step);
  return (
    <div className="np-walk" ref={track} aria-hidden="true">
      <div className="np-walk-body" ref={body}>
        <span className="np-walk-in" onPointerDown={tap}>
          <Mascote size={size()} mood={mood} outfit={s.outfit} walking={walking} gaze={walking ? [dir * 0.9, 0.1] : undefined} />
        </span>
      </div>
    </div>
  );
}

export function HeroPanel({ scene, onScene }: { scene: number; onScene: (i: number) => void }) {
  const [done, setDone] = useState<string[]>(() => (reduced() ? SCENES.map((s) => s.id) : []));
  const [step, setStep] = useState(reduced() ? 4 : 0);
  const at = useRef(scene);
  at.current = scene;
  // a resposta apareceu: o item cai no cartão. A volta recomeça na primeira cena e os cartões voltam ao começo junto
  const onStep = useCallback((n: number) => {
    setStep(n);
    if (n !== 4) return;
    const i = at.current;
    const id = SCENES[i]!.id;
    setDone((d) => (i === 0 ? [id] : d.includes(id) ? d : [...d, id]));
  }, []);
  const has = (id: string) => done.includes(id);
  const now = new Date();
  const day = now.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  const month = now.toLocaleDateString("pt-BR", { month: "long" });
  const spent = has("gasto");

  return (
    <div className="np" data-scene={SCENES[scene]!.id}>
      <div className="np-win">
        <Walker scene={scene} step={step} />
        <div className="np-bar" aria-hidden="true">
          <span className="np-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="np-url">meuplanejai.com</span>
        </div>
        <div className="np-body">
          <aside className="np-side" aria-hidden="true">
            <span className="np-brand">
              <Mascote size={22} still mood="happy" />
              Planejai
            </span>
            <span className="np-search">
              <Icon name="search" size={14} />
              Buscar
            </span>
            <ul>
              {MENU.map(([ico, name], i) => (
                <li key={name} className={i === 0 ? "on" : ""}>
                  <Icon name={ico} size={15} />
                  {name}
                </li>
              ))}
            </ul>
            <small>Seu time</small>
            <ul>
              {TEAM.map((n) => (
                <li key={n}>
                  <span className="np-face" />
                  {n}
                </li>
              ))}
            </ul>
          </aside>

          <div className="np-main" aria-hidden="true">
            <div className="np-hello">
              <b>Bom dia, Ana</b>
              <small>{day}</small>
            </div>
            <div className="np-cards">
              <section className="np-card" data-k="cinema">
                <h4>
                  <Icon name="calendar" size={14} /> Hoje
                </h4>
                <p className="np-row">
                  <span>Academia</span>
                  <small>7h00</small>
                </p>
                <p className="np-row">
                  <span>Reunião com a Bia</span>
                  <small>15h00</small>
                </p>
                {has("cinema") && (
                  <p className="np-row np-new">
                    <span>Duna, Iguatemi</span>
                    <small>19h10</small>
                  </p>
                )}
              </section>

              <section className="np-card" data-k="gasto">
                <h4>
                  <Icon name="wallet" size={14} /> Gastos de {month}
                </h4>
                <p className="np-total">
                  {spent ? <CountUp key="on" from={569.5} to={612.4} duration={1.1} format={brl} /> : brl(569.5)}
                  <small> de {brl(800)}</small>
                </p>
                <span className="np-meter">
                  <i style={{ width: spent ? "76.5%" : "71.2%" }} />
                </span>
                <p className="np-row">
                  <span>Drogaria</span>
                  <small>{brl(37.5)}</small>
                </p>
                {spent && (
                  <p className="np-row np-new">
                    <span>Mercado</span>
                    <small>{brl(42.9)}</small>
                  </p>
                )}
              </section>

              <section className="np-card" data-k="lembrete">
                <h4>
                  <Icon name="bell" size={14} /> Lembretes
                </h4>
                <p className="np-row">
                  <span>Dentista</span>
                  <small>amanhã, 14h00</small>
                </p>
                {has("lembrete") && (
                  <p className="np-row np-new">
                    <span>Pagar a luz</span>
                    <small>dia 10, 9h00</small>
                  </p>
                )}
              </section>
            </div>
          </div>

          <div className="np-chat">
            <HeroChat scene={scene} onScene={onScene} onStep={onStep} />
          </div>
        </div>
      </div>
    </div>
  );
}

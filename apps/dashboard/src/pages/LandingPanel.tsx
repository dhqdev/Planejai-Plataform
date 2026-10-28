import { useCallback, useState } from "react";
import { Icon } from "../icons";
import { Mascote } from "../mascote/Mascote";
import { CountUp } from "../reactbits/CountUp";
import "../styles/landing-painel.css";
import { HeroChat, SCENES } from "./LandingHero";

/**
 * Janela do painel no topo da landing (no estilo do Notion, que mostra o produto aberto): menu do lado, o Início com
 * agenda, gastos e lembretes, e a conversa do WhatsApp encaixada à direita. Quando a conversa responde, o item da cena
 * aparece no cartão certo, com um brilho roxo rápido: o que você manda no WhatsApp cai no painel. No celular fica só a
 * conversa e o cartão da cena atual. Com movimento reduzido, mostra tudo pronto.
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

export function HeroPanel({ scene, onScene }: { scene: number; onScene: (i: number) => void }) {
  const [done, setDone] = useState<string[]>(() => (reduced() ? SCENES.map((s) => s.id) : []));
  // a volta recomeça na primeira cena: os cartões voltam ao começo junto
  const onDone = useCallback((i: number) => {
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
            <HeroChat scene={scene} onScene={onScene} onDone={onDone} />
          </div>
        </div>
      </div>
    </div>
  );
}

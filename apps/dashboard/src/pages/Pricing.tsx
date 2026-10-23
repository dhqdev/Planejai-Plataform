import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Mascote } from "../mascote/Mascote";
import { CountUp } from "../reactbits/CountUp";
import { Includes, type PlanFeature } from "../planFeatures";
import "../pricing.css";

/**
 * Página de preços pública (/precos), aberta pelo "Planos" da landing. No jeito da página de preços do Toki (pedido do
 * David): fundo escuro com aurora no topo, selos, chave Planos/Pacotes, cartões com o destaque de borda viva e a lista de
 * benefícios, comparação, como subir de plano e perguntas. Tudo vem de /api/auth/config (o que o dono configura em
 * Configurações > Grãos e planos), então nada aqui promete o que o produto não faz: todo plano libera tudo e muda só no
 * preço e nos grãos; a lista do que vem em todos vem do servidor (pricing.features, plan-features.ts).
 */

interface Plan {
  id: string;
  name: string;
  price: number;
  grains: number;
  blurb: string;
  highlight?: boolean;
  perks?: string[];
}
interface Pack {
  id: string;
  grains: number;
  price: number;
}
interface Pricing {
  enabled: boolean;
  plans: Plan[];
  features?: PlanFeature[];
  packs: Pack[];
  welcome: number;
  trialDays?: number;
  grainsPerUsd: number;
  perMessage?: number | null;
  referral: { step: number; max: number };
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const int = (n: number) => Math.round(n).toLocaleString("pt-BR");
const grainsTxt = (n: number) => `${int(n)} ${Math.round(n) === 1 ? "grão" : "grãos"}`;
/** Arredonda a estimativa de mensagens para não parecer mais precisa do que é. */
const roughly = (n: number) => (n >= 1000 ? Math.floor(n / 100) * 100 : n >= 100 ? Math.floor(n / 10) * 10 : Math.max(1, Math.floor(n)));
const per1000 = (price: number, grains: number) => brl((price / grains) * 1000);

/** Ícones pequenos da lista de benefícios (traço, herdam a cor). */
const PERK_ICONS = [
  "M12 3l1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z M19 15l.8 1.9 1.9.8-1.9.8L19 20.4l-.8-1.9-1.9-.8 1.9-.8z",
  "M4 7h16v12H4z M4 11h16 M8 4v4 M16 4v4",
  "M12 4a6 6 0 0 1 6 6c0 2.2-1.2 3.6-2.5 4.6V17H8.5v-2.4C7.2 13.6 6 12.2 6 10a6 6 0 0 1 6-6z M9.5 20h5",
  "M5 12l4 4 10-10",
  "M4 5h16v10H8l-4 4z",
];
function PerkIcon({ i }: { i: number }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PERK_ICONS[i % PERK_ICONS.length]} />
    </svg>
  );
}
const Check = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-label="Sim">
    <path d="M5 12.5l4.2 4.2L19 7" />
  </svg>
);

/** Célula da tabela: marca, texto ("até 2") ou traço quando o plano não tem. */

/** Ramo de louro dos selos do topo (espelhado do outro lado). */
function Laurel({ flip }: { flip?: boolean }) {
  return (
    <svg className="pr-laurel" viewBox="0 0 30 64" width="26" height="56" aria-hidden="true" style={flip ? { transform: "scaleX(-1)" } : undefined}>
      <path d="M22 60C10 52 5 38 8 22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      {[0, 1, 2, 3, 4].map((k) => (
        <ellipse key={k} cx={9 + k * 0.4} cy={52 - k * 9} rx="6" ry="2.6" fill="currentColor" transform={`rotate(${-48 + k * 6} ${9 + k * 0.4} ${52 - k * 9})`} />
      ))}
    </svg>
  );
}

/** Blocos com data-reveal sobem e aparecem quando entram na tela, uma vez só. */
function useReveal(root: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  useEffect(() => {
    const el = root.current;
    if (!el || reduced() || typeof IntersectionObserver === "undefined") return;
    el.classList.add("pr-reveal-on");
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          (e.target as HTMLElement).dataset.in = "";
          io.unobserve(e.target);
        }
      },
      { root: el, rootMargin: "0px 0px -8% 0px" },
    );
    for (const n of el.querySelectorAll<HTMLElement>("[data-reveal]:not([data-in])")) io.observe(n);
    return () => io.disconnect();
  }, deps);
}

/** Luz que segue o cursor dentro do cartão (só posição em variáveis CSS, sem re-render). */
const spot = (e: MouseEvent<HTMLElement>) => {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
};

export function PricingPage() {
  const nav = useNavigate();
  const root = useRef<HTMLDivElement>(null);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [signupMode, setSignupMode] = useState("invite");
  const [logged, setLogged] = useState(false);
  const [tab, setTab] = useState<"plans" | "packs">("plans");
  const [open, setOpen] = useState<number | null>(0);

  useEffect(() => {
    document.title = "Planos e preços · Planejai";
    api<{ signupMode: string; pricing?: Pricing }>("/api/auth/config").then(
      (c) => {
        setSignupMode(c.signupMode);
        if (c.pricing) setPricing(c.pricing);
      },
      () => {},
    );
    api("/api/auth/me").then(
      () => setLogged(true),
      () => {},
    );
  }, []);
  useReveal(root, [pricing, tab]);

  const closed = signupMode === "closed";
  const invite = signupMode === "invite";
  const start = logged ? "/plano" : closed ? "/login" : "/login?cadastro=1";
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    nav(e.currentTarget.getAttribute("href") ?? "/");
  };

  const plans = pricing?.plans ?? [];
  const packs = pricing?.packs ?? [];
  const welcome = pricing?.welcome ?? 0;
  const trial = pricing?.trialDays ?? 0;
  const trialTxt = trial > 0 ? `${trial} ${trial === 1 ? "dia" : "dias"} de uso livre` : "";
  const perMsg = pricing?.perMessage && pricing.perMessage > 0 ? pricing.perMessage : null;
  const msgs = (grains: number) => (perMsg ? `≈ ${int(roughly(grains / perMsg))} mensagens` : null);
  const cheapestPack = packs.length ? Math.min(...packs.map((k) => k.price / k.grains)) : null;
  const ref = pricing?.referral ?? { step: 0, max: 0 };

  const planCta = (p: Plan) => (logged ? `Escolher o ${p.name}` : invite ? "Tenho um convite" : welcome > 0 ? `Experimente com ${grainsTxt(welcome)}` : `Começar no ${p.name}`);

  const faq: [string, ReactNode][] = [
    ["O que é um grão?", "É o crédito do Planejai. Cada mensagem gasta alguns grãos, conforme o trabalho que deu: anotar um gasto gasta pouquinho, uma pesquisa longa gasta mais. Você vê o saldo e o extrato no painel."],
    [
      "Preciso pagar para começar?",
      welcome > 0
        ? `Não. Toda conta nova ${trial > 0 ? `usa à vontade por ${trialTxt} e depois ainda tem` : "ganha"} ${grainsTxt(welcome)} de presente, sem cartão. Quando acabarem, a IA pausa (o painel continua) até você assinar um plano ou comprar um pacote.`
        : "Você escolhe um plano ou um pacote avulso e já começa.",
    ],
    ["O que cada plano libera?", "Todos têm gastos, cartões, lembretes e agenda, no WhatsApp e no painel. O Dia a dia soma o time de agentes: pesquisa, menor preço, mensagens e recados, PDF, imagem e áudio, e até 2 especialistas da loja. O Completo libera tudo: até 6 especialistas, a Secretária de reuniões, Notion, GitHub e n8n, agentes feitos sob medida e voz caprichada. A tabela Compare os planos mostra item por item."],
    ["O que acontece se eu pedir algo que meu plano não tem?", "O assistente avisa com jeito, diz em qual plano aquilo entra e manda o link. Nada é cobrado nem fica pela metade."],
    ["Posso subir de plano no meio do mês?", "Pode. Você paga hoje só a diferença do mês e os grãos a mais entram assim que o pagamento cai. A partir daí a mensalidade é a do plano novo."],
    ["E descer de plano?", "Também. A troca vale a partir da próxima mensalidade e os grãos deste mês continuam com você. Quem usa um especialista que o plano novo não inclui fica pausado, e volta sozinho se você subir de novo."],
    ["O que sobra no fim do mês acumula?", "Os grãos do plano recarregam todo mês para a quantidade do plano, então o que sobrou não acumula. Os grãos de presente e os de pacotes avulsos não vencem."],
    ["Como eu pago?", "Cartão de crédito (renova sozinho), Pix ou boleto, na página de pagamento do Asaas. O cartão fica com o Asaas, não com a gente. Cancele quando quiser."],
  ];

  return (
    <div className="pr" ref={root}>
      <div className="pr-aurora" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
      </div>

      <header className="pr-nav">
        <div className="pr-wrap pr-nav-row">
          <a href="/" className="pr-logo" onClick={go} aria-label="Planejai, início">
            <Mascote size={32} mood="happy" still />
            <span>Planejai</span>
          </a>
          <nav className="pr-links" aria-label="Seções">
            <a href="/" onClick={go}>Início</a>
            <a href="/precos" className="on" aria-current="page" onClick={go}>Planos</a>
            <a href="#comparar">Comparar</a>
            <a href="#perguntas">Perguntas</a>
          </nav>
          <div className="pr-nav-cta">
            {logged ? (
              <a className="pr-btn" href="/plano" onClick={go}>Abrir o painel</a>
            ) : (
              <>
                <a className="pr-btn ghost" href="/login" onClick={go}>Entrar</a>
                {!closed && <a className="pr-btn pr-nav-main" href={start} onClick={go}>{invite ? "Tenho um convite" : "Começar"}</a>}
              </>
            )}
          </div>
        </div>
      </header>

      <section className="pr-hero pr-wrap">
        <h1 className="pr-title">
          {"Planos que cabem no seu dia".split(" ").map((w, i) => (
            <span key={i} style={{ ["--i" as string]: i } as CSSProperties}>{w}&nbsp;</span>
          ))}
        </h1>
        <p className="pr-sub">
          {welcome > 0 ? `Comece com ${trial > 0 ? `${trialTxt} e mais ` : ""}${grainsTxt(welcome)} de presente. Quando acabarem, assine um plano ou compre mais grãos.` : "Assine um plano ou compre grãos avulsos. Troque quando quiser."}
        </p>
        <div className="pr-badges">
          {welcome > 0 && (
            <div className="pr-badge" style={{ ["--i" as string]: 0 } as CSSProperties}>
              <Laurel />
              <div>
                <small>de presente</small>
                <b><CountUp to={welcome} duration={1.6} delay={0.3} /></b>
                <small>grãos para começar</small>
              </div>
              <Laurel flip />
            </div>
          )}
          <div className="pr-badge" style={{ ["--i" as string]: 1 } as CSSProperties}>
            <Laurel />
            <div>
              <small>cada plano mostra</small>
              <b>o que libera</b>
              <small>e o que não inclui</small>
            </div>
            <Laurel flip />
          </div>
          <div className="pr-badge" style={{ ["--i" as string]: 2 } as CSSProperties}>
            <Laurel />
            <div>
              <small>sem fidelidade</small>
              <b>cancele</b>
              <small>quando quiser</small>
            </div>
            <Laurel flip />
          </div>
        </div>
      </section>

      <section className="pr-wrap pr-shop" aria-label="Planos e pacotes">
        <div className="pr-shop-bar">
          <div>
            <p className="pr-hint">{tab === "plans" ? (cheapestPack && plans.length ? "No plano o grão sai mais barato que no avulso" : "Recarrega todo mês") : "Grãos avulsos não vencem"}</p>
            <div className="pr-toggle" role="tablist" aria-label="Tipo de compra" data-on={tab}>
              <span className="pr-thumb" aria-hidden="true" />
              <button role="tab" aria-selected={tab === "plans"} onClick={() => setTab("plans")}>Mensal</button>
              <button role="tab" aria-selected={tab === "packs"} onClick={() => setTab("packs")} disabled={!packs.length}>Avulso</button>
            </div>
          </div>
          <a className="pr-under" href="#subir">Como subir de plano</a>
        </div>

        {!pricing ? (
          <div className="pr-cards" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="pr-card pr-skel" />)}
          </div>
        ) : tab === "plans" ? (
          <div className="pr-cards" key="plans" data-n={plans.length + (welcome > 0 ? 1 : 0)}>
            {welcome > 0 && (
              <article className="pr-card" data-reveal style={{ ["--d" as string]: 0 } as CSSProperties} onMouseMove={spot}>
                <h2 className="pr-free">Grátis</h2>
                <p className="pr-amount">{trial > 0 ? `${trialTxt} + ${grainsTxt(welcome)}` : `${grainsTxt(welcome)} de presente`}</p>
                <p className="pr-note">{trial > 0 ? "Sem cartão. Depois dos dias livres, usa os grãos de presente" : (msgs(welcome) ?? "Uma vez, sem cartão")}</p>
                {!closed && (
                  <a className="pr-cta" href={start} onClick={go}>{logged ? "Ver meus grãos" : invite ? "Tenho um convite" : "Comece agora"}</a>
                )}
                <ul className="pr-perks">
                  {trial > 0 && <li style={{ ["--k" as string]: 0 } as CSSProperties}><PerkIcon i={0} />{`Tudo liberado nos primeiros ${trial === 1 ? "dia" : `${trial} dias`}, para conhecer o time`}</li>}
                  <li style={{ ["--k" as string]: 1 } as CSSProperties}><PerkIcon i={1} />{trial > 0 ? "Depois, gastos e agenda com os grãos de presente" : "Gastos, cartões, lembretes e agenda"}</li>
                  <li style={{ ["--k" as string]: 2 } as CSSProperties}><PerkIcon i={4} />{trial > 0 ? "Para usar o time inteiro, assine o Dia a dia ou o Completo" : "Usa até os grãos acabarem, sem prazo"}</li>
                </ul>
              </article>
            )}
            {plans.map((p, i) => (
              <article
                key={p.id}
                className={`pr-card ${p.highlight ? "hi" : ""}`}
                data-reveal
                style={{ ["--d" as string]: i + (welcome > 0 ? 1 : 0) } as CSSProperties}
                onMouseMove={spot}
              >
                {p.highlight && <span className="pr-tag">Mais escolhido</span>}
                <span className={`pr-chip c${i % 3}`}>{p.name}</span>
                <p className="pr-price">
                  <CountUp to={p.price} duration={1.1} delay={0.15 + i * 0.1} replay={tab} format={(n) => brl(n)} />
                  <span>/mês</span>
                </p>
                <p className="pr-amount">
                  <CountUp to={p.grains} duration={1.3} delay={0.25 + i * 0.1} replay={tab} /> grãos por mês
                </p>
                <p className="pr-note">{msgs(p.grains) ?? p.blurb}</p>
                {!closed && (
                  <a className={`pr-cta ${p.highlight ? "glow" : ""}`} href={start} onClick={go}>{planCta(p)}</a>
                )}
                <ul className="pr-perks">
                  {(p.perks?.length ? p.perks : [p.blurb]).map((x, k) => (
                    <li key={k} style={{ ["--k" as string]: k } as CSSProperties}><PerkIcon i={k} />{x}</li>
                  ))}
                  <li style={{ ["--k" as string]: (p.perks?.length ?? 1) } as CSSProperties}><PerkIcon i={3} />{per1000(p.price, p.grains)} por 1.000 grãos</li>
                </ul>
              </article>
            ))}
          </div>
        ) : (
          <div className="pr-cards" key="packs" data-n={packs.length}>
            {packs.map((k, i) => {
              const best = cheapestPack != null && k.price / k.grains === cheapestPack && packs.length > 1;
              return (
                <article key={k.id} className={`pr-card ${best ? "hi" : ""}`} data-reveal style={{ ["--d" as string]: i } as CSSProperties} onMouseMove={spot}>
                  {best && <span className="pr-tag">Melhor preço</span>}
                  <span className={`pr-chip c${i % 3}`}>{grainsTxt(k.grains)}</span>
                  <p className="pr-price">
                    <CountUp to={k.price} duration={1.1} delay={0.15 + i * 0.1} replay={tab} format={(n) => brl(n)} />
                    <span>uma vez</span>
                  </p>
                  <p className="pr-amount">{per1000(k.price, k.grains)} por 1.000 grãos</p>
                  <p className="pr-note">{msgs(k.grains) ?? "Entram assim que o pagamento cai"}</p>
                  {!closed && <a className={`pr-cta ${best ? "glow" : ""}`} href={start} onClick={go}>{logged ? "Comprar" : "Começar"}</a>}
                  <ul className="pr-perks">
                    <li style={{ ["--k" as string]: 0 } as CSSProperties}><PerkIcon i={4} />Não vencem</li>
                    <li style={{ ["--k" as string]: 1 } as CSSProperties}><PerkIcon i={0} />Somam com os grãos do plano</li>
                    <li style={{ ["--k" as string]: 2 } as CSSProperties}><PerkIcon i={3} />Pix, cartão ou boleto</li>
                  </ul>
                </article>
              );
            })}
          </div>
        )}
        <Includes features={pricing?.features} className="pr-foot" />
        <p className="pr-foot" data-reveal>A diferença entre os planos é só a quantidade de grãos: quanto maior o plano, mais barato sai cada grão.</p>
      </section>

      {plans.length > 0 && (
        <section id="comparar" className="pr-wrap pr-section">
          <h2 className="pr-h2" data-reveal>Compare os planos</h2>
          <div className="pr-table-wrap" data-reveal>
            <table className="pr-table">
              <thead>
                <tr>
                  <th scope="col"><span className="sr-only">Item</span></th>
                  {welcome > 0 && <th scope="col">Grátis</th>}
                  {plans.map((p) => <th key={p.id} scope="col" className={p.highlight ? "hi" : ""}>{p.name}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Preço</th>
                  {welcome > 0 && <td>R$ 0</td>}
                  {plans.map((p) => <td key={p.id} className={p.highlight ? "hi" : ""}>{brl(p.price)}/mês</td>)}
                </tr>
                <tr>
                  <th scope="row">Grãos</th>
                  {welcome > 0 && <td>{trial > 0 ? `${trialTxt} + ${int(welcome)}` : `${int(welcome)} uma vez`}</td>}
                  {plans.map((p) => <td key={p.id} className={p.highlight ? "hi" : ""}>{int(p.grains)} por mês</td>)}
                </tr>
                {perMsg && (
                  <tr>
                    <th scope="row">Mensagens, mais ou menos</th>
                    {welcome > 0 && <td>{int(roughly(welcome / perMsg))}</td>}
                    {plans.map((p) => <td key={p.id} className={p.highlight ? "hi" : ""}>{int(roughly(p.grains / perMsg))} por mês</td>)}
                  </tr>
                )}
                <tr>
                  <th scope="row">Preço de 1.000 grãos</th>
                  {welcome > 0 && <td>–</td>}
                  {plans.map((p) => <td key={p.id} className={p.highlight ? "hi" : ""}>{per1000(p.price, p.grains)}</td>)}
                </tr>
                {(pricing?.features ?? []).map((f) => (
                  <tr key={f.label}>
                    <th scope="row">{f.label}</th>
                    {welcome > 0 && <td><Check /></td>}
                    {plans.map((p) => <td key={p.id} className={p.highlight ? "hi" : ""}><Check /></td>)}
                  </tr>
                ))}
                <tr>
                  <th scope="row">Compra grãos avulsos quando precisar</th>
                  {welcome > 0 && <td><Check /></td>}
                  {plans.map((p) => <td key={p.id} className={p.highlight ? "hi" : ""}><Check /></td>)}
                </tr>
                <tr>
                  <th scope="row">Recarga automática todo mês</th>
                  {welcome > 0 && <td>–</td>}
                  {plans.map((p) => <td key={p.id} className={p.highlight ? "hi" : ""}><Check /></td>)}
                </tr>
                {ref.step > 0 && (
                  <tr>
                    <th scope="row">Desconto por amigo que assina</th>
                    {welcome > 0 && <td>–</td>}
                    {plans.map((p) => <td key={p.id} className={p.highlight ? "hi" : ""}>{ref.step}% cada, até {ref.max}%</td>)}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {welcome > 0 && trial > 0 && (
            <p className="pr-foot" data-reveal>
              Nos primeiros {trial === 1 ? "dia" : `${trial} dias`} da conta grátis tudo fica liberado, para você conhecer o time. Depois, quem não assina continua com gastos e agenda.
            </p>
          )}
        </section>
      )}

      <section id="subir" className="pr-wrap pr-section">
        <h2 className="pr-h2" data-reveal>Começa pequeno, sobe quando precisar</h2>
        <ol className="pr-steps">
          {[
            ["Comece de graça", welcome > 0 ? `${trial > 0 ? `${trialTxt} e ` : ""}${grainsTxt(welcome)} de presente para conhecer o time, sem cartão.` : "Escolha um plano ou um pacote avulso."],
            ["Assine um plano", "Todo mês os grãos do plano recarregam sozinhos. Cartão, Pix ou boleto."],
            ["Suba quando quiser", "Paga só a diferença do mês e os grãos a mais entram na hora. Em Plano e grãos, no painel."],
          ].map(([t, d], i) => (
            <li key={t} data-reveal style={{ ["--d" as string]: i } as CSSProperties}>
              <span className="pr-step-n">{i + 1}</span>
              <h3>{t}</h3>
              <p>{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section id="perguntas" className="pr-wrap pr-section pr-faq-sec">
        <h2 className="pr-h2" data-reveal>Perguntas</h2>
        <div className="pr-faq">
          {faq.map(([q, a], i) => (
            <div key={q} className={`pr-q ${open === i ? "open" : ""}`} data-reveal style={{ ["--d" as string]: i * 0.5 } as CSSProperties}>
              <button aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                {q}
                <span aria-hidden="true" />
              </button>
              <div className="pr-a">
                <div><p>{a}</p></div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="pr-wrap pr-end" data-reveal>
        <Mascote size={72} mood="happy" />
        <h2>{welcome > 0 ? `${grainsTxt(welcome)} esperando por você` : "Bora organizar o seu dia?"}</h2>
        {!closed && <a className="pr-cta glow big" href={start} onClick={go}>{logged ? "Abrir Plano e grãos" : invite ? "Tenho um convite" : "Criar minha conta"}</a>}
      </section>

      <footer className="pr-wrap pr-footer">
        <a href="/" onClick={go}>Planejai</a>
        <a href="/privacidade" onClick={go}>Privacidade e termos</a>
      </footer>
    </div>
  );
}

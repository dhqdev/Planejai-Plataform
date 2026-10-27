import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { MASCOTES } from "../mascote/nome";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { CORE_FACES } from "../faces";
import { Mascote, type Mood } from "../mascote/Mascote";
import { ClickSpark } from "../reactbits/ClickSpark";
import { CountUp } from "../reactbits/CountUp";
import { GlareHover } from "../reactbits/GlareHover";
import { ShinyText } from "../reactbits/ShinyText";
import { Spotlight } from "../reactbits/Spotlight";
import "../landing.css";
import { AppScenes, AppsOrbit, AppsRow } from "./LandingApps";
import { HeroChat, HeroTitle } from "./LandingHero";
import { TeamScroll } from "./LandingTeam";
import { Includes, type PlanFeature } from "../planFeatures";

/**
 * Landing pública (quem abre "/" sem estar logado). Curta e minimalista (pedido do David): a conversa do topo,
 * três cartões do que ele faz, a fila do time, um "sim" que dá para tocar com os apps embaixo, planos e perguntas. O movimento vem da rolagem: títulos palavra por palavra, blocos subindo, itens em cascata. Tudo aqui é verdade do produto: só cita o que um cliente comum já usa.
 * Efeitos do React Bits em ../reactbits (aviso de licença lá).
 */

interface Plan {
  id: string;
  name: string;
  price: number;
  grains: number;
  blurb: string;
  highlight?: boolean;
}

interface Pricing {
  enabled: boolean;
  plans: Plan[];
  features?: PlanFeature[];
  packs: { id: string; grains: number; price: number }[];
  welcome: number;
  grainsPerUsd: number;
  referral: { step: number; max: number };
}

interface Config {
  signupMode: string;
  /** Vitrine de planos e pacotes de grãos: vem sempre, mesmo com a cobrança desligada (para o dono ver como fica). */
  pricing?: Pricing;
}

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Liga quando o elemento aparece na tela (e desliga quando sai), para nada animar escondido. */
function useInView<T extends Element>(margin = "0px") {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setInView(true);
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return [ref, inView] as const;
}

/**
 * Rolagem: grava no .lp a posição (--sp, 0 a 1), quanto do topo já saiu (--hero) e a inclinação pela
 * velocidade (--lean). O CSS usa isso para o parallax do topo, a barra de progresso e o Mascote que acompanha.
 * Sem estado do React: nada renderiza de novo enquanto rola.
 */
function useScrollVars(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || reduced()) return;
    let raf = 0;
    let last = el.scrollTop;
    let lastT = performance.now();
    let calm: ReturnType<typeof setTimeout>;
    const update = () => {
      raf = 0;
      const y = el.scrollTop;
      const now = performance.now();
      const v = (y - last) / Math.max(16, now - lastT);
      last = y;
      lastT = now;
      el.style.setProperty("--sp", (y / Math.max(1, el.scrollHeight - el.clientHeight)).toFixed(4));
      el.style.setProperty("--hero", Math.min(1, y / (el.clientHeight * 0.8)).toFixed(4));
      el.style.setProperty("--lean", `${Math.max(-16, Math.min(16, v * 7)).toFixed(1)}deg`);
      clearTimeout(calm);
      calm = setTimeout(() => el.style.setProperty("--lean", "0deg"), 140);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
      clearTimeout(calm);
    };
  }, [root]);
}

/** Blocos com data-reveal sobem e aparecem quando entram na tela, uma vez só. */
function useReveal(root: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el || reduced() || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          // atributo, não classe: o React reescreve className quando o bloco muda de estado
          (e.target as HTMLElement).dataset.in = "";
          io.unobserve(e.target);
        }
      },
      { root: el, rootMargin: "0px 0px -12% 0px" },
    );
    const watch = () => {
      for (const n of el.querySelectorAll<HTMLElement>("[data-reveal]:not([data-in])")) io.observe(n);
    };
    watch();
    // seções que chegam depois (planos vêm de /api/auth/config) também precisam aparecer
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true, subtree: true });
    el.classList.add("reveal-on");
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [root]);
}

/** O que o Mascote que acompanha a rolagem diz e sente em cada parte da página. */
const BUDDY: Record<string, { mood: Mood; say: string }> = {
  "como-funciona": { mood: "curious", say: "Olha só." },
  time: { mood: "happy", say: "Esse é o meu time!" },
  apps: { mood: "curious", say: "Tudo junto." },
  seguranca: { mood: "wink", say: "Toca no sim." },
  planos: { mood: "finished", say: "Cabe no bolso." },
  perguntas: { mood: "thinking", say: "Ficou dúvida?" },
};

/**
 * Mascote que acompanha a rolagem: assume quando o do topo sai da tela, inclina com a velocidade,
 * pula e muda de cara a cada seção e sai de cena quando chega o rodapé.
 */
function Buddy({ root }: { root: RefObject<HTMLDivElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [part, setPart] = useState<string | null>(null);

  useEffect(() => {
    const el = root.current;
    const b = box.current;
    if (!el || !b) return;
    const end = el.querySelector(".lp-foot");
    const check = () => {
      const past = el.scrollTop > el.clientHeight * 0.7;
      const ending = end ? end.getBoundingClientRect().top < el.clientHeight - 20 : false;
      b.dataset.show = past && !ending ? "1" : "0";
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    let io: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) if (e.isIntersecting) setPart(e.target.id);
        },
        { root: el, rootMargin: "-45% 0px -45% 0px" },
      );
      for (const id of Object.keys(BUDDY)) {
        const s = el.querySelector(`#${id}`);
        if (s) io.observe(s);
      }
    }
    return () => {
      el.removeEventListener("scroll", check);
      io?.disconnect();
    };
  }, [root]);

  useEffect(() => {
    if (!part || reduced()) return;
    body.current?.animate(
      [{ transform: "none" }, { transform: "translateY(-14px) scale(1.06, .94)" }, { transform: "translateY(2px) scale(.96, 1.04)" }, { transform: "none" }],
      { duration: 520, easing: "cubic-bezier(.34, 1.56, .64, 1)" },
    );
  }, [part]);

  const now = part ? BUDDY[part] : null;
  return (
    <div className="lp-buddy" ref={box} data-show="0" aria-hidden="true">
      {now && (
        <span className="lp-buddy-say" key={part}>
          {now.say}
        </span>
      )}
      <div className="lp-buddy-body" ref={body}>
        <Mascote size={80} mood={now?.mood ?? "happy"} />
      </div>
    </div>
  );
}

/** Clique em Entrar/Criar conta: uma onda pequena só dentro do botão e já troca para o login. */
function useTap() {
  const nav = useNavigate();
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    const a = e.currentTarget;
    const href = a.getAttribute("href") ?? "/login";
    if (reduced()) return nav(href);
    const r = a.getBoundingClientRect();
    a.style.setProperty("--rx", `${(e.clientX || r.left + r.width / 2) - r.left}px`);
    a.style.setProperty("--ry", `${(e.clientY || r.top + r.height / 2) - r.top}px`);
    a.classList.remove("lp-ripple");
    void a.offsetWidth;
    a.classList.add("lp-ripple");
    setTimeout(() => nav(href), 220);
  };
  return { go };
}


const reply = (typing: boolean, text: string) =>
  typing ? (
    <div className="lp-bubble bot lp-typing" aria-hidden="true">
      <i />
      <i />
      <i />
    </div>
  ) : (
    <div className="lp-bubble bot">{text}</div>
  );

/** "Nada sai sem o seu sim": um pedido de confirmação de verdade, com Sim e Não que dá para tocar. */
function Confirm() {
  const [answer, setAnswer] = useState<"sim" | "não" | null>(null);
  const [typing, setTyping] = useState(false);
  const say = (a: "sim" | "não") => {
    setAnswer(a);
    if (reduced()) return;
    setTyping(true);
    setTimeout(() => setTyping(false), 700);
  };
  return (
    <div className="lp-confirm" data-reveal style={{ ["--d" as string]: 1 }}>
      <div className="lp-confirm-chat" aria-live="polite">
        <div className="lp-bubble me">pergunta no petshop se tem banho às 18h</div>
        <div className="lp-bubble bot">
          Vou mandar pro Petshop: “Oi! Tem horário de banho hoje às 18h?” <b>Posso enviar?</b>
        </div>
        {answer && <div className="lp-bubble me">{answer}</div>}
        {answer && reply(typing, answer === "sim" ? "Enviado! Te aviso quando responderem." : "Tudo bem, não mandei nada.")}
      </div>
      <div className="lp-confirm-act">
        {answer ? (
          <button type="button" className="lp-chip-btn" onClick={() => setAnswer(null)}>
            Ver de novo
          </button>
        ) : (
          <>
            <button type="button" className="lp-chip-btn yes" onClick={() => say("sim")}>
              Sim
            </button>
            <button type="button" className="lp-chip-btn" onClick={() => say("não")}>
              Não
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Título que entra palavra por palavra quando aparece na tela: cada palavra sobe de dentro de uma máscara,
 * com 60ms entre uma e outra. Leitor de tela lê a frase inteira.
 */
function Words({ text, className }: { text: string; className?: string }) {
  return (
    <h2 className={`${className ?? ""} lp-words`} data-reveal aria-label={text}>
      {text.split(" ").map((w, i) => (
        <Fragment key={`${w}${i}`}>
          {i > 0 && " "}
          <span aria-hidden="true">
            <span style={{ ["--w" as string]: i }}>{w}</span>
          </span>
        </Fragment>
      ))}
    </h2>
  );
}

/** Um recurso: a cena animada em cima e o nome embaixo. A cena roda só enquanto aparece. */
function Feature({ title, label, children, d = 0 }: { title: string; label: string; children: ReactNode; d?: number }) {
  const [ref, inView] = useInView<HTMLDivElement>("-10% 0px");
  return (
    <div ref={ref} className="lp-feat" data-reveal style={{ ["--d" as string]: d }}>
      <GlareHover className="lp-feat-in" glareColor="#ffffff" glareOpacity={0.55} glareSize={260} transitionDuration={800} playOnce>
        <div className={`lp-clip ${inView ? "play" : ""}`} role="img" aria-label={label}>
          {children}
        </div>
        <h3>{title}</h3>
      </GlareHover>
    </div>
  );
}

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const grainsTxt = (n: number) => `${n.toLocaleString("pt-BR")} ${n === 1 ? "grão" : "grãos"}`;

/** Planos por grãos (crédito que o uso de IA desconta). A vitrine vem de pricing em /api/auth/config. */
function Plans({ pricing, cta, go, closed }: { pricing: Pricing; cta: (p: Plan) => string; go: (e: MouseEvent<HTMLAnchorElement>) => void; closed: boolean }) {
  const { plans, packs, welcome, referral } = pricing;
  const row = useRef<HTMLDivElement>(null);
  // no celular os planos correm de lado: começa no recomendado
  useEffect(() => {
    const el = row.current;
    const hi = el?.querySelector<HTMLElement>(".lv-plan-wrap.hi");
    if (el && hi && el.scrollWidth > el.clientWidth) el.scrollLeft = hi.offsetLeft - 16;
  }, []);
  const facts = [
    ...(welcome > 0 ? [`${grainsTxt(welcome)} de presente`] : []),
    "Cartão, Pix ou boleto",
    "Troque de plano quando quiser",
    "Cancele quando quiser",
    ...(referral.step > 0 ? [`Indique e ganhe até ${referral.max}% off`] : []),
  ];

  return (
    <section id="planos" className="lp-section lv-plans-sec">
      <div className="lp-wrap">
        <h2 className="lp-h2" data-reveal>
          Pague pelo que usa.
        </h2>
        <p className="lp-sub" data-reveal style={{ ["--d" as string]: 1 }}>
          Todo plano tem tudo liberado. Grão é o crédito: cada pedido gasta um pouquinho, e quanto maior o plano, mais barato sai.
        </p>

        <div className="lv-plans" ref={row}>
          {plans.map((p, i) => (
            <div key={p.id} className={`lv-plan-wrap ${p.highlight ? "hi" : ""}`} data-reveal style={{ ["--d" as string]: i }}>
              <GlareHover className={`lv-plan ${p.highlight ? "hi" : ""}`} glareColor="#ffffff" glareOpacity={p.highlight ? 0.18 : 0.6} playOnce>
                <h3>{p.name}</h3>
                {p.highlight && <span className="lv-plan-tag">Mais escolhido</span>}
                <p className="lv-plan-price">
                  <b>{brl(p.price)}</b>
                  <span>/mês</span>
                </p>
                <p className="lv-plan-grains">
                  <CountUp to={p.grains} duration={1.3} delay={0.2 + i * 0.12} /> grãos
                </p>
                <p className="lv-plan-blurb">{p.blurb}</p>
                {!closed && (
                  <a className={`lp-btn ${p.highlight ? "light" : "ghost"}`} href="/login?cadastro=1" onClick={go}>
                    {cta(p)}
                  </a>
                )}
              </GlareHover>
            </div>
          ))}
        </div>

        <Includes features={pricing.features} className="lv-includes" />

        <ul className="lv-facts" data-reveal>
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>

        <p className="lv-more" data-reveal>
          <a className="lp-link" href="/precos" onClick={go}>
            Ver planos, pacotes e o que cada um dá
          </a>
        </p>

        {packs.length > 0 && (
          <div className="lv-packs" data-reveal>
            <b>Acabou antes do mês? Pacotes avulsos, que não vencem:</b>
            <ul>
              {packs.map((k) => (
                <li key={k.id}>
                  <span>{grainsTxt(k.grains)}</span>
                  <b>{brl(k.price)}</b>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

export function LandingPage() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [scene, setScene] = useState(0);
  const [open, setOpen] = useState<number | null>(0);
  const root = useRef<HTMLDivElement>(null);
  const { go } = useTap();
  useScrollVars(root);
  useReveal(root);

  useEffect(() => {
    api<Config>("/api/auth/config").then(setCfg, () => {});
    document.title = "Planejai: seu assistente pessoal no WhatsApp";
  }, []);

  const invite = (cfg?.signupMode ?? "invite") === "invite";
  const closed = cfg?.signupMode === "closed";
  const cta = invite ? "Tenho um convite" : "Criar minha conta";
  const pricing = cfg?.pricing?.plans?.length ? cfg.pricing : null;
  const cto = CORE_FACES.cto?.persona ?? "o CTO";

  const faq: [string, ReactNode][] = [
    ["Preciso instalar algum app?", "Não. É no WhatsApp (ou no Telegram). O painel abre no navegador."],
    [
      "Como eu começo?",
      invite
        ? "É só por convite: peça o link ou o código de quem já usa e toque em Tenho um convite."
        : closed
          ? "Os cadastros estão fechados agora. Se você já tem conta, é só entrar."
          : "Crie a conta com nome, e-mail e WhatsApp. Em um minuto ele já está te respondendo.",
    ],
    ["Ele mexe no meu dinheiro?", "Não. Ele anota e organiza. O que envolve dinheiro, outra pessoa ou apagar algo espera o seu sim."],
    ["E se eu quiser apagar tudo?", "Peça no WhatsApp ou apague a conta no painel. Some tudo, de vez."],
  ];

  const primary = (big?: boolean) =>
    !closed && (
      <ClickSpark sparkColor="#6510e0" sparkCount={9} sparkRadius={22}>
        <a className={`lp-btn ${big ? "big" : ""}`} href="/login?cadastro=1" onClick={go}>
          {cta}
        </a>
      </ClickSpark>
    );

  return (
    <div className="lp" ref={root}>
      <Buddy root={root} />
      <header className="lp-nav">
        <span className="lp-progress" aria-hidden="true" />
        <div className="lp-wrap lp-nav-row">
          <a href="/" className="lp-logo" aria-label="Planejai, início">
            <Mascote size={34} mood="happy" still />
            <span>Planejai</span>
          </a>
          <nav className="lp-links" aria-label="Seções">
            <a href="#apps">Apps</a>
            <a href="#como-funciona">Como funciona</a>
            <a href="#time">O time</a>
            {pricing && (
              <a href="/precos" onClick={go}>
                Planos
              </a>
            )}
            <a href="#perguntas">Perguntas</a>
            <a href="/blog">Blog</a>
          </nav>
          <div className="lp-nav-cta">
            <a className="lp-btn ghost" href="/login" onClick={go}>
              Entrar
            </a>
            {!closed && (
              <a className="lp-btn lp-nav-main" href="/login?cadastro=1" onClick={go}>
                {cta}
              </a>
            )}
          </div>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <Spotlight className="lp-hero-bg">
            <div className="lp-wrap lp-hero-grid">
              <div className="lp-hero-copy">
                <span className="lp-eyebrow">
                  <i className="lp-live" aria-hidden="true" />
                  <ShinyText>Um time de assistentes no seu WhatsApp</ShinyText>
                </span>
                <HeroTitle scene={scene} />
                <p className="lp-lead">
                  Anota seus gastos, lembra dos compromissos, pesquisa e fala com lojas por você. <span>É só mandar mensagem.</span>
                </p>
                <div className="lp-hero-cta">
                  {primary(true)}
                  <a className="lp-link" href="/login" onClick={go}>
                    Já tenho conta
                  </a>
                </div>
                <AppsRow />
              </div>
              <div className="lp-hero-stage">
                <HeroChat scene={scene} onScene={setScene} />
              </div>
            </div>
          </Spotlight>
        </section>

        <section id="apps" className="lp-section la-sec">
          <div className="lp-wrap la-wrap">
            <div className="la-head">
              <Words className="lp-h2" text="Conecta com o que você já usa." />
              <p className="lp-sub" data-reveal style={{ ["--d" as string]: 2 }}>
                Você conecta uma vez. Ele usa quando precisa.
              </p>
            </div>
            <div data-reveal style={{ ["--d" as string]: 1 }}>
              <AppsOrbit />
            </div>
          </div>
          <div className="lp-wrap">
            <AppScenes />
          </div>
        </section>

        <section id="como-funciona" className="lp-section">
          <div className="lp-wrap">
            <Words className="lp-h2" text="Fala do seu jeito. Ele organiza." />

            <div className="lp-feats">
              <Feature title="Gastos que se anotam sozinhos" label="Lançamentos aparecendo um a um, separados por categoria">
                <div className="lp-card lp-tx">
                  {[
                    ["Mercado", "Alimentação", "R$ 42,90"],
                    ["Drogaria", "Saúde", "R$ 37,50"],
                    ["Uber", "Transporte", "R$ 30,00"],
                  ].map(([n, c, v], i) => (
                    <div key={n} className="lp-tx-row" style={{ ["--i" as string]: i }}>
                      <span className="lp-tx-dot" />
                      <span>
                        <b>{n}</b>
                        <small>{c}</small>
                      </span>
                      <b>{v}</b>
                    </div>
                  ))}
                </div>
              </Feature>

              <Feature title="Lembretes na hora certa" label="Notificações de lembrete chegando no celular" d={1}>
                <div className="lp-notifs">
                  {[
                    ["happy", "Ana, deu 15 minutos: tira o bolo do forno!"],
                    ["wink", "Hoje vence a luz, R$ 186,32."],
                  ].map(([m, t], i) => (
                    <div key={t} className="lp-notif" style={{ ["--i" as string]: i }}>
                      <Mascote size={30} still mood={m as Mood} />
                      <span>
                        <b>Planejai</b>
                        <small>{t}</small>
                      </span>
                    </div>
                  ))}
                </div>
              </Feature>

              <Feature title="De olho no preço" label="Aviso de queda de preço de um produto" d={2}>
                <div className="lp-card lp-watch">
                  <div className="lp-watch-item">
                    <span className="lp-watch-img" />
                    <span>
                      <b>Air fryer 5 litros</b>
                      <small>Mercado Livre</small>
                    </span>
                  </div>
                  <div className="lp-price">
                    <s>R$ 459,90</s>
                    <b>
                      <CountUp from={459.9} to={389.9} duration={1.4} delay={0.7} format={brl} />
                    </b>
                  </div>
                  <div className="lp-drop">Baixou R$ 70,00. Quer o link?</div>
                </div>
              </Feature>
            </div>
          </div>
        </section>

        <section id="time" className="lp-section">
          <div className="lp-wrap">
            <Words className="lp-h2" text={`Um time de ${MASCOTES} por trás.`} />
            <p className="lp-sub" data-reveal style={{ ["--d" as string]: 2 }}>
              Você fala com o {cto}. Ele chama quem precisa.
            </p>
            <TeamScroll />
          </div>
        </section>

        <section id="seguranca" className="lp-section">
          <div className="lp-wrap lp-safe">
            <div>
              <Words className="lp-h2" text="Nada sai sem o seu sim." />
              <ul className="lp-safe-list" data-reveal style={{ ["--d" as string]: 2 }}>
                <li>Seus dados são só seus</li>
                <li>Apague tudo quando quiser</li>
                <li>Tudo à vista no seu painel</li>
              </ul>
            </div>
            <Confirm />
          </div>
        </section>

        {pricing && <Plans pricing={pricing} closed={closed} go={go} cta={(p) => (invite ? cta : `Começar no ${p.name}`)} />}

        <LandingBlog />

        <section id="perguntas" className="lp-section">
          <div className="lp-wrap lp-faq-wrap">
            <h2 className="lp-h2" data-reveal>
              Perguntas rápidas
            </h2>
            <div className="lp-faq" data-reveal style={{ ["--d" as string]: 1 }}>
              {faq.map(([q, a], i) => (
                <div key={q} className={`lp-q ${open === i ? "open" : ""}`}>
                  <button type="button" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                    {q}
                    <span className="lp-plus" aria-hidden="true" />
                  </button>
                  <div className="lp-a">
                    <p>{a}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-row">
          <span className="lp-logo">
            <Mascote size={26} still mood="happy" />
            <span>Planejai</span>
          </span>
          <span className="lp-foot-links">
            <a href="/login" onClick={go}>
              Entrar
            </a>
            <a href="/blog">Blog</a>
            <a href="/privacidade">Termos e privacidade</a>
          </span>
          <small>Seu assistente pessoal no WhatsApp.</small>
        </div>
      </footer>
    </div>
  );
}

interface BlogCard {
  slug: string;
  title: string;
  category: string;
  cover: string | null;
  reading_minutes: number;
}

/** Os três posts mais novos do blog, com a capa. Sem post publicado, a seção some. */
function LandingBlog() {
  const [posts, setPosts] = useState<BlogCard[]>([]);
  useEffect(() => {
    api<{ posts: BlogCard[] }>("/api/blog/posts").then((r) => setPosts(r.posts.slice(0, 3)), () => {});
  }, []);
  if (!posts.length) return null;
  return (
    <section id="blog" className="lp-section">
      <div className="lp-wrap">
        <div className="lp-blog-head">
          <Words className="lp-h2" text="Do nosso blog." />
          <a className="lp-btn ghost" href="/blog">
            Ver o blog
          </a>
        </div>
        <div className="lp-blog" data-reveal style={{ ["--d" as string]: 2 }}>
          {posts.map((p) => (
            <a key={p.slug} className="lp-blog-card" href={`/blog/${p.slug}`}>
              <span className="lp-blog-cover">
                {p.cover ? <img src={p.cover} alt="" loading="lazy" decoding="async" /> : <Mascote size={64} mood="happy" still />}
              </span>
              <small>
                {p.category} · {p.reading_minutes} min
              </small>
              <strong>{p.title}</strong>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

import { useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { CORE_FACES } from "../faces";
import { Mochi, type Mood } from "../mochi/Mochi";
import { ClickSpark } from "../reactbits/ClickSpark";
import { CountUp } from "../reactbits/CountUp";
import { GlareHover } from "../reactbits/GlareHover";
import { LogoLoop } from "../reactbits/LogoLoop";
import { ShinyText } from "../reactbits/ShinyText";
import { Spotlight } from "../reactbits/Spotlight";
import "../landing.css";
import { HeroChat, HeroTitle } from "./LandingHero";
import { TeamStage, type StageAgent } from "./TeamStage";

/**
 * Landing pública (quem abre "/" sem estar logado). Pouco texto e muita coisa acontecendo: a conversa do topo,
 * pedidos correndo numa faixa, cartões que se animam, o time em cena, um "sim" que dá para tocar, os apps
 * correndo na noite do Mochi e os planos. Tudo aqui é verdade do produto: só cita o que um cliente comum já usa.
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
 * velocidade (--lean). O CSS usa isso para o parallax do topo, a barra de progresso e o Mochi que acompanha.
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

/** O que o Mochi que acompanha a rolagem diz e sente em cada parte da página. */
const BUDDY: Record<string, { mood: Mood; say: string }> = {
  "como-funciona": { mood: "curious", say: "Olha só." },
  time: { mood: "happy", say: "Esse é o meu time!" },
  seguranca: { mood: "wink", say: "Toca no sim." },
  integracoes: { mood: "wink", say: "Me dou bem com todo mundo." },
  planos: { mood: "finished", say: "Cabe no bolso." },
  perguntas: { mood: "thinking", say: "Ficou dúvida?" },
};

/**
 * Mochi que acompanha a rolagem: assume quando o do topo sai da tela, inclina com a velocidade,
 * pula e muda de cara a cada seção e sai de cena quando chega o Mochi grande do final.
 */
function Buddy({ root }: { root: RefObject<HTMLDivElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [part, setPart] = useState<string | null>(null);

  useEffect(() => {
    const el = root.current;
    const b = box.current;
    if (!el || !b) return;
    const end = el.querySelector(".lp-final");
    const check = () => {
      const past = el.scrollTop > el.clientHeight * 0.7;
      const ending = end ? end.getBoundingClientRect().top < el.clientHeight * 0.75 : false;
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
        <Mochi size={80} mood={now?.mood ?? "happy"} />
      </div>
    </div>
  );
}

/**
 * Clique em Entrar/Criar conta: onda no botão, a tela se cobre de roxo a partir do dedo com o Mochi
 * pulando no meio, troca para o login e o roxo se desfaz por cima dele.
 */
function useCurtain() {
  const nav = useNavigate();
  const [veil, setVeil] = useState<{ x: number; y: number } | null>(null);
  const node = useRef<HTMLDivElement>(null);
  const go = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    const a = e.currentTarget;
    const href = a.getAttribute("href") ?? "/login";
    if (reduced()) return nav(href);
    const r = a.getBoundingClientRect();
    const x = e.clientX || r.left + r.width / 2;
    const y = e.clientY || r.top + r.height / 2;
    a.style.setProperty("--rx", `${x - r.left}px`);
    a.style.setProperty("--ry", `${y - r.top}px`);
    a.classList.remove("lp-ripple");
    void a.offsetWidth;
    a.classList.add("lp-ripple");
    setVeil({ x, y });
    setTimeout(() => {
      // a cortina vive fora da landing para continuar na tela depois da troca de rota
      const keep = node.current?.cloneNode(true) as HTMLElement | undefined;
      if (keep) {
        document.body.appendChild(keep);
        keep.classList.add("out");
        setTimeout(() => keep.remove(), 800);
      }
      nav(href);
    }, 700);
  };
  const curtain = veil
    ? createPortal(
        <div ref={node} className="lp-veil" style={{ ["--x" as string]: `${veil.x}px`, ["--y" as string]: `${veil.y}px` }} aria-hidden="true">
          <span className="lp-veil-wave a" />
          <span className="lp-veil-wave b" />
          <span className="lp-veil-wave c" />
          <span className="lp-veil-glow" />
        </div>,
        document.body,
      )
    : null;
  return { go, curtain };
}

/** Pedidos de verdade, correndo numa faixa logo abaixo do topo. */
const ASKS = [
  "gastei 30 no uber",
  "me lembra de ligar pra minha mãe às 19h",
  "qual a farmácia aberta mais perto?",
  "quanto gastei com mercado esse mês?",
  "avisa se a air fryer baixar de 400",
  "toda segunda às 7h, academia",
  "resume meus e-mails de hoje",
  "o que eu tenho amanhã?",
];
/** Segunda faixa, correndo ao contrário. */
const ASKS_2 = [
  "pergunta no petshop se tem banho às 18h",
  "divide a conta do jantar em 4",
  "manda um bom dia pro Gio às 7h",
  "tem Duna hoje no Iguatemi?",
  "anota: 1.200 de aluguel todo dia 5",
  "me manda isso em áudio",
  "faz um PDF com o resumo do livro",
  "qual o melhor horário pra academia amanhã?",
];

/** O que cada um faz, em poucas palavras (a cena do TeamStage mostra o resto). O nome vem de CORE_FACES. */
const TEAM: StageAgent[] = [
  { id: "cto", role: "Conversa com você", asks: ["qual a farmácia mais perto?"] },
  { id: "financeiro", role: "Cuida do dinheiro", asks: ["gastei 42 no almoço"] },
  { id: "agenda", role: "Cuida do seu tempo", asks: ["toda segunda às 7h, academia"] },
  { id: "pesquisador", role: "Procura por você", asks: ["avisa se o iPhone baixar de 4 mil"] },
  { id: "recados", role: "Fala com quem precisa", asks: ["vê se o petshop tem banho às 18h"] },
  { id: "comunicacao", role: "E-mail e Slack", asks: ["resume meus e-mails de hoje"] },
  { id: "produtividade", role: "Automatiza o resto", asks: ["todo dia às 8h, a previsão"] },
];

/**
 * Apps que ele usa por você. Só o que existe de verdade: as contas pessoais que o cliente conecta em Minha conta
 * (PERSONAL_INTEGRATIONS no servidor) e o que já vem pronto para todo mundo. O n8n é do dono e não entra aqui.
 */
interface App {
  id: string;
  name: string;
  ask: string;
  reply: string;
  ready?: boolean;
}

const APPS: App[] = [
  { id: "agenda", name: "Google Agenda", ask: "marca dentista quinta às 15h", reply: "Marquei no seu Google Agenda: Dentista, quinta, 15h." },
  { id: "gmail", name: "Gmail", ask: "resume meus e-mails de hoje", reply: "Chegaram 7. Dois pedem resposta: o boleto do condomínio e a Carla." },
  { id: "notion", name: "Notion", ask: "anota no Notion as ideias da reunião", reply: "Criei a página Ideias da reunião com os 4 pontos." },
  { id: "slack", name: "Slack", ask: "avisa no #obra que a entrega ficou pra segunda", reply: "Vou mandar no #obra: “A entrega ficou para segunda.” Posso?" },
  { id: "github", name: "GitHub", ask: "abre uma issue: o botão de pagar sumiu", reply: "Abri a issue #128: Botão de pagar some no celular." },
  { id: "linear", name: "Linear", ask: "cria tarefa: revisar o contrato até sexta", reply: "Criei a ENG-42: Revisar o contrato até sexta." },
  { id: "mpago", name: "Mercado Pago", ask: "gera um link de 150 reais da aula", reply: "Link de R$ 150,00 para Aula de violão. Posso gerar?" },
  { id: "mlivre", name: "Mercado Livre", ask: "acha uma air fryer até 400 reais", reply: "Achei 3 com frete grátis. A mais barata: R$ 389,90.", ready: true },
  { id: "maps", name: "Google Maps", ask: "qual ônibus eu pego pro centro?", reply: "Pega o 332 na esquina, uns 25 minutos. Te mandei o mapa.", ready: true },
  { id: "telegram", name: "Telegram", ask: "oi, agora tô por aqui", reply: "Oi, Ana! Seus gastos e lembretes estão todos comigo.", ready: true },
];

/** Marcas simples, de traço, desenhadas aqui (nada de logotipo copiado): sugerem o app sem imitar a marca. */
const GLYPHS: Record<string, ReactNode> = {
  agenda: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="3" />
      <path d="M3.5 10h17M8 3v4M16 3v4M8 14h3v3H8z" />
    </>
  ),
  gmail: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="3" />
      <path d="m4 7.5 8 6 8-6" />
    </>
  ),
  notion: (
    <>
      <path d="M6 3.5h8.5l4 4v13H6z" />
      <path d="M14.5 3.5v4h4M9 12h6.5M9 15.5h4.5" />
    </>
  ),
  slack: <path d="M10 4 8 20M16 4l-2 16M5 9.5h15M4 14.5h15" />,
  github: (
    <>
      <circle cx="7" cy="5.5" r="2" />
      <circle cx="7" cy="18.5" r="2" />
      <circle cx="17" cy="7.5" r="2" />
      <path d="M7 7.5v9M17 9.5v.5a4 4 0 0 1-4 4h-2a4 4 0 0 0-4 4" />
    </>
  ),
  linear: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.3 2.4 2.4 4.7-5" />
    </>
  ),
  mpago: (
    <>
      <rect x="3" y="6" width="18" height="12.5" rx="3" />
      <path d="M3 10.5h18M7 15h4" />
    </>
  ),
  mlivre: (
    <>
      <path d="M4 4.5h7l9 9-6.5 6.5-9-9z" />
      <circle cx="8.3" cy="8.8" r="1.4" />
    </>
  ),
  maps: (
    <>
      <path d="M12 21s-6.5-5.9-6.5-11a6.5 6.5 0 0 1 13 0c0 5.1-6.5 11-6.5 11z" />
      <circle cx="12" cy="10" r="2.4" />
    </>
  ),
  telegram: <path d="M20.5 4 3.5 10.8l6 2.2 2.2 6.5 3-4.2 4.6 3.4zM9.5 13 20.5 4" />,
};

function Glyph({ id }: { id: string }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[id]}
    </svg>
  );
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

/**
 * Apps: a faixa corre (LogoLoop) e cada app nela é um botão; embaixo, o pedido e a resposta do escolhido.
 * Troca sozinho enquanto aparece, até a pessoa tocar num app.
 */
function Connects() {
  const [sel, setSel] = useState(0);
  const [typing, setTyping] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [ref, inView] = useInView<HTMLDivElement>();
  const first = useRef(true);
  const app = APPS[sel]!;

  useEffect(() => {
    if (pinned || !inView || reduced()) return;
    const t = setTimeout(() => setSel((i) => (i + 1) % APPS.length), 4200);
    return () => clearTimeout(t);
  }, [sel, pinned, inView]);

  // a cada troca a resposta passa pelo "digitando", como na conversa do topo
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (reduced()) return;
    setTyping(true);
    const t = setTimeout(() => setTyping(false), 750);
    return () => clearTimeout(t);
  }, [sel]);

  return (
    <div ref={ref}>
      <LogoLoop
        className="lv-loop"
        items={APPS}
        itemKey={(a) => a.id}
        speed={34}
        gap={10}
        ariaLabel="Apps que ele usa: toque num para ver"
        renderItem={(a, copy) => (
          <button
            type="button"
            className="lv-app"
            aria-pressed={a.id === app.id}
            tabIndex={copy > 0 ? -1 : 0}
            onClick={() => {
              setPinned(true);
              setSel(APPS.indexOf(a));
            }}
          >
            <span className="lv-glyph">
              <Glyph id={a.id} />
            </span>
            <b>{a.name}</b>
          </button>
        )}
      />
      <div className="lp-wrap">
        <div className="lv-talk" aria-live="polite" data-reveal>
          <div className="lv-talk-top">
            <span className="lp-phone-avatar">
              <Mochi size={30} still mood="happy" />
            </span>
            <span>
              <strong>Planejai</strong>
              <small>{typing ? "digitando…" : `usando o ${app.name}`}</small>
            </span>
            <span className="lv-talk-tag">{app.ready ? "já vem pronto" : "sua conta"}</span>
          </div>
          <div className="lv-talk-chat" key={app.id}>
            <div className="lp-bubble me">{app.ask}</div>
            {reply(typing, app.reply)}
          </div>
        </div>
      </div>
    </div>
  );
}

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

/** Um recurso: a cena animada em cima e o nome embaixo. A cena roda só enquanto aparece. */
function Feature({ title, label, children, wide, d = 0 }: { title: string; label: string; children: ReactNode; wide?: boolean; d?: number }) {
  const [ref, inView] = useInView<HTMLDivElement>("-10% 0px");
  return (
    <div ref={ref} className={`lp-feat ${wide ? "wide" : ""}`} data-reveal style={{ ["--d" as string]: d }}>
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
          Grão é o crédito: cada pedido gasta um pouquinho.
        </p>

        <div className="lv-plans" ref={row}>
          {plans.map((p, i) => (
            <div key={p.id} className={`lv-plan-wrap ${p.highlight ? "hi" : ""}`} data-reveal style={{ ["--d" as string]: i }}>
              <GlareHover className={`lv-plan ${p.highlight ? "hi" : ""}`} glareColor="#ffffff" glareOpacity={p.highlight ? 0.18 : 0.6} playOnce>
                <h3>{p.name}</h3>
                {p.highlight && <span className="lv-plan-tag">Recomendado</span>}
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

        <ul className="lv-facts" data-reveal>
          {facts.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>

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
  const { go, curtain } = useCurtain();
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
        ? "É só por convite: quem já usa gera um código para você, que vale 24 horas. Toque em Tenho um convite."
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
      {curtain}
      <Buddy root={root} />
      <header className="lp-nav">
        <span className="lp-progress" aria-hidden="true" />
        <div className="lp-wrap lp-nav-row">
          <a href="/" className="lp-logo" aria-label="Planejai, início">
            <Mochi size={34} mood="happy" still />
            <span>Planejai</span>
          </a>
          <nav className="lp-links" aria-label="Seções">
            <a href="#como-funciona">Como funciona</a>
            <a href="#time">O time</a>
            <a href="#integracoes">Integrações</a>
            {pricing && <a href="#planos">Planos</a>}
            <a href="#perguntas">Perguntas</a>
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
              </div>
              <div className="lp-hero-stage">
                <HeroChat scene={scene} onScene={setScene} />
              </div>
            </div>
          </Spotlight>
        </section>

        <section className="lp-asks" aria-label="Exemplos de pedidos">
          <LogoLoop
            items={ASKS}
            itemKey={(a) => a}
            speed={30}
            gap={10}
            ariaLabel="Exemplos de pedidos"
            renderItem={(a) => <span className="lp-ask">{a}</span>}
          />
          <LogoLoop
            items={ASKS_2}
            itemKey={(a) => a}
            speed={-24}
            gap={10}
            ariaLabel="Mais exemplos de pedidos"
            renderItem={(a) => <span className="lp-ask alt">{a}</span>}
          />
        </section>

        <section id="como-funciona" className="lp-section">
          <div className="lp-wrap">
            <h2 className="lp-h2" data-reveal>
              Fala do seu jeito. Ele organiza.
            </h2>

            <div className="lp-feats">
              <Feature title="Gastos que se anotam sozinhos" label="Lançamentos aparecendo um a um, separados por categoria" wide>
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
                  <div className="lp-limit">
                    <span>Mercado no mês</span>
                    <b>
                      <CountUp from={0} to={612.4} duration={1.6} delay={0.6} format={brl} /> de R$ 800,00
                    </b>
                    <i>
                      <em />
                    </i>
                  </div>
                </div>
              </Feature>

              <Feature title="Lembretes na hora certa" label="Notificações de lembrete chegando no celular" d={1}>
                <div className="lp-notifs">
                  {[
                    ["happy", "Ana, deu 15 minutos: tira o bolo do forno!"],
                    ["wink", "Hoje vence a luz, R$ 186,32."],
                  ].map(([m, t], i) => (
                    <div key={t} className="lp-notif" style={{ ["--i" as string]: i }}>
                      <Mochi size={30} still mood={m as Mood} />
                      <span>
                        <b>Planejai</b>
                        <small>{t}</small>
                      </span>
                    </div>
                  ))}
                </div>
              </Feature>

              <Feature title="Ele lembra de você" label="Memórias do assistente aparecendo" d={0}>
                <div className="lp-chips">
                  {["Mora em Campinas", "Recebe dia 5", "Cachorro: Thor", "Quer viajar", "Academia às 7h"].map((c, i) => (
                    <span key={c} style={{ ["--i" as string]: i }}>
                      {c}
                    </span>
                  ))}
                </div>
              </Feature>

              <Feature title="De olho no preço" label="Aviso de queda de preço de um produto" wide d={1}>
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

            <ul className="lp-stats" data-reveal>
              <li>
                <b>
                  <CountUp to={7} duration={1} />
                </b>
                <span>Mochis no time</span>
              </li>
              <li>
                <b>
                  <CountUp from={9} to={0} duration={1.2} />
                </b>
                <span>apps para instalar</span>
              </li>
              <li>
                <b>
                  <CountUp to={24} duration={1.2} />h
                </b>
                <span>por dia, todo dia</span>
              </li>
            </ul>
          </div>
        </section>

        <section id="time" className="lp-section lp-team">
          <div className="lp-wrap">
            <h2 className="lp-h2" data-reveal>
              Um time de Mochis por trás.
            </h2>
            <p className="lp-sub" data-reveal style={{ ["--d" as string]: 1 }}>
              O {cto} chama quem precisa. Toque num deles.
            </p>
            <div data-reveal>
              <TeamStage team={TEAM} />
            </div>
          </div>
        </section>

        <section id="seguranca" className="lp-section">
          <div className="lp-wrap lp-safe">
            <div>
              <h2 className="lp-h2" data-reveal>
                Nada sai sem o seu sim.
              </h2>
              <ul className="lp-safe-list" data-reveal style={{ ["--d" as string]: 1 }}>
                <li>Seus dados são só seus</li>
                <li>Apague tudo quando quiser</li>
                <li>Conexões com criptografia</li>
              </ul>
            </div>
            <Confirm />
          </div>
        </section>

        <section id="integracoes" className="lv-night">
          <div className="lp-wrap">
            <h2 className="lp-h2" data-reveal>
              Conecta com o que você já usa.
            </h2>
            <p className="lp-sub" data-reveal style={{ ["--d" as string]: 1 }}>
              Toque num app.
            </p>
          </div>
          <Connects />
        </section>

        {pricing && <Plans pricing={pricing} closed={closed} go={go} cta={(p) => (invite ? cta : `Começar no ${p.name}`)} />}

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

        <section className="lp-final">
          <div className="lp-wrap lp-final-grid" data-reveal>
            <div>
              <h2>Manda um oi.</h2>
              {!closed && (
                <ClickSpark sparkColor="#ffffff" sparkCount={9} sparkRadius={22}>
                  <a className="lp-btn big light" href="/login?cadastro=1" onClick={go}>
                    {cta}
                  </a>
                </ClickSpark>
              )}
            </div>
            <div className="lp-final-mochi">
              <Mochi size={180} mood="greeting" outfit={{ head: "party" }} />
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-foot">
        <div className="lp-wrap lp-foot-row">
          <span className="lp-logo">
            <Mochi size={26} still mood="happy" />
            <span>Planejai</span>
          </span>
          <span className="lp-foot-links">
            <a href="/login" onClick={go}>
              Entrar
            </a>
            <a href="/privacidade">Termos e privacidade</a>
          </span>
          <small>Seu assistente pessoal no WhatsApp.</small>
        </div>
      </footer>
    </div>
  );
}

import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { Mochi, type Mood } from "../mochi/Mochi";
import "../landing.css";
import { TeamStage, type StageAgent } from "./TeamStage";

/**
 * Landing pública (quem abre "/" sem estar logado). Estilo Toki/Pierre: muito respiro, tipografia grande,
 * um celular com a conversa acontecendo de verdade e o Mochi reagindo a cada mensagem.
 * Tudo aqui é verdade do produto: só cita o que um cliente comum já consegue usar.
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

type Msg =
  | { from: "me"; text: string }
  | { from: "me"; audio: string }
  | { from: "me"; photo: string }
  | { from: "bot"; text: string; mood: Mood };

/** A conversa do celular do topo. Cada mensagem da pessoa é respondida depois do "digitando". */
const SCRIPT: Msg[] = [
  { from: "me", text: "gastei 42,90 no mercado" },
  { from: "bot", text: "Anotado: R$ 42,90 em Mercado. Esse mês você já gastou R$ 612,40 com mercado.", mood: "happy" },
  { from: "me", photo: "comprovante da farmácia" },
  { from: "bot", text: "Li o comprovante: Drogaria, R$ 37,50, hoje. Lancei em Saúde.", mood: "finished" },
  { from: "me", text: "me lembra de pagar a luz dia 10 às 9h" },
  { from: "bot", text: "Combinado! Dia 10 às 9h eu te chamo para pagar a luz.", mood: "wink" },
  { from: "me", audio: "0:07" },
  { from: "bot", text: "Ouvi seu áudio: jantar com a Ana sexta às 20h. Já está na agenda.", mood: "happy" },
];

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

/** O celular com a conversa: mostra mensagem por mensagem, com "digitando" antes de cada resposta, e recomeça. */
function Phone({ onMood }: { onMood: (m: Mood) => void }) {
  const [ref, inView] = useInView<HTMLDivElement>();
  const [shown, setShown] = useState(() => (reduced() ? SCRIPT.length : 0));
  const [typing, setTyping] = useState(false);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reduced() || !inView) return;
    let t: ReturnType<typeof setTimeout>;
    if (shown >= SCRIPT.length) {
      t = setTimeout(() => setShown(0), 4200);
      return () => clearTimeout(t);
    }
    const next = SCRIPT[shown];
    if (next.from === "bot") {
      setTyping(true);
      onMood("thinking");
      t = setTimeout(() => {
        setTyping(false);
        setShown((n) => n + 1);
        onMood(next.mood);
      }, 1300);
    } else {
      onMood(shown === 0 ? "idle" : "curious");
      t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 700 : 1500);
    }
    return () => clearTimeout(t);
  }, [shown, inView, onMood]);

  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: reduced() ? "auto" : "smooth" });
  }, [shown, typing]);

  return (
    <div className="lp-phone" ref={ref} aria-label="Exemplo de conversa com o Planejai no WhatsApp" role="img">
      <div className="lp-phone-top">
        <span className="lp-phone-avatar">
          <Mochi size={30} still mood="happy" />
        </span>
        <span>
          <strong>Planejai</strong>
          <small>{typing ? "digitando…" : "online"}</small>
        </span>
      </div>
      <div className="lp-chat" ref={body} aria-hidden="true">
        <span className="lp-day">Hoje</span>
        {SCRIPT.slice(0, shown).map((m, i) => (
          <Bubble key={i} m={m} />
        ))}
        {typing && (
          <div className="lp-bubble bot lp-typing">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>
      <div className="lp-phone-input" aria-hidden="true">
        <span>Mensagem</span>
      </div>
    </div>
  );
}

function Bubble({ m }: { m: Msg }) {
  if (m.from === "bot") return <div className="lp-bubble bot">{m.text}</div>;
  if ("audio" in m)
    return (
      <div className="lp-bubble me lp-audio">
        <span className="lp-play" />
        <span className="lp-wave">
          {Array.from({ length: 18 }, (_, i) => (
            <i key={i} style={{ height: `${30 + ((i * 37) % 70)}%` }} />
          ))}
        </span>
        <small>{m.audio}</small>
      </div>
    );
  if ("photo" in m)
    return (
      <div className="lp-bubble me lp-photo">
        <span className="lp-receipt">
          <b>DROGARIA</b>
          <i />
          <i />
          <i />
          <b>TOTAL R$ 37,50</b>
        </span>
        <small>{m.photo}</small>
      </div>
    );
  return <div className="lp-bubble me">{m.text}</div>;
}

/** Cenas curtas que ficam rodando ao lado de cada recurso (o "vídeo" de cada um). Só rodam visíveis. */
function Clip({ children, label }: { children: ReactNode; label: string }) {
  const [ref, inView] = useInView<HTMLDivElement>("-10% 0px");
  return (
    <div ref={ref} className={`lp-clip ${inView ? "play" : ""}`} role="img" aria-label={label} data-reveal style={{ ["--d" as string]: 1 }}>
      {children}
    </div>
  );
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
  "como-funciona": { mood: "curious", say: "Olha como é fácil." },
  time: { mood: "happy", say: "Esse é o meu time!" },
  seguranca: { mood: "wink", say: "Sem o seu sim, nada sai." },
  integracoes: { mood: "wink", say: "Me dou bem com todo mundo." },
  planos: { mood: "finished", say: "Cabe no bolso." },
  perguntas: { mood: "thinking", say: "Ficou alguma dúvida?" },
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

/** Os especialistas que já vêm prontos, com o que cada um faz e como pedir. */
const TEAM: StageAgent[] = [
  {
    id: "cto",
    role: "Conversa com você",
    text: "É com ele que você fala. Entende o pedido, resolve sozinho o que é rápido (anotar um gasto, criar um lembrete, achar o lugar mais perto) e chama o especialista certo quando precisa. Antes de responder, confere o que o time trouxe.",
    asks: ["qual a farmácia mais perto?", "me lembra de ligar pra minha mãe às 19h"],
  },
  {
    id: "financeiro",
    role: "Cuida do dinheiro",
    text: "Lança gastos e receitas, inclusive pela foto do comprovante, que já entra com a categoria certa. Corrige, divide parcelas, controla contas fixas, avisa quando você passa do limite e faz gráfico do mês.",
    asks: ["gastei 42 no almoço", "quanto gastei com mercado esse mês?"],
  },
  {
    id: "agenda",
    role: "Cuida do seu tempo",
    text: "Lembretes de uma vez ou que se repetem, compromissos com hora marcada e o resumo do que tem no seu dia. Com o Google Agenda conectado, marca reunião com link do Meet.",
    asks: ["toda segunda às 7h me lembra da academia", "o que eu tenho amanhã?"],
  },
  {
    id: "pesquisador",
    role: "Procura por você",
    text: "Pesquisa preço, sessão de cinema, horário, notícia e endereço, compara produtos e fica de olho quando algo baixa de preço. Abre sites só quando a busca não basta.",
    asks: ["sessões de Duna hoje no Iguatemi", "avisa se o iPhone 16 baixar de 4 mil"],
  },
  {
    id: "recados",
    role: "Fala com quem você precisa",
    text: "Manda mensagem para um estabelecimento por você, se apresentando como seu assistente: pergunta horário, preço ou disponibilidade e marca dentro do que você liberou. Nada sai sem o seu sim.",
    asks: ["pergunta no petshop se tem banho às 18h e, se tiver, marca", "vê se o salão tem horário sábado de manhã"],
  },
  {
    id: "comunicacao",
    role: "Cuida dos seus e-mails e do Slack",
    text: "Com o seu Gmail ou Slack conectado em Minha conta, procura, lê e resume o que chegou, separa o que é importante e escreve a resposta do seu jeito. Só envia depois do seu sim.",
    asks: ["resume meus e-mails de hoje", "responde o João dizendo que topo a reunião"],
  },
  {
    id: "produtividade",
    role: "Automatiza o resto",
    text: "Cria rotinas que rodam sozinhas: um aviso que se repete, acompanhar um site ou uma notícia, juntar informações todo dia de manhã.",
    asks: ["todo dia às 8h me manda a previsão do tempo", "me avisa quando sair notícia do concurso"],
  },
];

/**
 * Apps que ele usa por você. Só o que existe de verdade: as contas pessoais que o cliente conecta em Minha conta
 * (PERSONAL_INTEGRATIONS no servidor) e o que já vem pronto para todo mundo. O n8n é do dono e não entra aqui.
 */
interface App {
  id: string;
  name: string;
  does: string;
  ask: string;
  reply: string;
  how: string;
}

const MINE = "Você conecta a sua conta no painel e só você usa.";
const READY = "Já vem pronto, sem conectar nada.";

const APPS: App[] = [
  {
    id: "agenda",
    name: "Google Agenda",
    does: "Marca compromissos, com link do Meet se quiser, e conta o que tem no seu dia.",
    ask: "marca dentista quinta às 15h",
    reply: "Marquei no seu Google Agenda: Dentista, quinta, das 15h às 16h.",
    how: MINE,
  },
  {
    id: "gmail",
    name: "Gmail",
    does: "Procura, lê e resume seus e-mails. Responde do seu jeito, depois do seu sim.",
    ask: "resume meus e-mails de hoje",
    reply: "Chegaram 7. Dois pedem resposta: o boleto do condomínio e a Carla perguntando da reunião de sexta.",
    how: MINE,
  },
  {
    id: "notion",
    name: "Notion",
    does: "Acha e lê suas páginas e cria página nova com o que você ditar.",
    ask: "anota no Notion as ideias da reunião de hoje",
    reply: "Criei a página Ideias da reunião com os 4 pontos que você mandou.",
    how: MINE,
  },
  {
    id: "slack",
    name: "Slack",
    does: "Lê e resume os canais e manda mensagem por você, com o seu sim.",
    ask: "avisa no #obra que a entrega ficou pra segunda",
    reply: "Vou mandar no #obra: “A entrega ficou para segunda.” Posso enviar?",
    how: MINE,
  },
  {
    id: "github",
    name: "GitHub",
    does: "Procura e abre issues nos seus repositórios.",
    ask: "abre uma issue no site: o botão de pagar sumiu no celular",
    reply: "Abri a issue #128 no repositório do site: Botão de pagar some no celular.",
    how: MINE,
  },
  {
    id: "linear",
    name: "Linear",
    does: "Procura e cria tarefas no seu time.",
    ask: "cria tarefa no Linear: revisar o contrato até sexta",
    reply: "Criei a ENG-42: Revisar o contrato até sexta.",
    how: MINE,
  },
  {
    id: "mpago",
    name: "Mercado Pago",
    does: "Gera link de pagamento na sua conta para você cobrar alguém, com Pix, cartão ou boleto.",
    ask: "gera um link de 150 reais da aula de violão",
    reply: "Link de R$ 150,00 para Aula de violão, na sua conta do Mercado Pago. Posso gerar?",
    how: MINE,
  },
  {
    id: "mlivre",
    name: "Mercado Livre",
    does: "Compara preços e fica de olho quando o produto baixa.",
    ask: "acha uma air fryer de 5 litros até 400 reais",
    reply: "Achei 3 com frete grátis. A mais barata sai por R$ 389,90. Quer que eu fique de olho no preço?",
    how: READY,
  },
  {
    id: "maps",
    name: "Google Maps",
    does: "Mostra como chegar de ônibus, carro ou a pé e acha o lugar mais perto.",
    ask: "qual ônibus eu pego pro centro?",
    reply: "Pega o 332 no ponto da esquina, uns 25 minutos até lá. Te mandei o mapa com o caminho.",
    how: READY,
  },
  {
    id: "telegram",
    name: "Telegram",
    does: "Prefere o Telegram? Fale por lá. Gastos, lembretes e memórias são os mesmos.",
    ask: "oi, agora tô por aqui",
    reply: "Oi, Ana! Pode falar por aqui, seus gastos e lembretes estão todos comigo.",
    how: "Você liga a conta pelo painel em um toque.",
  },
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

/** Lista de apps (abas) e, ao lado, o pedido e a resposta no WhatsApp para o app escolhido. */
function Connects({ intro }: { intro: ReactNode }) {
  const [sel, setSel] = useState(0);
  const [typing, setTyping] = useState(false);
  const first = useRef(true);
  const app = APPS[sel]!;

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
    <div className="lv-apps">
      <div className="lv-apps-side">
        {intro}
        <div className="lv-app-list" role="tablist" aria-label="Apps que ele usa" data-reveal>
          {APPS.map((a, i) => (
            <button
              key={a.id}
              type="button"
              role="tab"
              id={`lv-app-${a.id}`}
              aria-selected={i === sel}
              aria-controls="lv-app-panel"
              tabIndex={i === sel ? 0 : -1}
              className="lv-app"
              onClick={() => setSel(i)}
            >
              <span className="lv-glyph">
                <Glyph id={a.id} />
              </span>
              <b>{a.name}</b>
            </button>
          ))}
        </div>
      </div>

      <div className="lv-talk" id="lv-app-panel" role="tabpanel" aria-labelledby={`lv-app-${app.id}`} data-reveal style={{ ["--d" as string]: 1 }}>
        <div className="lv-talk-top">
          <span className="lp-phone-avatar">
            <Mochi size={30} still mood="happy" />
          </span>
          <span>
            <strong>Planejai</strong>
            <small>{typing ? "digitando…" : `usando o ${app.name}`}</small>
          </span>
          <span className="lv-talk-glyph" key={app.id}>
            <Glyph id={app.id} />
          </span>
        </div>
        <div className="lv-talk-chat" key={app.id}>
          <div className="lp-bubble me">{app.ask}</div>
          {typing ? (
            <div className="lp-bubble bot lp-typing" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          ) : (
            <div className="lp-bubble bot">{app.reply}</div>
          )}
        </div>
        <div className="lv-talk-foot">
          <p>{app.does}</p>
          <small>{app.how}</small>
        </div>
      </div>
    </div>
  );
}

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const grainsTxt = (n: number) => `${n.toLocaleString("pt-BR")} ${n === 1 ? "grão" : "grãos"}`;

/** Planos por grãos (crédito que o uso de IA desconta). A vitrine vem de pricing em /api/auth/config. */
function Plans({ pricing, cta, go, closed }: { pricing: Pricing; cta: (p: Plan) => string; go: (e: MouseEvent<HTMLAnchorElement>) => void; closed: boolean }) {
  const { plans, packs, welcome, referral } = pricing;
  // cada regra: o começo em negrito e o resto em cinza
  const rules: [string, string][] = [
    ...(welcome > 0 ? [[`Você começa com ${grainsTxt(welcome)} de presente.`, "Dá para testar à vontade antes de escolher um plano."] as [string, string]] : []),
    ["Cada pedido gasta alguns grãos,", "conforme o trabalho que dá. Anotar um gasto custa pouco; uma pesquisa longa, um pouco mais."],
    ["O plano recarrega seus grãos a cada mês pago.", "O que sobrou não acumula para o mês seguinte."],
    ["Acabou antes do mês virar?", "Compre um pacote avulso, que não vence, ou passe para um plano maior."],
    ["Subiu de plano, paga só a diferença", "e recebe os grãos no mesmo dia. Se descer, a troca vale a partir do mês seguinte."],
    ["Cartão, Pix ou boleto.", "No cartão a mensalidade renova sozinha; no Pix ou boleto a cobrança chega todo mês."],
    ["Cancele quando quiser.", "Os grãos que sobraram continuam valendo."],
    ...(referral.step > 0
      ? [["Convide amigos.", `Cada um que assinar um plano tira ${referral.step}% da sua mensalidade, até ${referral.max}%.`] as [string, string]]
      : []),
  ];

  return (
    <section id="planos" className="lp-section lv-plans-sec">
      <div className="lp-wrap">
        <div className="lv-head">
          <h2 className="lp-h2" data-reveal>
            Pague pelo que usa, em grãos.
          </h2>
          <p className="lp-sub" data-reveal style={{ ["--d" as string]: 1 }}>
            Grão é o crédito do Planejai: cada pedido gasta um pouquinho. Escolha quantos grãos quer por mês e troque de plano quando precisar.
          </p>
        </div>

        <div className="lv-plans">
          {plans.map((p, i) => (
            <article key={p.id} className={`lv-plan ${p.highlight ? "hi" : ""}`} data-reveal style={{ ["--d" as string]: i }}>
              <h3>{p.name}</h3>
              {p.highlight && <span className="lv-plan-tag">Recomendado</span>}
              <p className="lv-plan-price">
                <b>{brl(p.price)}</b>
                <span>por mês</span>
              </p>
              <p className="lv-plan-grains">{grainsTxt(p.grains)} todo mês</p>
              <p className="lv-plan-blurb">{p.blurb}</p>
              {!closed && (
                <a className={`lp-btn ${p.highlight ? "light" : "ghost"}`} href="/login?cadastro=1" onClick={go}>
                  {cta(p)}
                </a>
              )}
            </article>
          ))}
        </div>

        {packs.length > 0 && (
          <div className="lv-packs" data-reveal>
            <p>
              <b>Pacotes avulsos</b>
              <span>Para quando os grãos do mês acabarem. Não vencem.</span>
            </p>
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

        <div className="lv-rules">
          <h3 data-reveal>Como funcionam os grãos</h3>
          <ul data-reveal style={{ ["--d" as string]: 1 }}>
            {rules.map(([b, rest]) => (
              <li key={b}>
                <b>{b}</b> {rest}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export function LandingPage() {
  const [cfg, setCfg] = useState<Config | null>(null);
  const [mood, setMood] = useState<Mood>("greeting");
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

  const faq: [string, ReactNode][] = [
    ["Preciso instalar algum aplicativo?", "Não. Você conversa pelo WhatsApp (ou pelo Telegram, se preferir). O painel abre no navegador e pode ser instalado na tela inicial do celular."],
    [
      "Como eu começo?",
      invite
        ? "O Planejai é só por convite. Quem já usa gera um código para você, que vale por 24 horas. É só tocar em Tenho um convite, digitar o código e criar sua conta."
        : closed
          ? "Os cadastros estão fechados no momento. Se você já tem conta, é só entrar."
          : "Crie a conta com seu nome, e-mail e WhatsApp. Logo depois ele faz umas perguntas rápidas para já começar te conhecendo.",
    ],
    ["Ele mexe no meu dinheiro?", "Não. O Planejai anota e organiza. Qualquer coisa que envolva dinheiro saindo, mensagem para outra pessoa ou apagar algo só acontece depois que você responde sim, e quem confere esse sim é o sistema, não a IA."],
    ["Entende áudio e foto?", "Entende. Mande áudio, foto de comprovante ou um PDF que ele lê, resume e anota o que importa."],
    ["E se eu quiser apagar tudo?", "É só pedir no WhatsApp ou apagar a conta no painel. Seus gastos, lembretes e memórias são apagados de vez."],
  ];

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
            <a href="#seguranca">Segurança</a>
            <a href="#integracoes">Integrações</a>
            {pricing && <a href="#planos">Planos</a>}
            <a href="#perguntas">Perguntas</a>
          </nav>
          <div className="lp-nav-cta">
            <a className="lp-btn ghost" href="/login" onClick={go}>
              Entrar
            </a>
            {!closed && (
              <a className="lp-btn" href="/login?cadastro=1" onClick={go}>
                {cta}
              </a>
            )}
          </div>
        </div>
      </header>

      <main>
        <section className="lp-hero">
          <div className="lp-wrap lp-hero-grid">
            <div className="lp-hero-copy">
              <h1 aria-label="Sua vida organizada numa conversa de WhatsApp.">
                {"Sua vida organizada numa conversa de WhatsApp.".split(" ").map((w, i) => (
                  <Fragment key={w}>
                    <span className="lp-w" aria-hidden="true" style={{ ["--i" as string]: i }}>
                      {w}
                    </span>{" "}
                  </Fragment>
                ))}
              </h1>
              <p className="lp-lead">
                Mande um texto, um áudio ou a foto do comprovante. O Planejai anota seus gastos, marca seus compromissos e te lembra do que importa, com um time de
                especialistas trabalhando por trás.
              </p>
              <div className="lp-hero-cta">
                {!closed && (
                  <a className="lp-btn big" href="/login?cadastro=1" onClick={go}>
                    {cta}
                  </a>
                )}
                <a className="lp-btn big ghost" href="/login" onClick={go}>
                  Já tenho conta
                </a>
              </div>
              <p className="lp-note">Funciona no WhatsApp e no Telegram. Nenhum aplicativo novo para instalar.</p>
            </div>
            <div className="lp-hero-stage">
              <div className="lp-mochi-peek" aria-hidden="true">
                <div className="lp-peek-in">
                  <Mochi size={132} mood={mood} />
                </div>
              </div>
              <div className="lp-phone-par">
                <Phone onMood={setMood} />
              </div>
            </div>
          </div>
        </section>

        <section className="lp-strip" aria-label="O que ele entende">
          <div className="lp-wrap lp-strip-row">
            <span>Ele entende</span>
            <ul data-reveal>
              <li>texto</li>
              <li>áudio</li>
              <li>foto de comprovante</li>
              <li>PDF</li>
              <li>link</li>
            </ul>
          </div>
        </section>

        <section id="como-funciona" className="lp-section">
          <div className="lp-wrap">
            <h2 className="lp-h2" data-reveal>Você fala do seu jeito. Ele organiza do jeito certo.</h2>

            <div className="lp-row">
              <div className="lp-row-copy" data-reveal>
                <h3>Seus gastos se anotam sozinhos</h3>
                <p>
                  "Gastei 30 no Uber" já vira lançamento na categoria certa. Foto de comprovante e parcelas também. No fim do mês você vê para onde foi cada real, com limites
                  por categoria que avisam antes de estourar.
                </p>
              </div>
              <Clip label="Lançamentos aparecendo um a um, separados por categoria">
                <div className="lp-card lp-tx">
                  <strong className="lp-card-title">Últimos gastos</strong>
                  {[
                    ["Mercado", "Alimentação", "R$ 42,90", "#FFE6D3"],
                    ["Drogaria", "Saúde", "R$ 37,50", "#D9F1EC"],
                    ["Uber", "Transporte", "R$ 30,00", "#E0E5FD"],
                    ["Cinema", "Lazer", "R$ 64,00", "#FBE3F0"],
                  ].map(([n, c, v, bg], i) => (
                    <div key={n} className="lp-tx-row" style={{ ["--i" as string]: i }}>
                      <span className="lp-tx-ico" style={{ background: bg }} />
                      <span>
                        <b>{n}</b>
                        <small>{c}</small>
                      </span>
                      <b>{v}</b>
                    </div>
                  ))}
                  <div className="lp-limit">
                    <span>Alimentação no mês</span>
                    <b>R$ 612,40 de R$ 800,00</b>
                    <i>
                      <em />
                    </i>
                  </div>
                </div>
              </Clip>
            </div>

            <div className="lp-row flip">
              <div className="lp-row-copy" data-reveal>
                <h3>Lembretes que chegam como um amigo</h3>
                <p>
                  Nada de "Lembrete: tarefa 1". Ele te chama pelo nome, no horário certo, e entende "toda segunda", "daqui 15 minutos" ou "dia 10 às 9h". A agenda inteira
                  também aparece no painel.
                </p>
              </div>
              <Clip label="Notificações de lembrete chegando no celular">
                <div className="lp-notifs">
                  <div className="lp-notif" style={{ ["--i" as string]: 0 }}>
                    <Mochi size={34} still mood="happy" />
                    <span>
                      <b>Planejai</b>
                      <small>Ana, passaram os 15 minutos: hora de tirar o bolo do forno!</small>
                    </span>
                  </div>
                  <div className="lp-notif" style={{ ["--i" as string]: 1 }}>
                    <Mochi size={34} still mood="wink" />
                    <span>
                      <b>Planejai</b>
                      <small>Bom dia! Hoje vence a conta de luz, R$ 186,32.</small>
                    </span>
                  </div>
                  <div className="lp-notif" style={{ ["--i" as string]: 2 }}>
                    <Mochi size={34} still mood="curious" />
                    <span>
                      <b>Planejai</b>
                      <small>Daqui 1 hora: jantar com a Ana às 20h.</small>
                    </span>
                  </div>
                </div>
              </Clip>
            </div>

            <div className="lp-row">
              <div className="lp-row-copy" data-reveal>
                <h3>Ele te conhece desde o primeiro oi</h3>
                <p>
                  No cadastro ele faz umas perguntas rápidas. Depois vai guardando o que você conta, como a cidade, quem mora com você e o dia que o salário cai, e
                  responde sabendo disso. Você vê e apaga essas memórias quando quiser.
                </p>
              </div>
              <Clip label="Memórias do assistente aparecendo">
                <div className="lp-card lp-mem">
                  <strong className="lp-card-title">O que ele sabe sobre você</strong>
                  <div className="lp-chips">
                    {["Mora em Campinas", "Recebe dia 5", "Tem um cachorro, o Thor", "Quer juntar para viajar", "Prefere respostas curtas", "Academia às 7h"].map((c, i) => (
                      <span key={c} style={{ ["--i" as string]: i }}>
                        {c}
                      </span>
                    ))}
                  </div>
                </div>
              </Clip>
            </div>

            <div className="lp-row flip">
              <div className="lp-row-copy" data-reveal>
                <h3>Fica de olho por você</h3>
                <p>Peça para acompanhar o preço de um produto no Mercado Livre ou as notícias de um assunto. Ele confere várias vezes ao dia e te avisa no WhatsApp.</p>
              </div>
              <Clip label="Aviso de queda de preço de um produto">
                <div className="lp-card lp-watch">
                  <strong className="lp-card-title">De olho no preço</strong>
                  <div className="lp-watch-item">
                    <span className="lp-watch-img" />
                    <span>
                      <b>Air fryer 5 litros</b>
                      <small>Mercado Livre</small>
                    </span>
                  </div>
                  <div className="lp-price">
                    <s>R$ 459,90</s>
                    <b>R$ 389,90</b>
                  </div>
                  <div className="lp-drop">O preço caiu R$ 70,00. Quer o link?</div>
                </div>
              </Clip>
            </div>
          </div>
        </section>

        <section id="time" className="lp-section lp-team">
          <div className="lp-wrap">
            <h2 className="lp-h2" data-reveal>Por trás de cada resposta, um time inteiro.</h2>
            <p className="lp-sub" data-reveal>Cada especialista é um Mochi com uma função. Você não precisa escolher com quem falar: o Maestro chama quem precisa, eles conversam entre si e você recebe uma resposta só.</p>
            <div data-reveal>
              <TeamStage team={TEAM} />
            </div>
          </div>
        </section>

        <section id="seguranca" className="lp-section">
          <div className="lp-wrap">
            <h2 className="lp-h2" data-reveal>Nada sai sem o seu sim.</h2>
            <div className="lp-safe">
              <div data-reveal style={{ ["--d" as string]: 0 }}>
                <h3>Você confirma o que importa</h3>
                <p>Mensagem para outra pessoa, pagamento ou apagar algo só acontece depois do seu sim, conferido pelo sistema.</p>
              </div>
              <div data-reveal style={{ ["--d" as string]: 1 }}>
                <h3>Seus dados são só seus</h3>
                <p>Ninguém além de você vê suas finanças e sua agenda, a não ser que você compartilhe com um contato.</p>
              </div>
              <div data-reveal style={{ ["--d" as string]: 2 }}>
                <h3>Apague quando quiser</h3>
                <p>Um pedido no WhatsApp ou um clique no painel apaga tudo de vez, como manda a LGPD.</p>
              </div>
              <div data-reveal style={{ ["--d" as string]: 3 }}>
                <h3>Chaves guardadas com criptografia</h3>
                <p>As conexões ficam criptografadas, e dados sensíveis como CPF e cartão são escondidos nos registros.</p>
              </div>
            </div>
          </div>
        </section>

        <section id="integracoes" className="lv-night">
          <div className="lp-wrap">
            <Connects
              intro={
                <>
                  <h2 className="lp-h2" data-reveal>
                    Conecta com o que você já usa.
                  </h2>
                  <p className="lp-sub" data-reveal>
                    Ligue suas contas uma vez e peça pelo WhatsApp, do jeito que pediria para alguém de confiança. E-mail, mensagem e cobrança só saem depois do seu sim.
                  </p>
                </>
              }
            />
          </div>
        </section>

        {pricing && <Plans pricing={pricing} closed={closed} go={go} cta={(p) => (invite ? cta : `Começar no ${p.name}`)} />}

        <section id="perguntas" className="lp-section">
          <div className="lp-wrap lp-faq-wrap">
            <h2 className="lp-h2" data-reveal>Perguntas que todo mundo faz</h2>
            <div className="lp-faq" data-reveal style={{ ["--d" as string]: 1 }}>
              {faq.map(([q, a], i) => (
                <div key={q} className={`lp-q ${open === i ? "open" : ""}`}>
                  <button aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
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
              <h2>Manda um oi. O resto ele organiza.</h2>
              {!closed && (
                <a className="lp-btn big light" href="/login?cadastro=1" onClick={go}>
                  {cta}
                </a>
              )}
            </div>
            <div className="lp-final-mochi">
              <Mochi size={180} mood="greeting" />
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
            <a href="/login" onClick={go}>Entrar</a>
            <a href="/privacidade">Termos e privacidade</a>
          </span>
          <small>Seu assistente pessoal no WhatsApp.</small>
        </div>
      </footer>
    </div>
  );
}

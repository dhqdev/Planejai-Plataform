import { Fragment, useEffect, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../api";
import { AgentFace, CORE_FACES } from "../faces";
import { Mochi, type Mood } from "../mochi/Mochi";
import "../landing.css";

/**
 * Landing pública (quem abre "/" sem estar logado). Estilo Toki/Pierre: muito respiro, tipografia grande,
 * um celular com a conversa acontecendo de verdade e o Mochi reagindo a cada mensagem.
 * Tudo aqui é verdade do produto: só cita o que um cliente comum já consegue usar.
 */

interface Config {
  signupMode: string;
  plan: { name: string; price: number; trialDays: number } | null;
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
    for (const n of el.querySelectorAll("[data-reveal]")) io.observe(n);
    el.classList.add("reveal-on");
    return () => io.disconnect();
  }, [root]);
}

/** O que o Mochi que acompanha a rolagem diz e sente em cada parte da página. */
const BUDDY: Record<string, { mood: Mood; say: string }> = {
  "como-funciona": { mood: "curious", say: "Olha como é fácil." },
  time: { mood: "happy", say: "Esse é o meu time!" },
  seguranca: { mood: "wink", say: "Sem o seu sim, nada sai." },
  preco: { mood: "finished", say: "Cabe no bolso." },
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
        setTimeout(() => keep.remove(), 700);
      }
      nav(href);
    }, 620);
  };
  const curtain = veil
    ? createPortal(
        <div ref={node} className="lp-veil" style={{ ["--x" as string]: `${veil.x}px`, ["--y" as string]: `${veil.y}px` }} aria-hidden="true">
          <span className="lp-veil-mochi">
            <Mochi size={96} still mood="happy" />
          </span>
        </div>,
        document.body,
      )
    : null;
  return { go, curtain };
}

const TEAM: { id: keyof typeof CORE_FACES; role: string; text: string }[] = [
  { id: "cto", role: "Conversa com você", text: "Entende o que você pediu e chama quem do time precisa. É ele que te responde." },
  { id: "financeiro", role: "Cuida do dinheiro", text: "Anota gastos, lê comprovantes, separa por categoria e avisa quando passa do limite." },
  { id: "agenda", role: "Cuida da agenda", text: "Lembretes de uma vez ou de toda semana, compromissos e o que tem no seu dia." },
  { id: "pesquisador", role: "Procura por você", text: "Pesquisa preços, horários e notícias, e fica de olho quando algo baixa de preço." },
  { id: "produtividade", role: "Automatiza o resto", text: "Cria avisos que se repetem e acompanha sites e notícias para você não precisar lembrar." },
];

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
  const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const faq: [string, ReactNode][] = [
    ["Preciso instalar algum aplicativo?", "Não. Você conversa pelo WhatsApp (ou pelo Telegram, se preferir). O painel abre no navegador e pode ser instalado na tela inicial do celular."],
    [
      "Como eu começo?",
      invite
        ? "Hoje o Planejai é só por convite: alguém que já usa te convida pelo WhatsApp, você responde SIM e cria a conta pelo link que chega."
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
            {cfg?.plan && <a href="#preco">Preço</a>}
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
            <p className="lp-sub" data-reveal>Cada especialista é um Mochi. Eles conversam entre si, e o Téo junta tudo numa resposta só para você.</p>
            <div className="lp-team-grid">
              {TEAM.map((m, i) => (
                <article key={m.id} className={`lp-agent ${m.id === "cto" ? "lead" : ""}`} data-reveal style={{ ["--d" as string]: i }}>
                  <AgentFace face={CORE_FACES[m.id].face} size={m.id === "cto" ? 92 : 72} title={CORE_FACES[m.id].persona} />
                  <h3>
                    {CORE_FACES[m.id].persona}
                    <small>{m.role}</small>
                  </h3>
                  <p>{m.text}</p>
                </article>
              ))}
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

        {cfg?.plan && (
          <section id="preco" className="lp-section">
            <div className="lp-wrap">
              <h2 className="lp-h2" data-reveal>Um plano, tudo incluído.</h2>
              <div className="lp-plan" data-reveal>
                <div>
                  <h3>{cfg.plan.name}</h3>
                  <p className="lp-plan-price">
                    <b>{brl(cfg.plan.price)}</b>
                    <span>por mês</span>
                  </p>
                  {cfg.plan.trialDays > 0 && <p className="lp-plan-trial">Os primeiros {cfg.plan.trialDays} dias são grátis.</p>}
                </div>
                <ul>
                  <li>O time completo no WhatsApp e no Telegram</li>
                  <li>Gastos, limites e gráficos do mês</li>
                  <li>Lembretes e agenda sem limite</li>
                  <li>Acompanhamento de preços e notícias</li>
                  <li>Painel no celular e no computador</li>
                </ul>
                {!closed && (
                  <a className="lp-btn big" href="/login?cadastro=1" onClick={go}>
                    {cta}
                  </a>
                )}
              </div>
            </div>
          </section>
        )}

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

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AgentFace, CORE_FACES } from "../faces";
import "../landing-team.css";

/**
 * Landing, seção do time: uma fila com os sete Mochis e um palco que mostra, em cena animada, o que o escolhido faz
 * (o Juvenal distribuindo o pedido, o Moacir lendo o comprovante, o Cotinha tocando na hora...). Troca sozinho
 * enquanto está na tela; tocar num agente fixa nele. Com movimento reduzido, cada cena aparece já pronta.
 */

export interface StageAgent {
  id: keyof typeof CORE_FACES;
  role: string;
  text: string;
  asks: string[];
}

/** Cada cena dura isso; depois passa para o próximo (enquanto a pessoa não escolheu um). */
const SCENE_MS = 8000;
/** A cena é desenhada nesse tamanho e escala para caber (celular, iPad, computador). */
const W = 480;
const H = 320;

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

function useInView<T extends Element>() {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setInView(true);
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView] as const;
}

/** Escala da cena para a largura do palco. */
function useFit() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1.25, el.clientWidth / W));
    fit();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, scale] as const;
}

/** Peça da cena: posição na cena de 480x320 e quando entra (segundos). */
function P({ x, y, w, d = 0, a = "in", className = "", style, children }: { x: number; y: number; w?: number; d?: number; a?: string; className?: string; style?: CSSProperties; children?: ReactNode }) {
  return (
    <div className={`sc-p sc-a-${a} ${className}`} style={{ left: x, top: y, width: w, ["--d" as string]: `${d}s`, ...style }}>
      {children}
    </div>
  );
}

const Face = ({ id, size = 52, live = false }: { id: string; size?: number; live?: boolean }) => (
  <AgentFace face={CORE_FACES[id]?.face} size={size} agent={id} live={live} title={CORE_FACES[id]?.persona} />
);

function Bubble({ me, children }: { me?: boolean; children: ReactNode }) {
  return <div className={`sc-bubble ${me ? "me" : ""}`}>{children}</div>;
}

/* ---------------- as cenas ---------------- */

function SceneMaestro() {
  return (
    <>
      <P x={16} y={14} w={250} d={0.2}>
        <Bubble me>quanto gastei no mercado? e me lembra de pagar a luz dia 10</Bubble>
      </P>
      <P x={98} y={118} d={0.6} a="pop">
        <Face id="cto" size={88} live />
      </P>
      <svg className="sc-p sc-lines" viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ left: 0, top: 0 }} aria-hidden="true">
        <path className="sc-draw" style={{ ["--d" as string]: "1.3s" }} d="M190 150 C 250 150 270 92 330 92" pathLength={1} />
        <path className="sc-draw" style={{ ["--d" as string]: "1.5s" }} d="M190 172 C 250 172 270 210 330 210" pathLength={1} />
        <circle className="sc-run a" r={4} />
        <circle className="sc-run b" r={4} />
      </svg>
      <P x={334} y={66} d={1.1} a="pop">
        <Face id="financeiro" size={52} />
      </P>
      <P x={334} y={184} d={1.3} a="pop">
        <Face id="agenda" size={52} />
      </P>
      <P x={392} y={78} d={2.5} a="chip">
        <span className="sc-chip">R$ 612,40</span>
      </P>
      <P x={392} y={196} d={2.9} a="chip">
        <span className="sc-chip">dia 10, 9h</span>
      </P>
      <P x={150} y={252} w={314} d={4}>
        <Bubble>Esse mês foram R$ 612,40 no mercado. E dia 10 às 9h eu te lembro da luz.</Bubble>
      </P>
    </>
  );
}

function SceneTostao() {
  return (
    <>
      <P x={22} y={26} w={150} d={0.2} className="sc-receipt">
        <b>Drogaria</b>
        <i style={{ width: "80%" }} />
        <i style={{ width: "60%" }} />
        <i style={{ width: "70%" }} />
        <span>Total</span>
        <strong>R$ 37,50</strong>
        <em className="sc-scan" />
      </P>
      <P x={56} y={244} d={0.5} a="pop">
        <Face id="financeiro" size={60} live />
      </P>
      <P x={58} y={178} d={1.6} a="fly" className="sc-flychip">
        <span className="sc-chip strong">Saúde · R$ 37,50</span>
      </P>
      <P x={210} y={26} w={250} d={0.4} className="sc-panel">
        <small>Esse mês</small>
        {[
          ["Mercado", "R$ 612,40", 74, 0.8],
          ["Saúde", "R$ 37,50", 12, 3],
          ["Transporte", "R$ 180,00", 26, 1],
        ].map(([n, v, pct, d]) => (
          <div key={n as string} className="sc-row">
            <span>{n}</span>
            <b>{v}</b>
            <i>
              <em className="sc-grow" style={{ width: `${pct}%`, ["--d" as string]: `${d}s` }} />
            </i>
          </div>
        ))}
        <div className="sc-limit sc-p-static">
          <span>Limite do mercado</span>
          <b className="sc-in" style={{ ["--d" as string]: "3.6s" }}>82%</b>
          <i>
            <em className="sc-grow violet" style={{ width: "82%", ["--d" as string]: "3.4s" }} />
          </i>
        </div>
      </P>
    </>
  );
}

function SceneSininho() {
  return (
    <>
      <P x={28} y={26} d={0.2} a="pop">
        <svg className="sc-clock" viewBox="0 0 120 120" width={128} height={128} aria-hidden="true">
          <circle cx={60} cy={60} r={54} fill="#fff" stroke="#121214" strokeWidth={3} />
          {Array.from({ length: 12 }, (_, i) => (
            <line key={i} x1={60} y1={12} x2={60} y2={i % 3 ? 17 : 20} stroke="#121214" strokeWidth={i % 3 ? 2 : 3} strokeLinecap="round" transform={`rotate(${i * 30} 60 60)`} />
          ))}
          <line className="sc-hour" x1={60} y1={60} x2={60} y2={34} stroke="#121214" strokeWidth={5} strokeLinecap="round" />
          <line className="sc-min" x1={60} y1={60} x2={60} y2={22} stroke="#6510e0" strokeWidth={3} strokeLinecap="round" />
          <circle cx={60} cy={60} r={4.5} fill="#121214" />
        </svg>
      </P>
      <P x={52} y={196} d={0.5} a="pop">
        <Face id="agenda" size={64} live />
      </P>
      <P x={196} y={26} w={262} d={0.4} className="sc-panel sc-cal">
        <small>Outubro</small>
        <div className="sc-days">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className={i === 9 ? "sc-mark" : ""}>
              {i + 1}
            </span>
          ))}
        </div>
      </P>
      <P x={196} y={186} w={262} d={2.8} a="ring" className="sc-notif">
        <span className="sc-bell" aria-hidden="true">
          <svg viewBox="0 0 40 40" width={22} height={22}>
            <path d="M12.5 26 C13 24 13.4 21.5 13.5 18.5 C13.7 13.5 16.4 10.5 20 10.5 C23.6 10.5 26.3 13.5 26.5 18.5 C26.6 21.5 27 24 27.5 26 Z" fill="#fff" stroke="#121214" strokeWidth={2.4} strokeLinejoin="round" />
            <circle cx={20} cy={30} r={2.4} fill="#121214" />
          </svg>
        </span>
        <span>
          <b>Hora de pagar a luz</b>
          <small>hoje, 9h00</small>
        </span>
      </P>
    </>
  );
}

function SceneLupa() {
  const rows = [
    ["Loja A", "R$ 4.299"],
    ["Loja B", "R$ 3.989"],
    ["Loja C", "R$ 4.150"],
  ];
  return (
    <>
      <P x={20} y={20} w={290} d={0.1} className="sc-browser">
        <div className="sc-url">
          <span />
          <span />
          <span />
          <i>iphone 16 128gb</i>
        </div>
        {rows.map(([n, v], i) => (
          <div key={n} className={`sc-result sc-in ${i === 1 ? "best" : ""}`} style={{ ["--d" as string]: `${0.4 + i * 0.25}s` }}>
            <span className="sc-thumb" />
            <span>
              <b>{n}</b>
              <small>iPhone 16 128 GB</small>
            </span>
            <strong>{v}</strong>
            {i === 1 && <em className="sc-tag">menor preço</em>}
          </div>
        ))}
      </P>
      <P x={0} y={0} d={1} a="lens" className="sc-lens">
        <svg viewBox="0 0 40 40" width={64} height={64} aria-hidden="true">
          <circle cx={17} cy={17} r={10} fill="rgba(255,255,255,.35)" stroke="#121214" strokeWidth={2.6} />
          <path d="M24.5 24.5 L34 34" stroke="#121214" strokeWidth={4} strokeLinecap="round" />
        </svg>
      </P>
      <P x={370} y={22} d={0.4} a="pop">
        <Face id="pesquisador" size={64} live />
      </P>
      <P x={326} y={190} w={140} d={3.8}>
        <Bubble>Achei por R$ 3.989 na Loja B.</Bubble>
      </P>
    </>
  );
}

function ScenePombo() {
  return (
    <>
      <P x={16} y={22} d={0.1} a="pop" className="sc-who">
        <span className="sc-avatar">Você</span>
      </P>
      <P x={196} y={14} d={0.3} a="pop">
        <Face id="recados" size={72} live />
      </P>
      <P x={386} y={22} d={0.2} a="pop" className="sc-who">
        <span className="sc-avatar shop">Petshop</span>
      </P>
      <P x={16} y={110} w={180} d={0.6}>
        <Bubble me>vê se tem banho às 18h e, se tiver, marca</Bubble>
      </P>
      <P x={176} y={188} w={150} d={1.5}>
        <Bubble>Posso mandar pro Petshop?</Bubble>
      </P>
      <P x={16} y={232} w={120} d={2.2}>
        <Bubble me>sim</Bubble>
      </P>
      <P x={0} y={0} d={2.7} a="plane" className="sc-plane">
        <svg viewBox="0 0 40 40" width={34} height={34} aria-hidden="true">
          <path d="M5 19 L35 6 L26 34 L19 23 Z" fill="#fff" stroke="#121214" strokeWidth={2.2} strokeLinejoin="round" />
          <path d="M19 23 L35 6" stroke="#6510e0" strokeWidth={2} strokeLinecap="round" />
        </svg>
      </P>
      <P x={340} y={110} w={130} d={3.7}>
        <Bubble>Tem às 18h, pode trazer!</Bubble>
      </P>
      <P x={300} y={250} d={4.6} a="chip">
        <span className="sc-chip strong">Marcado: hoje, 18h</span>
      </P>
    </>
  );
}

function SceneCarta() {
  const mails = [
    ["Loja X", "Ofertas da semana", false],
    ["Banco", "Seu boleto vence amanhã", true],
    ["App de corrida", "Seu resumo do mês", false],
    ["João", "Reunião mudou para sexta", true],
    ["Newsletter", "5 dicas para viajar", false],
  ] as const;
  return (
    <>
      <P x={20} y={20} w={262} d={0.1} className="sc-inbox">
        {mails.map(([from, subj, imp], i) => (
          <div key={from} className={`sc-mail sc-in ${imp ? "imp" : "dim"}`} style={{ ["--d" as string]: `${0.3 + i * 0.18}s` }}>
            <b>{from}</b>
            <span>{subj}</span>
          </div>
        ))}
      </P>
      <P x={378} y={18} d={0.4} a="pop">
        <Face id="comunicacao" size={64} live />
      </P>
      <P x={300} y={96} w={162} d={2.6} className="sc-panel sc-sum">
        <small>2 importantes</small>
        <p>Boleto vence amanhã. João mudou a reunião para sexta.</p>
      </P>
      <P x={300} y={214} w={162} d={3.6} className="sc-panel sc-draft">
        <small>Resposta para o João</small>
        <p className="sc-type">Combinado, sexta!</p>
        <em>só envia com o seu sim</em>
      </P>
    </>
  );
}

function SceneBloco() {
  const nodes = [
    ["Todo dia, 8h", "gatilho"],
    ["Previsão do tempo", "busca"],
    ["Seu WhatsApp", "mensagem"],
  ];
  return (
    <>
      <svg className="sc-p sc-lines" viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ left: 0, top: 0 }} aria-hidden="true">
        <path className="sc-draw" style={{ ["--d" as string]: "0.8s" }} d="M150 86 H178" pathLength={1} />
        <path className="sc-draw" style={{ ["--d" as string]: "1s" }} d="M304 86 H332" pathLength={1} />
        <circle className="sc-run flow" r={5} />
      </svg>
      {nodes.map(([t, k], i) => (
        <P key={t} x={20 + i * 154} y={50} w={130} d={0.2 + i * 0.25} className={`sc-node n${i}`}>
          <small>{k}</small>
          <b>{t}</b>
        </P>
      ))}
      <P x={40} y={196} d={0.6} a="pop">
        <Face id="produtividade" size={64} live />
      </P>
      <P x={140} y={186} w={300} d={3.4}>
        <Bubble>Bom dia! Hoje faz 27° e não deve chover. Leva os óculos escuros.</Bubble>
      </P>
      <P x={140} y={264} d={4.2} a="chip">
        <span className="sc-chip">roda sozinha todo dia</span>
      </P>
    </>
  );
}

const SCENES: Record<string, () => ReactNode> = {
  cto: SceneMaestro,
  financeiro: SceneTostao,
  agenda: SceneSininho,
  pesquisador: SceneLupa,
  recados: ScenePombo,
  comunicacao: SceneCarta,
  produtividade: SceneBloco,
};

export function TeamStage({ team }: { team: StageAgent[] }) {
  const [sel, setSel] = useState(0);
  const [pinned, setPinned] = useState(false);
  const [run, setRun] = useState(0);
  const [stage, inView] = useInView<HTMLDivElement>();
  const [box, scale] = useFit();
  const auto = inView && !pinned && !reduced();

  useEffect(() => {
    if (!auto) return;
    const t = setTimeout(() => setSel((i) => (i + 1) % team.length), SCENE_MS);
    return () => clearTimeout(t);
  }, [auto, sel, team.length]);

  const pick = (i: number) => {
    setPinned(true);
    setSel(i);
    setRun((n) => n + 1); // tocar de novo no mesmo recomeça a cena
  };
  const a = team[sel]!;
  const Scene = SCENES[a.id] ?? SceneMaestro;
  const persona = CORE_FACES[a.id]?.persona ?? a.id;

  return (
    <div className="lp-stage" ref={stage}>
      <div className="lp-lineup" role="tablist" aria-label="Escolha um agente">
        {team.map((m, i) => (
          <button
            key={m.id}
            role="tab"
            aria-selected={i === sel}
            className={`lp-pick ${i === sel ? "on" : ""} ${m.id === "cto" ? "lead" : ""}`}
            onClick={() => pick(i)}
          >
            <span className="lp-pick-face">
              <AgentFace face={CORE_FACES[m.id]?.face} size={56} agent={m.id} live={i === sel && inView} title={CORE_FACES[m.id]?.persona} />
            </span>
            <b>{CORE_FACES[m.id]?.persona}</b>
            {i === sel && auto && <i className="lp-pick-bar" key={`${sel}-${run}`} style={{ animationDuration: `${SCENE_MS}ms` }} />}
          </button>
        ))}
      </div>

      <div className="lp-stage-card">
        <div className="lp-scene-box" ref={box} style={{ height: H * scale }} aria-hidden="true">
          <div className={`sc ${inView ? "play" : ""}`} key={`${a.id}-${run}`} style={{ width: W, height: H, transform: `scale(${scale})` }}>
            <Scene />
          </div>
        </div>
        <div className="lp-stage-copy" key={a.id} role="tabpanel" aria-label={persona}>
          <h3>
            {persona}
            <small>{a.role}</small>
          </h3>
          <p>{a.text}</p>
          <ul className="lp-agent-asks" aria-label={`Exemplos de pedidos para ${persona}`}>
            {a.asks.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

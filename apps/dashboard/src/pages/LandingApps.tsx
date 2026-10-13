import { useEffect, useRef, useState, type ReactNode } from "react";
import { Mascote } from "../mascote/Mascote";
import "../styles/landing-time.css";
import { BRANDS } from "./landingBrands";

/**
 * Integrações na landing, quase sem texto: o mascote no meio com os apps girando em volta (dois anéis em sentidos
 * opostos) e quatro cenas pequenas de app em uso. Só gira enquanto aparece na tela.
 */
/**
 * Apps que ele usa por você. Só o que existe de verdade: as contas pessoais que o cliente conecta em Minha conta
 * (PERSONAL_INTEGRATIONS no servidor) e o que já vem pronto para todo mundo. O n8n é do dono e não entra aqui.
 */
const APPS = [
  { id: "agenda", name: "Google Agenda" },
  { id: "gmail", name: "Gmail" },
  { id: "notion", name: "Notion" },
  { id: "slack", name: "Slack" },
  { id: "github", name: "GitHub" },
  { id: "linear", name: "Linear" },
  { id: "mpago", name: "Mercado Pago" },
  { id: "mlivre", name: "Mercado Livre" },
  { id: "shopee", name: "Shopee" },
  { id: "maps", name: "Google Maps" },
  { id: "telegram", name: "Telegram" },
];

/** Mercado Livre não está no Simple Icons: o oval amarelo com o aperto de mão, simplificado. */
const MLIVRE = (
  <>
    <ellipse cx="12" cy="12" rx="11" ry="8.2" fill="#FFE600" stroke="#2D3277" strokeWidth="1.2" />
    <path d="M5.5 12.6 8.6 10l2.3 1.1 2.4-1.5 5.2 3.1" fill="none" stroke="#2D3277" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m8.8 13.9 1.5 1.1m.4-1.9 1.7 1.3m.3-2 1.6 1.2" fill="none" stroke="#2D3277" strokeWidth="1.2" strokeLinecap="round" />
  </>
);

/** A marca do app, na cor dela. */
export function Glyph({ id }: { id: string }) {
  const b = BRANDS[id];
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
      {b ? <path d={b.path} fill={b.hex} /> : id === "mlivre" ? MLIVRE : null}
    </svg>
  );
}


/** Fileira de marcas no topo da página, embaixo dos botões: o que ele usa, já na primeira tela. */
export function AppsRow() {
  return (
    <a className="la-row" href="#apps" aria-label={`Conecta com ${APPS.map((a) => a.name).join(", ")}`}>
      <small>Conecta com</small>
      <span className="la-row-logos">
        {APPS.map((a, i) => (
          <span key={a.id} className="la-row-app" title={a.name} style={{ ["--i" as string]: i }}>
            <Glyph id={a.id} />
          </span>
        ))}
      </span>
    </a>
  );
}

/** Liga a cena só enquanto aparece (e uma vez já basta para ficar montada). */
function usePlay<T extends Element>() {
  const ref = useRef<T>(null);
  const [play, setPlay] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return setPlay(true);
    const io = new IntersectionObserver(([e]) => setPlay(e.isIntersecting), { rootMargin: "-8% 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, play] as const;
}

const INNER = APPS.slice(0, 5);
const OUTER = APPS.slice(5);

/** O mascote no meio e os apps em dois anéis. */
export function AppsOrbit() {
  const [ref, play] = usePlay<HTMLDivElement>();
  const ring = (list: typeof APPS, cls: string) => (
    <ul className={`la-ring ${cls}`}>
      {list.map((a, i) => (
        <li key={a.id} style={{ ["--a" as string]: `${(360 / list.length) * i + (cls === "out" ? 18 : 0)}deg` }}>
          <span className="la-app" title={a.name}>
            <Glyph id={a.id} />
            <small>{a.name}</small>
          </span>
        </li>
      ))}
      <li className="la-spark" style={{ ["--a" as string]: cls === "out" ? "200deg" : "110deg" }}>
        <i />
      </li>
    </ul>
  );
  return (
    <div ref={ref} className={`la-orbit ${play ? "play" : ""}`} role="img" aria-label={`Apps conectados: ${APPS.map((a) => a.name).join(", ")}`}>
      <svg className="la-lines" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="31" />
        <circle cx="50" cy="50" r="46" />
      </svg>
      {ring(INNER, "in")}
      {ring(OUTER, "out")}
      <span className="la-core">
        <Mascote size={112} mood="happy" />
      </span>
    </div>
  );
}

/** Quatro cenas de app em uso: a imagem conta, a legenda tem duas palavras. */
export function AppScenes() {
  const scenes: { id: string; name: string; caption: string; art: ReactNode }[] = [
    {
      id: "agenda",
      name: "Google Agenda",
      caption: "Marcado nos dois",
      art: (
        <div className="la-cal">
          {["seg", "ter", "qua"].map((d, i) => (
            <span key={d} className="la-cal-day">
              <small>{d}</small>
              <i />
              {i === 1 && <b className="la-cal-ev">Café 15h</b>}
              <i />
            </span>
          ))}
        </div>
      ),
    },
    {
      id: "gmail",
      name: "Gmail",
      caption: "Resumido pra você",
      art: (
        <div className="la-mail">
          {[0, 1, 2].map((i) => (
            <span key={i} className="la-mail-row" style={{ ["--i" as string]: i }}>
              <i />
              <i />
            </span>
          ))}
          <b className="la-mail-sum">3 importantes</b>
        </div>
      ),
    },
    {
      id: "maps",
      name: "Google Maps",
      caption: "O caminho mais curto",
      art: (
        <svg className="la-map" viewBox="0 0 200 110" aria-hidden="true">
          <path className="la-map-grid" d="M0 30h200M0 70h200M50 0v110M120 0v110M165 0v110" />
          <path className="la-map-way" d="M28 88c30-4 34-40 62-44s40 22 70-14" />
          <circle className="la-map-a" cx="28" cy="88" r="5" />
          <circle className="la-map-halo" cx="160" cy="30" r="11" />
          <circle className="la-map-pin" cx="160" cy="30" r="6" />
        </svg>
      ),
    },
    {
      id: "notion",
      name: "Notion",
      caption: "Anotado na página",
      art: (
        <div className="la-page">
          <b />
          {[0, 1, 2, 3].map((i) => (
            <i key={i} style={{ ["--i" as string]: i }} />
          ))}
        </div>
      ),
    },
  ];
  return (
    <ul className="la-scenes">
      {scenes.map((s, i) => (
        <Scene key={s.id} {...s} d={i} />
      ))}
    </ul>
  );
}

function Scene({ id, name, caption, art, d }: { id: string; name: string; caption: string; art: ReactNode; d: number }) {
  const [ref, play] = usePlay<HTMLLIElement>();
  return (
    <li ref={ref} className={`la-scene ${play ? "play" : ""}`} data-reveal style={{ ["--d" as string]: d }}>
      <div className="la-art" aria-hidden="true">
        {art}
      </div>
      <p>
        <Glyph id={id} />
        <span>
          <b>{name}</b>
          <small>{caption}</small>
        </span>
      </p>
    </li>
  );
}

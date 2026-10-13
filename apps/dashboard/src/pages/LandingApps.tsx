import { useEffect, useRef, useState, type ReactNode } from "react";
import { Mascote } from "../mascote/Mascote";
import "../styles/landing-time.css";

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
  shopee: (
    <>
      <path d="M5 8h14l-1.2 12H6.2z" />
      <path d="M9 10V7a3 3 0 0 1 6 0v3" />
    </>
  ),
  telegram: <path d="M20.5 4 3.5 10.8l6 2.2 2.2 6.5 3-4.2 4.6 3.4zM9.5 13 20.5 4" />,
};

export function Glyph({ id }: { id: string }) {
  return (
    <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {GLYPHS[id]}
    </svg>
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

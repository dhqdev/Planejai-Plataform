/**
 * Detalhes de app de iPhone que valem para o painel todo (CSS em styles/app-ios.css):
 * pastilha que desliza até o botão ativo das abas e filtros, lente de vidro líquido nos menus,
 * voltar arrastando da borda esquerda (app instalado) e o menu de toque longo.
 */
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { Icon } from "./icons";
import { haptic, isStandalone } from "./touch";

const lessMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const isPhone = () => matchMedia("(max-width: 767px)").matches;

/* ---------- Seletor segmentado: a pastilha segue o botão ativo ---------- */
const SEG = ".seg, .subtabs, .fin-tabs, .cal-pills, .sidebar .nav";

function placeThumbs() {
  // lê todas as medidas primeiro e só depois escreve: medir depois de escrever obriga o navegador a refazer o
  // layout da tela inteira a cada seletor (na troca de tela eram vários layouts seguidos)
  const boxes = [...document.querySelectorAll<HTMLElement>(SEG)].map((box) => {
    const on = box.querySelector<HTMLElement>(":scope > button.active, :scope > button[aria-selected='true'], :scope > a.active");
    if (!on || !box.offsetParent) return { box, at: null };
    return { box, at: { x: on.offsetLeft, w: on.offsetWidth, y: on.offsetTop, h: on.offsetHeight } };
  });
  for (const { box, at } of boxes) {
    if (!at) {
      box.style.setProperty("--seg-o", "0");
      continue;
    }
    box.style.setProperty("--seg-x", `${at.x}px`);
    box.style.setProperty("--seg-w", `${at.w}px`);
    box.style.setProperty("--seg-y", `${at.y}px`);
    box.style.setProperty("--seg-h", `${at.h}px`);
    box.style.setProperty("--seg-o", "1");
    // primeira vez: aparece já no lugar; depois desliza
    if (!box.dataset.seg) {
      box.dataset.seg = "ready";
      requestAnimationFrame(() => requestAnimationFrame(() => (box.dataset.seg = "on")));
    }
  }
}

export function installSegmented() {
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      placeThumbs();
    });
  };
  new MutationObserver(schedule).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-selected"] });
  addEventListener("resize", schedule);
  document.fonts?.ready.then(schedule);
  schedule();
}

/* ---------- Vidro líquido: lente que aumenta e refrata o que passa por baixo ---------- */
/**
 * Como a barra do WhatsApp no iOS 26: parada, a aba escolhida é só uma cápsula cinza translúcida; quando ela
 * anda (toque em outra aba ou arrasto com o dedo), vira uma lente de vidro maior que a barra, que aumenta o
 * que está embaixo e tem na borda o arco-íris da refração (aberração cromática) e o brilho de cima.
 *
 * O Safari não aceita filtro SVG no backdrop-filter (e no Chrome ele saiu desalinhado), então a lente não lê
 * o fundo: ela leva dentro uma cópia da própria barra, posicionada para casar com a de verdade e aumentada
 * a partir do centro da lente. Funciona igual em todo navegador, inclusive no iPhone. Uma segunda cópia,
 * um pouco maior e com sombras vermelha e azul, aparece só nas pontas: é a luz "dobrando" na borda do vidro.
 * CSS em styles/vidro.css. Só aparece enquanto o dedo arrasta: no toque, a cápsula só desliza, lisa
 * (David pediu menos efeito, 2026-10-11).
 */
const LENS_SCALE = 1.3; // a lente fica maior que a cápsula parada (passa um pouco da barra, como no WhatsApp)
const LENS_ZOOM = 1.16; // quanto o conteúdo embaixo aparece aumentado

function tabbarLens() {
  const pill = () => document.querySelector<HTMLElement>(".tabbar-pill");
  const glider = () => pill()?.querySelector<HTMLElement>(".tab-glider") ?? null;
  const tabs = () => [...(pill()?.querySelectorAll<HTMLElement>(":scope > .tabbar-scroll > .tab, :scope > .tab") ?? [])];
  let drag: { id: number; x0: number; on: boolean; base: number; w: number } | null = null;
  let until = 0;
  let raf = 0;

  /** Monta dentro da lente as cópias da barra (sem a própria lente). Refeita a cada uso: a aba ativa muda. */
  const build = (p: HTMLElement, g: HTMLElement) => {
    g.replaceChildren();
    const st = getComputedStyle(p);
    const copy = () => {
      const c = document.createElement("div");
      c.className = "lens-copy";
      c.style.width = `${p.clientWidth}px`;
      c.style.height = `${p.clientHeight}px`;
      c.style.padding = st.padding;
      c.style.gap = st.gap;
      for (const n of p.children) if (n !== g) c.appendChild(n.cloneNode(true));
      return c;
    };
    for (const cls of ["lens-core", "lens-edge"]) {
      const w = document.createElement("div");
      w.className = cls;
      w.appendChild(copy());
      g.appendChild(w);
    }
    const rim = document.createElement("div");
    rim.className = "lens-rim";
    g.appendChild(rim);
    g.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
    g.setAttribute("inert", "");
    // a cópia das abas que rolam fica na mesma rolagem da original
    const src = p.querySelector<HTMLElement>(":scope > .tabbar-scroll");
    g.querySelectorAll<HTMLElement>(".tabbar-scroll").forEach((s) => (s.scrollLeft = src?.scrollLeft ?? 0));
  };

  /** Casa a cópia com a barra de verdade: o ponto embaixo do centro da lente fica parado e o resto cresce em volta. */
  const place = () => {
    const g = glider();
    if (!g) return;
    const t = getComputedStyle(g).transform;
    const m = new DOMMatrixReadOnly(t === "none" ? undefined : t);
    const L = g.offsetLeft + m.m41;
    const T = g.offsetTop + m.m42;
    const k = LENS_ZOOM / LENS_SCALE;
    g.querySelectorAll<HTMLElement>(".lens-copy").forEach((c, i) => {
      c.style.transformOrigin = `${L + g.offsetWidth / 2}px ${T + g.offsetHeight / 2}px`;
      c.style.transform = `translate(${-L}px, ${-T}px) scale(${(i ? k * 1.035 : k).toFixed(4)})`;
    });
  };

  const loop = () => {
    place();
    if (drag?.on || performance.now() < until) raf = requestAnimationFrame(loop);
    else {
      raf = 0;
      pill()?.classList.remove("lensing");
    }
  };

  /** Liga a lente por `ms` (ou enquanto o dedo arrasta). */
  const lens = (ms: number) => {
    const p = pill();
    const g = glider();
    if (!p || !g) return;
    if (!p.classList.contains("lensing")) build(p, g);
    place();
    p.classList.add("lensing");
    until = performance.now() + ms;
    if (!raf) raf = requestAnimationFrame(loop);
  };


  addEventListener("pointerdown", (e) => {
    const p = pill();
    const g = glider();
    if (!p || !g || !p.contains(e.target as Node) || !isPhone()) return;
    drag = { id: e.pointerId, x0: e.clientX, on: false, base: parseFloat(getComputedStyle(g).left) || 0, w: g.offsetWidth };
  }, { passive: true });

  addEventListener("pointermove", (e) => {
    const p = pill();
    const g = glider();
    if (!drag || e.pointerId !== drag.id || !p || !g) return;
    const dx = e.clientX - drag.x0;
    if (!drag.on) {
      if (Math.abs(dx) < 8) return;
      drag.on = true;
      p.classList.add("lens-drag");
      lens(0);
      haptic(6);
    }
    const pr = p.getBoundingClientRect();
    // a lente fica presa ao dedo (centro no dedo), sem passar das pontas
    const x = Math.max(6, Math.min(pr.width - drag.w - 6, e.clientX - pr.left - drag.w / 2));
    g.style.transform = `translateX(${x - drag.base}px)`;
  }, { passive: true });

  const end = (e: PointerEvent) => {
    const p = pill();
    const g = glider();
    const d = drag;
    drag = null;
    if (!d?.on || !p || !g) return;
    // solta: cai na aba mais perto do centro da lente e navega
    const c = g.getBoundingClientRect();
    const mid = c.left + c.width / 2;
    let best: HTMLElement | null = null;
    let dist = Infinity;
    for (const t of tabs()) {
      const r = t.getBoundingClientRect();
      const dd = Math.abs(r.left + r.width / 2 - mid);
      if (dd < dist) (dist = dd), (best = t);
    }
    p.classList.remove("lens-drag");
    g.style.transform = "";
    // soltou: a lente volta a ser a cápsula enquanto desliza para a aba (sem crescer de novo)
    until = 0;
    // o clique que viria depois do arrasto não conta; quem navega é a aba escolhida
    const swallow = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); };
    addEventListener("click", swallow, { capture: true, once: true });
    setTimeout(() => removeEventListener("click", swallow, { capture: true }), 50);
    if (e.type !== "pointercancel" && best && !best.classList.contains("active")) setTimeout(() => best.click(), 0);
  };
  addEventListener("pointerup", end);
  addEventListener("pointercancel", end);
  addEventListener("dragstart", (e) => pill()?.contains(e.target as Node) && e.preventDefault());
}

/** Como o tabBarMinimizeBehavior(.onScrollDown) do iOS: rolou para baixo, a barra encolhe; para cima, volta. */
function tabbarMinimize() {
  let last = 0;
  document.addEventListener("scroll", (e) => {
    const el = e.target as HTMLElement;
    if (!isPhone() || !el.classList?.contains("main")) return;
    const y = el.scrollTop;
    const bar = document.querySelector(".tabbar");
    if (!bar) return;
    if (y < 40 || y < last - 6) bar.classList.remove("min");
    else if (y > last + 6) bar.classList.add("min");
    if (Math.abs(y - last) > 6) last = y;
  }, { capture: true, passive: true });
}

export function installLiquidGlass() {
  tabbarMinimize();
  if (lessMotion()) return;
  tabbarLens();
}

/* ---------- Voltar arrastando da borda esquerda ---------- */
/** Só em tela de detalhe (ex.: /executions/123, conversa aberta em Recados) e com o app instalado:
 *  no navegador o próprio sistema já tem esse gesto. */
function isDetail() {
  const parts = location.pathname.split("/").filter(Boolean);
  const hasBack = ((history.state as { idx?: number } | null)?.idx ?? 0) > 0;
  return hasBack && ((parts.length > 1 && parts[0] !== "aba") || /[?&]r=/.test(location.search));
}

export function installEdgeBack() {
  let drag: { x0: number; y0: number; on: boolean; trail: { t: number; x: number }[]; el: HTMLElement; shade: HTMLElement } | null = null;
  const EDGE = 24;

  const reset = (el: HTMLElement, shade: HTMLElement) => {
    el.style.transition = "";
    el.style.transform = "";
    el.classList.remove("edge-dragging");
    shade.remove();
  };

  addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1 || !isPhone() || !isStandalone() || !isDetail()) return;
    const t = e.touches[0]!;
    if (t.clientX > EDGE) return;
    const el = document.querySelector<HTMLElement>(".main > .route-fade");
    if (!el) return;
    const shade = document.createElement("div");
    shade.className = "edge-back-shade";
    drag = { x0: t.clientX, y0: t.clientY, on: false, trail: [{ t: e.timeStamp, x: t.clientX }], el, shade };
  }, { passive: true });

  addEventListener("touchmove", (e) => {
    if (!drag) return;
    const t = e.touches[0]!;
    const dx = t.clientX - drag.x0;
    const dy = t.clientY - drag.y0;
    if (!drag.on) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) return void (drag = null);
      if (dx < 10) return;
      drag.on = true;
      drag.x0 = t.clientX; // começa daqui, sem pulo
      drag.el.classList.add("edge-dragging");
      document.body.appendChild(drag.shade);
    }
    if (e.cancelable) e.preventDefault();
    const x = Math.max(0, t.clientX - drag.x0);
    drag.el.style.transform = `translateX(${x}px)`;
    drag.shade.style.opacity = String(1 - x / innerWidth);
    drag.trail.push({ t: e.timeStamp, x: t.clientX });
    while (drag.trail.length > 2 && e.timeStamp - drag.trail[0]!.t > 100) drag.trail.shift();
  }, { passive: false });

  const end = (e: TouchEvent) => {
    const d = drag;
    drag = null;
    if (!d?.on) return;
    const a = d.trail[0]!;
    const b = d.trail[d.trail.length - 1]!;
    const v = b.t - a.t > 8 ? ((b.x - a.x) / (b.t - a.t)) * 1000 : 0;
    const x = Math.max(0, b.x - d.x0);
    // projeta para onde o dedo ia (mesma conta da folha do celular)
    const projected = x + ((v / 1000) * 0.998) / (1 - 0.998);
    const leave = e.type !== "touchcancel" && v > -100 && projected > innerWidth / 2;
    const ms = lessMotion() ? 0 : 320;
    d.el.style.transition = `transform ${ms}ms cubic-bezier(.32,.72,0,1)`;
    d.shade.style.transition = `opacity ${ms}ms`;
    d.el.style.transform = leave ? `translateX(${innerWidth}px)` : "translateX(0)";
    d.shade.style.opacity = "0";
    setTimeout(() => {
      if (leave) {
        haptic(6);
        history.back();
        // a tela de trás entra no lugar; espera o React trocar antes de limpar
        setTimeout(() => reset(d.el, d.shade), 60);
      } else reset(d.el, d.shade);
    }, ms);
  };
  addEventListener("touchend", end);
  addEventListener("touchcancel", end);
}

/* ---------- Menu de toque longo ---------- */
export type MenuItem = { label: string; icon?: string; danger?: boolean; onSelect: () => void };

function ContextMenu({ x, y, title, items, onDone }: { x: number; y: number; title?: string; items: MenuItem[]; onDone: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // abre do lado do dedo, sem sair da tela
    const r = el.getBoundingClientRect();
    const left = Math.min(Math.max(16, x - 24), innerWidth - r.width - 16);
    const top = y + r.height + 16 > innerHeight ? Math.max(16, y - r.height - 8) : y + 8;
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.setProperty("--ctx-origin", `${x - left}px ${top < y ? r.height : 0}px`);
    el.querySelector<HTMLElement>(".ctx-item")?.focus({ preventScroll: true });
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onDone();
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [x, y, onDone]);
  return (
    <div className="ctx-layer">
      <div className="ctx-scrim" onClick={onDone} onContextMenu={(e) => { e.preventDefault(); onDone(); }} />
      <div className="ctx-menu" ref={box} role="menu" aria-label={title ?? "Ações"}>
        {title && <div className="ctx-title">{title}</div>}
        {items.map((it) => (
          <button key={it.label} type="button" role="menuitem" className={`ctx-item ${it.danger ? "danger" : ""}`} onClick={() => { onDone(); it.onSelect(); }}>
            <span>{it.label}</span>
            {it.icon && <Icon name={it.icon} size={18} />}
          </button>
        ))}
      </div>
    </div>
  );
}

export function openContextMenu(x: number, y: number, items: MenuItem[], title?: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const back = document.activeElement as HTMLElement | null;
  const done = () => {
    root.unmount();
    host.remove();
    back?.focus?.({ preventScroll: true });
  };
  root.render(<ContextMenu x={x} y={y} items={items} title={title} onDone={done} />);
}

/**
 * Segurar o dedo (ou clique direito no computador) abre o menu de ações do item.
 * Um hook serve a lista toda: `items` recebe o elemento tocado (use data-id nele).
 * Depois do toque longo, o clique que viria em seguida é ignorado.
 */
export function useLongPress(items: (el: HTMLElement) => MenuItem[], title?: (el: HTMLElement) => string | undefined) {
  const timer = useRef<number>(0);
  const start = useRef<{ x: number; y: number; el: HTMLElement } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    clearTimeout(timer.current);
    start.current?.el.classList.remove("long-pressing");
    start.current = null;
  };
  const open = (x: number, y: number, el: HTMLElement) => {
    const list = items(el);
    if (list.length) openContextMenu(x, y, list, title?.(el));
  };
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.pointerType === "mouse") return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY, el: e.currentTarget };
      const el = e.currentTarget;
      timer.current = window.setTimeout(() => {
        el.classList.add("long-pressing");
        timer.current = window.setTimeout(() => {
          const s = start.current;
          cancel();
          if (!s) return;
          fired.current = true;
          haptic(12);
          open(s.x, s.y, s.el);
        }, 330);
      }, 120);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onContextMenu: (e: React.MouseEvent<HTMLElement>) => {
      e.preventDefault();
      if (fired.current) return;
      cancel();
      open(e.clientX, e.clientY, e.currentTarget);
    },
    onClickCapture: (e: React.MouseEvent) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

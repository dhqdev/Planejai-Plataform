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
  document.querySelectorAll<HTMLElement>(SEG).forEach((box) => {
    const on = box.querySelector<HTMLElement>(":scope > button.active, :scope > button[aria-selected='true'], :scope > a.active");
    if (!on || !box.offsetParent) {
      box.style.setProperty("--seg-o", "0");
      return;
    }
    box.style.setProperty("--seg-x", `${on.offsetLeft}px`);
    box.style.setProperty("--seg-w", `${on.offsetWidth}px`);
    box.style.setProperty("--seg-y", `${on.offsetTop}px`);
    box.style.setProperty("--seg-h", `${on.offsetHeight}px`);
    box.style.setProperty("--seg-o", "1");
    // primeira vez: aparece já no lugar; depois desliza
    if (!box.dataset.seg) {
      box.dataset.seg = "ready";
      requestAnimationFrame(() => requestAnimationFrame(() => (box.dataset.seg = "on")));
    }
  });
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
  // barra do celular: a gota estica enquanto viaja para a aba nova
  let lastI = "";
  new MutationObserver(() => {
    const pill = document.querySelector<HTMLElement>(".tabbar-pill");
    const i = pill?.style.getPropertyValue("--i") ?? "";
    if (!pill || i === lastI) return;
    const first = lastI === "";
    lastI = i;
    const g = pill.querySelector<HTMLElement>(".tab-glider");
    if (!g || first) return;
    g.classList.remove("moving");
    void g.offsetWidth;
    g.classList.add("moving");
    dispatchEvent(new Event("pj:tab-move"));
  }).observe(document.querySelector(".layout") ?? document.body, { subtree: true, attributes: true, attributeFilter: ["style"] });
  document.fonts?.ready.then(schedule);
  schedule();
}

/* ---------- Vidro líquido: lente que aumenta o que passa por baixo ---------- */
/**
 * Como no iOS 26: a pastilha do menu e a gota da barra do celular são lentes. O "aproximar" é o ícone ou
 * o texto embaixo crescendo conforme a lente passa por cima (igual em todo navegador; filtro SVG no
 * backdrop-filter saiu desalinhado no Chrome e não existe no Safari). A gota da barra segue o dedo
 * (arrastar de aba em aba); a pastilha do menu lateral só anda no clique.
 */
/** Aumenta cada item conforme a distância até o centro da lente (1 = em cima, 0 = longe). */
function magnify(items: HTMLElement[], lens: DOMRect, axis: "x" | "y", max: number) {
  const c = axis === "x" ? lens.left + lens.width / 2 : lens.top + lens.height / 2;
  const reach = axis === "x" ? lens.width : lens.height;
  for (const el of items) {
    const r = el.getBoundingClientRect();
    const d = Math.abs((axis === "x" ? r.left + r.width / 2 : r.top + r.height / 2) - c);
    const k = Math.max(0, 1 - d / reach);
    el.style.setProperty("--lens", (1 + max * k * k).toFixed(3));
  }
}

/** Enquanto algo anima, recalcula o aumento a cada quadro (a lente está no meio do caminho). */
function follow(items: () => HTMLElement[], lens: () => HTMLElement | null, axis: "x" | "y", max: number, ms: number) {
  const until = performance.now() + ms;
  const tick = () => {
    const l = lens();
    if (l) magnify(items(), l.getBoundingClientRect(), axis, max);
    if (performance.now() < until) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function tabbarLens() {
  const pill = () => document.querySelector<HTMLElement>(".tabbar-pill");
  const glider = () => pill()?.querySelector<HTMLElement>(".tab-glider") ?? null;
  const icons = () => [...(pill()?.querySelectorAll<HTMLElement>(".tab .tab-ico") ?? [])];
  const tabs = () => [...(pill()?.querySelectorAll<HTMLElement>(".tab") ?? [])];
  let drag: { id: number; x0: number; on: boolean; base: number; w: number } | null = null;

  // trocou de aba (toque ou rota): a lente viaja e vai aumentando o que cruza
  addEventListener("pj:tab-move", () => follow(icons, glider, "x", 0.32, 700));

  addEventListener("pointerdown", (e) => {
    const p = pill();
    const g = glider();
    if (!p || !g || !p.contains(e.target as Node) || !isPhone()) return;
    drag = { id: e.pointerId, x0: e.clientX, on: false, base: parseFloat(getComputedStyle(g).left) || 0, w: g.getBoundingClientRect().width };
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
      haptic(6);
    }
    const pr = p.getBoundingClientRect();
    // a lente fica presa ao dedo (centro no dedo), sem passar das pontas
    const x = Math.max(6, Math.min(pr.width - drag.w - 6, e.clientX - pr.left - drag.w / 2));
    g.style.transform = `translateX(${x - drag.base}px)`;
    magnify(icons(), g.getBoundingClientRect(), "x", 0.42);
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
    follow(icons, glider, "x", 0.32, 700);
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

/** Menu lateral: a pastilha só anda quando o item é clicado; enquanto ela viaja, o texto embaixo cresce. */
function sidebarLens() {
  const nav = () => document.querySelector<HTMLElement>(".sidebar .nav");
  const links = () => [...(nav()?.querySelectorAll<HTMLElement>(":scope > a") ?? [])];
  const lensBox = (n: HTMLElement) => {
    const st = getComputedStyle(n, "::before");
    const m = new DOMMatrixReadOnly(st.transform === "none" ? undefined : st.transform);
    const r = n.getBoundingClientRect();
    return new DOMRect(r.left + m.m41, r.top + m.m42, parseFloat(st.width), parseFloat(st.height));
  };
  document.addEventListener("click", (e) => {
    const n = nav();
    if (!n || !(e.target as Element | null)?.closest?.(".sidebar .nav > a")) return;
    const until = performance.now() + 650;
    const tick = () => {
      magnify(links(), lensBox(n), "y", 0.07);
      if (performance.now() < until) requestAnimationFrame(tick);
      else links().forEach((a) => a.style.removeProperty("--lens"));
    };
    requestAnimationFrame(tick);
  });
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
  sidebarLens();
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

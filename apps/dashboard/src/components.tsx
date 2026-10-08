import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot } from "react-dom/client";
import { AgentFace, CORE_FACES } from "./faces";
import { Icon } from "./icons";
import { haptic } from "./touch";

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Status({ status }: { status: string }) {
  const map: Record<string, [string, string]> = {
    success: ["badge-ok", "Sucesso"],
    error: ["badge-err", "Erro"],
    running: ["badge-warn", "Rodando"],
    active: ["badge-ok", "Ativo"],
    pending: ["badge-warn", "Aguardando aprovação"],
    blocked: ["badge-err", "Bloqueado"],
    scheduled: ["badge-info", "Agendado"],
    done: ["badge-ok", "Enviado"],
    cancelled: ["", "Cancelado"],
    failed: ["badge-err", "Falhou"],
  };
  const [cls, label] = map[status] ?? ["", status];
  const dot = status === "success" || status === "active" || status === "done" ? "dot-ok" : status === "error" || status === "failed" ? "dot-err" : status === "running" ? "dot-warn" : "";
  return (
    <span className={`badge ${cls}`}>
      {dot && <span className={`dot ${dot}`} />}
      {label}
    </span>
  );
}

const isPhone = () => matchMedia("(max-width: 767px)").matches;
/** Campo que abre teclado ou a roleta do sistema (select também, no iOS). */
const isEditable = (el: Element | null) => !!el?.matches("input:not([type=checkbox]):not([type=radio]):not([type=button]), textarea, select, [contenteditable]");
const lessMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const FOCUSABLE = "a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])";
/** Janelas abertas, da mais antiga para a mais nova: Esc fecha só a de cima. */
const openModals: object[] = [];

// Folha do celular: mola sem quique (amortecimento crítico, resposta ~0,3 s) que sempre parte da posição
// e da velocidade atuais, então dá para pegar no meio do caminho e inverter.
const STIFFNESS = 440;
const DAMPING = 2 * Math.sqrt(STIFFNESS);
/** Onde o gesto iria parar se continuasse desacelerando (mesma conta da rolagem do iOS). v em px/s. */
const project = (v: number, rate = 0.998) => ((v / 1000) * rate) / (1 - rate);
/** Passou do limite: acompanha cada vez menos o dedo, em vez de travar. */
const rubberBand = (over: number, size: number, c = 0.55) => (over * size * c) / (size + c * over);

/** Algum ancestral (até a folha) está rolado para baixo? Então o gesto é de rolagem, não de fechar. */
function scrolledInside(from: Element, root: Element) {
  for (let n: Element | null = from; n && n !== root; n = n.parentElement) if (n.scrollTop > 0) return true;
  return false;
}
function insideScroller(from: Element, root: Element) {
  for (let n: Element | null = from; n && n !== root; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(n).overflowY)) return true;
  }
  return false;
}

type ModalProps = {
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
  /** Rodapé; como função recebe o "fechar" animado (para botões como Cancelar). */
  footer?: ReactNode | ((close: () => void) => ReactNode);
  wide?: boolean;
  className?: string;
  /** Pede uma resposta (confirmações): vira role="alertdialog". */
  alert?: boolean;
};

/**
 * Modal arrastável. No computador e no iPad, segure o cabeçalho para mover a janela.
 * No celular vira "bottom sheet": sobe de baixo, acompanha o dedo e fecha ao arrastar ou dar um peteleco
 * para baixo (decide pela velocidade, não só pela distância). Dá para pegar a folha no meio da animação.
 * Fecha também tocando fora ou com Esc, prende o foco dentro e devolve para quem abriu.
 */
export function Modal({ title, icon, onClose, children, footer, wide, className, alert }: ModalProps) {
  const sheet = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const move = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const offset = useRef({ x: 0, y: 0 });
  const [closing, setClosing] = useState(false);
  const bodyId = useId();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // estado da folha fora do React: muda a cada quadro
  const g = useRef({ y: 0, v: 0, h: 0, raf: 0, timer: 0, leaving: false });

  const paint = () => {
    const s = g.current;
    if (sheet.current) sheet.current.style.transform = s.y ? `translate3d(0, ${s.y}px, 0)` : "";
    if (scrim.current) scrim.current.style.opacity = String(1 - Math.min(1, Math.max(0, s.y / (s.h || 1))));
  };
  const stop = () => {
    cancelAnimationFrame(g.current.raf);
    clearTimeout(g.current.timer);
    g.current.raf = 0;
  };
  const spring = (target: number, done?: () => void) => {
    const s = g.current;
    stop();
    let last = performance.now();
    const tick = (now: number) => {
      // passos fixos de 4 ms pelo tempo que passou de verdade: quadro perdido não deixa a folha em câmera lenta
      const steps = Math.max(1, Math.min(64, Math.round((now - last) / 4)));
      last = now;
      for (let i = 0; i < steps; i++) {
        s.v += (-STIFFNESS * (s.y - target) - DAMPING * s.v) * 0.004;
        s.y += s.v * 0.004;
      }
      // saindo: basta sumir da tela; voltando: espera assentar
      if (target > 0 ? s.y >= s.h : Math.abs(s.y) < 0.5 && Math.abs(s.v) < 20) {
        s.y = target > 0 ? s.h : 0;
        s.v = 0;
        s.raf = 0;
        clearTimeout(s.timer);
        paint();
        done?.();
        return;
      }
      paint();
      s.raf = requestAnimationFrame(tick);
    };
    s.raf = requestAnimationFrame(tick);
  };

  const close = useCallback(() => {
    const s = g.current;
    if (s.leaving) return;
    s.leaving = true;
    const finish = () => onCloseRef.current();
    if (!isPhone() || lessMotion() || !sheet.current) {
      setClosing(true);
      s.timer = window.setTimeout(finish, 160);
      return;
    }
    s.h = sheet.current.offsetHeight;
    spring(s.h + 24, finish);
    // aba em segundo plano não roda requestAnimationFrame: fecha mesmo assim
    s.timer = window.setTimeout(() => {
      stop();
      finish();
    }, 700);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // celular: a folha sobe com a mesma mola (e não com keyframes), para poder ser pega no meio do caminho
  useLayoutEffect(() => {
    const el = sheet.current;
    const s = g.current;
    if (el && isPhone() && !lessMotion()) {
      s.h = el.offsetHeight;
      s.y = s.h;
      s.v = 0;
      paint();
      spring(0);
    }
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = sheet.current!;
    const id = {};
    const opener = document.activeElement as HTMLElement | null;
    openModals.push(id);
    // um campo com autoFocus já pegou o foco; senão ele vai para a janela
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true });
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && openModals[openModals.length - 1] === id) close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      openModals.splice(openModals.indexOf(id), 1);
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
      // devolve o foco para quem abriu (só quando a janela saiu mesmo da tela)
      setTimeout(() => {
        if (!el.isConnected && opener?.isConnected) opener.focus({ preventScroll: true });
      }, 0);
    };
  }, [close]);

  // celular: o fundo da janela acompanha a área visível de verdade (visualViewport). Com teclado ou a roleta
  // do select abertos a folha fica logo acima deles; quando fecham, ela volta para o pé da tela.
  // O iOS às vezes não avisa que o teclado fechou (comum ao sair de um campo para um select), então
  // também mede de novo ao trocar de campo e desfaz a rolagem que ele deixa na página.
  useEffect(() => {
    const vv = window.visualViewport;
    const bg = sheet.current?.parentElement;
    if (!vv || !bg) return;
    let raf = 0;
    const timers: number[] = [];
    const fit = () => {
      raf = 0;
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      bg.style.setProperty("--vvtop", `${vv.offsetTop}px`);
      bg.style.setProperty("--vvh", `${vv.height}px`);
      bg.classList.toggle("kb-open", kb > 120);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(fit);
    };
    const later = (...ms: number[]) => {
      for (const t of ms) timers.push(window.setTimeout(schedule, t));
    };
    // campo focado fica visível dentro da folha (o teclado tira metade da altura)
    const reveal = (field: Element) => {
      const body = sheet.current?.querySelector<HTMLElement>(".modal-body");
      if (!body || !body.contains(field)) return;
      const f = field.getBoundingClientRect();
      const b = body.getBoundingClientRect();
      if (f.bottom > b.bottom - 12) body.scrollTop += f.bottom - b.bottom + 12;
      else if (f.top < b.top + 12) body.scrollTop -= b.top + 12 - f.top;
    };
    const onFocusIn = (e: FocusEvent) => {
      later(50, 300);
      const t = e.target as Element;
      if (isEditable(t)) timers.push(window.setTimeout(() => reveal(t), 350));
    };
    const onFocusOut = () => {
      later(50, 300, 700);
      timers.push(
        window.setTimeout(() => {
          // saiu de um campo e não entrou em outro: teclado fechou, página volta para o lugar
          if (!isEditable(document.activeElement) && (window.scrollY || vv.offsetTop)) window.scrollTo(0, 0);
          schedule();
        }, 120),
      );
    };
    fit();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    window.addEventListener("resize", schedule);
    bg.addEventListener("focusin", onFocusIn);
    bg.addEventListener("focusout", onFocusOut);
    const onChange = () => later(50, 400);
    bg.addEventListener("change", onChange);
    return () => {
      cancelAnimationFrame(raf);
      timers.forEach(clearTimeout);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      bg.removeEventListener("focusin", onFocusIn);
      bg.removeEventListener("focusout", onFocusOut);
      bg.removeEventListener("change", onChange);
    };
  }, []);

  // celular: arrastar a folha. Listeners nativos porque o touchmove do React é passivo (não segura a rolagem).
  useEffect(() => {
    const el = sheet.current!;
    const s = g.current;
    type Drag = { id: number; x: number; y: number; base: number; on: boolean; free: boolean; target: Element; trail: { t: number; y: number }[] };
    let drag: Drag | null = null;
    const finger = (list: TouchList) => Array.from(list).find((t) => t.identifier === drag?.id);

    const start = (e: TouchEvent) => {
      // um dedo só: o segundo não rouba a folha
      if (!isPhone() || drag || e.touches.length !== 1) return;
      const t = e.target as Element;
      if (t.closest("input, textarea, select, [contenteditable], [data-drop], [data-no-drag]")) return;
      const p = e.touches[0]!;
      // pegou a folha em movimento (abrindo, voltando ou fechando): ela para na mão
      const moving = s.raf !== 0 || s.y !== 0;
      if (moving) {
        stop();
        s.leaving = false;
      }
      s.h = el.offsetHeight;
      drag = { id: p.identifier, x: p.clientX, y: p.clientY, base: s.y, on: moving, free: !insideScroller(t, el), target: t, trail: [{ t: e.timeStamp, y: p.clientY }] };
    };
    const onMove = (e: TouchEvent) => {
      const p = drag && finger(e.touches);
      if (!drag || !p) return;
      const dx = p.clientX - drag.x;
      const dy = p.clientY - drag.y;
      if (!drag.on) {
        // ainda decidindo: gesto de lado ou conteúdo que rola ficam com o navegador
        if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 6) return void (drag = null);
        if (!drag.free && (dy < 0 || scrolledInside(drag.target, el))) return void (drag = null);
        if (e.cancelable) e.preventDefault();
        if (Math.abs(dy) < 6) return;
        // passou da folga: começa daqui, sem pulo
        drag.on = true;
        drag.y = p.clientY;
      }
      if (e.cancelable) e.preventDefault();
      const raw = drag.base + p.clientY - drag.y;
      s.y = raw >= 0 ? raw : -rubberBand(-raw, innerHeight * 0.25);
      drag.trail.push({ t: e.timeStamp, y: p.clientY });
      while (drag.trail.length > 2 && e.timeStamp - drag.trail[0]!.t > 100) drag.trail.shift();
      paint();
    };
    const end = (e: TouchEvent) => {
      if (!drag || finger(e.touches)) return;
      const d = drag;
      drag = null;
      if (!d.on) return;
      const a = d.trail[0]!;
      const b = d.trail[d.trail.length - 1]!;
      // velocidade dos últimos ~100 ms; dedo parado antes de soltar conta como zero
      let v = b.t - a.t > 8 && e.timeStamp - b.t < 80 ? ((b.y - a.y) / (b.t - a.t)) * 1000 : 0;
      v = Math.max(-4000, Math.min(4000, v));
      s.v = s.y < 0 ? 0 : v;
      // subindo: fica. Senão, fecha se o movimento for parar além da metade da folha.
      const leave = e.type !== "touchcancel" && v > -50 && s.y + project(v) > s.h * 0.5;
      if (lessMotion()) {
        if (!leave) s.y = 0;
        paint();
        if (leave) close();
      } else if (leave) {
        haptic(8);
        close();
      } else spring(0);
    };
    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [close]);

  // mover a janela pelo cabeçalho (fora do celular)
  const onHeadDown = (e: React.PointerEvent) => {
    if (isPhone() || (e.target as Element).closest("button")) return;
    move.current = { x: e.clientX, y: e.clientY, ox: offset.current.x, oy: offset.current.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onHeadMove = (e: React.PointerEvent) => {
    if (!move.current || !sheet.current) return;
    const r = sheet.current.getBoundingClientRect();
    const maxX = (innerWidth - r.width) / 2 + r.width - 80;
    const maxY = (innerHeight - r.height) / 2 + r.height - 60;
    const x = Math.max(-maxX, Math.min(maxX, move.current.ox + e.clientX - move.current.x));
    const y = Math.max(-((innerHeight - r.height) / 2) - 0, Math.min(maxY, move.current.oy + e.clientY - move.current.y));
    offset.current = { x, y };
    sheet.current.style.animation = "none";
    sheet.current.style.transform = `translate(${x}px, ${y}px)`;
  };
  const onHeadUp = () => {
    move.current = null;
  };

  // Tab dá a volta dentro da janela
  const onKeyDown = (e: React.KeyboardEvent) => {
    const el = sheet.current;
    if (e.key !== "Tab" || !el || !el.contains(e.target as Node)) return;
    const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => n.offsetParent !== null);
    const first = items[0];
    const last = items[items.length - 1];
    const at = document.activeElement;
    if (!first || !last) return e.preventDefault();
    if (e.shiftKey ? at === first || at === el : at === last) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  };

  // vai direto no <body>: nada da página (animações, transform) muda a posição do modal
  return createPortal(
    <div className={`modal-bg ${closing ? "closing" : ""}`}>
      <div className="modal-scrim" ref={scrim} onMouseDown={close} />
      <div
        className={`card modal ${wide ? "wide" : ""} ${className ?? ""}`}
        role={alert ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-label={title}
        aria-describedby={alert ? bodyId : undefined}
        tabIndex={-1}
        ref={sheet}
        onKeyDown={onKeyDown}
      >
        <div className="sheet-handle" aria-hidden="true" />
        <div className="modal-head" onPointerDown={onHeadDown} onPointerMove={onHeadMove} onPointerUp={onHeadUp} onPointerCancel={onHeadUp}>
          {icon}
          <strong title={title}>{title}</strong>
          <span className="spacer" />
          <button className="icon-btn" onClick={close} aria-label="Fechar">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body" id={bodyId}>{children}</div>
        {footer && <div className="modal-foot">{typeof footer === "function" ? footer(close) : footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

type ConfirmOptions = {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  /** null esconde o Cancelar (vira um aviso com um botão só). */
  cancelLabel?: string | null;
  /** Ação sem volta (apagar, desconectar): botão vermelho e o foco começa em Cancelar. */
  danger?: boolean;
};

function ConfirmDialog({ title, body, confirmLabel = "Confirmar", cancelLabel = "Cancelar", danger, onDone }: ConfirmOptions & { onDone: (ok: boolean) => void }) {
  const ok = useRef(false);
  const safe = danger && cancelLabel != null;
  return (
    <Modal
      alert
      title={title}
      className="confirm"
      onClose={() => onDone(ok.current)}
      footer={(close) => (
        <>
          {cancelLabel != null && <button className="btn" autoFocus={safe} onClick={close}>{cancelLabel}</button>}
          <button className={`btn ${danger ? "btn-danger-solid" : "btn-primary"}`} autoFocus={!safe} onClick={() => { ok.current = true; close(); }}>{confirmLabel}</button>
        </>
      )}
    >
      {body != null && <p className="confirm-text">{body}</p>}
    </Modal>
  );
}

/**
 * Confirmação no estilo do app, no lugar do confirm() do navegador: `if (!(await confirmDialog({...}))) return`.
 * Resolve true só se a pessoa confirmou (Esc, tocar fora e arrastar a folha contam como cancelar).
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    root.render(
      <ConfirmDialog
        {...options}
        onDone={(ok) => {
          root.unmount();
          host.remove();
          resolve(ok);
        }}
      />,
    );
  });
}

/** Aviso com um botão só, no lugar do alert(). */
export const alertDialog = (title: string, body?: ReactNode) => confirmDialog({ title, body, confirmLabel: "Entendi", cancelLabel: null }).then(() => undefined);

/** Primeira letra do nome para o avatar; emoji e letra acentuada contam como uma só. */
export function initial(name: string | null | undefined) {
  const first = Array.from((name ?? "").trim())[0];
  return first ? first.toUpperCase() : "?";
}

export function Json({ value }: { value: unknown }) {
  if (value == null) return <pre className="json muted">vazio</pre>;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="json">{text}</pre>;
}

/** Dentro do app nada de animação de carregando: a tela aparece quando os dados chegam (o carregando é só na abertura). */
export function Loading() {
  return null;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error-box">{error}</div> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

const ICONS: Record<string, string> = {
  google: "calendar",
  notion: "bookmark",
  github: "github",
  linear: "target",
  slack: "hash",
  search: "search",
  browser: "globe",
  payment: "card",
  shop: "shop",
  send: "send",
  workflow: "graph",
};

export function IntegrationIcon({ icon }: { icon: string }) {
  return (
    <div className="logo">
      <Icon name={ICONS[icon] ?? "plug"} size={20} />
    </div>
  );
}

export const AGENT_LABEL: Record<string, string> = {
  cto: "CTO",
  pesquisador: "Pesquisador",
  agenda: "Agenda",
  financeiro: "Financeiro",
  comunicacao: "Comunicação",
  produtividade: "Produtividade",
};

export const AGENT_ICON: Record<string, string> = {
  cto: "brain",
  pesquisador: "search",
  agenda: "calendar",
  financeiro: "wallet",
  comunicacao: "mail",
  produtividade: "folder",
};

/** Nome do agente com ícone (agentes de cliente vêm como c_<slug>). */
export function AgentTag({ id, name }: { id: string; name?: string }) {
  return (
    <span className="row" style={{ gap: 6, display: "inline-flex" }}>
      {CORE_FACES[id] ? <AgentFace face={CORE_FACES[id]!.face} size={18} /> : <Icon name={id.startsWith("c_") ? "sparkle" : "circle"} size={14} />}
      {name ?? (CORE_FACES[id] ? `${CORE_FACES[id]!.persona} · ${AGENT_LABEL[id]}` : id.replace(/^c_/, ""))}
    </span>
  );
}

/** Caixa com texto para copiar (links de convite etc.). */
export function CopyField({ value }: { value: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="copy">
      <code>{value}</code>
      <button
        className="icon-btn"
        aria-label="Copiar"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
          } catch {
            /* sem permissão */
          }
          setOk(true);
          setTimeout(() => setOk(false), 1400);
        }}
      >
        <Icon name={ok ? "check" : "copy"} size={15} />
      </button>
    </div>
  );
}

/** Cores das categorias: tons foscos que se distinguem no claro e no escuro (a maior começa no violeta da marca), depois cinzas. */
export const CATEGORY_COLORS = ["#6d4fd8", "#e07a2f", "#2a9d8f", "#d1537e", "#3f7fd6", "#8a9a2b", "#b0663a", "#5a67c4", "#9aa0a6", "#c2c5ca", "#7d7d78", "#b5b5af", "#5f5f5a", "#dcdcd6"];

/** Rosca SVG simples (sem biblioteca) para gastos por categoria. */
export function Donut({ items, size = 150, center }: { items: { label: string; value: number }[]; size?: number; center?: ReactNode }) {
  const total = items.reduce((a, i) => a + i.value, 0);
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={14} />
        {total > 0 &&
          items.map((it, i) => {
            const len = (it.value / total) * c;
            const el = (
              <circle key={it.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} strokeWidth={14}
                strokeDasharray={`${len} ${c - len}`} strokeDashoffset={-offset}>
                <title>{it.label}</title>
              </circle>
            );
            offset += len;
            return el;
          })}
      </svg>
      {center && <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center", fontSize: 12 }}>{center}</div>}
    </div>
  );
}

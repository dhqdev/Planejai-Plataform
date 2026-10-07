import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AgentFace, CORE_FACES } from "./faces";
import { Icon } from "./icons";
import { BlockLoader } from "./BlockLoader";

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

/**
 * Modal arrastável. No computador e no iPad, segure o cabeçalho para mover a janela.
 * No celular vira "bottom sheet": sobe de baixo, tem alça e fecha arrastando para baixo.
 * Fecha também tocando fora ou com Esc, e trava a rolagem do fundo enquanto está aberto.
 */
export function Modal({ title, icon, onClose, children, footer, wide, className }: { title: string; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean; className?: string }) {
  const sheet = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const move = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const offset = useRef({ x: 0, y: 0 });
  const [closing, setClosing] = useState(false);
  const isPhone = () => matchMedia("(max-width: 767px)").matches;

  const close = useCallback(() => {
    setClosing(true);
    setTimeout(onClose, 180);
  }, [onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [close]);

  // celular: com o teclado aberto, a folha sobe junto e o campo não fica escondido
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const fit = () => {
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      sheet.current?.parentElement?.style.setProperty("--kb", `${kb}px`);
      sheet.current?.parentElement?.style.setProperty("--vvh", `${vv.height}px`);
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, []);

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

  // celular: arrastar para baixo fecha
  const onTouchStart = (e: React.TouchEvent) => {
    if (!isPhone()) return;
    // tocar em campo, botão ou link não arrasta a folha
    if ((e.target as Element).closest("input, textarea, select, button, a, label, [data-drop]")) return;
    const body = sheet.current?.querySelector(".modal-body");
    if (body && body.contains(e.target as Node) && body.scrollTop > 0) return;
    drag.current = { y: e.touches[0]!.clientY, dy: 0 };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!drag.current || !sheet.current) return;
    const dy = Math.max(0, e.touches[0]!.clientY - drag.current.y);
    drag.current.dy = dy;
    sheet.current.style.transition = "none";
    sheet.current.style.transform = `translateY(${dy}px)`;
  };
  const onTouchEnd = () => {
    if (!drag.current || !sheet.current) return;
    const { dy } = drag.current;
    drag.current = null;
    sheet.current.style.transition = "";
    if (dy > 110) {
      sheet.current.style.setProperty("--drag", `translateY(${dy}px)`);
      close();
    } else sheet.current.style.transform = "";
  };

  // vai direto no <body>: nada da página (animações, transform) muda a posição do modal
  return createPortal(
    <div className={`modal-bg ${closing ? "closing" : ""}`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className={`card modal ${wide ? "wide" : ""} ${className ?? ""}`} role="dialog" aria-modal="true" aria-label={title} ref={sheet} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
        <div className="sheet-handle" />
        <div className="modal-head" onPointerDown={onHeadDown} onPointerMove={onHeadMove} onPointerUp={onHeadUp} onPointerCancel={onHeadUp}>
          {icon}
          <strong>{title}</strong>
          <span className="spacer" />
          <button className="icon-btn" onClick={close} aria-label="Fechar">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Json({ value }: { value: unknown }) {
  if (value == null) return <pre className="json muted">vazio</pre>;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="json">{text}</pre>;
}

export function Loading() {
  return <BlockLoader />;
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

export function Stat({ label, value, sub, icon, tone }: { label: string; value: ReactNode; sub?: ReactNode; icon?: string; tone?: "ok" | "info" | "warn" }) {
  return (
    <div className={`card card-pad stat ${tone ?? ""}`}>
      {icon && (
        <div className="stat-ico">
          <Icon name={icon} size={16} />
        </div>
      )}
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

/** Paleta da marca para categorias (a mesma dos gráficos do WhatsApp), do laranja ao azul e depois cinzas. */
export const CATEGORY_COLORS = ["#FF7A1A", "#FF4458", "#E23382", "#B830C8", "#8B2BE2", "#5B45E8", "#2F7BEA", "#16A3A3", "#9AA0A6", "#C9CCD1", "#7d7d78", "#b5b5af", "#5f5f5a", "#dcdcd6"];

/** Rosca SVG simples (sem biblioteca) para gastos por categoria. */
export function Donut({ items, size = 150, center }: { items: { label: string; value: number }[]; size?: number; center?: ReactNode }) {
  const total = items.reduce((a, i) => a + i.value, 0);
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--panel-2)" strokeWidth={18} />
        {total > 0 &&
          items.map((it, i) => {
            const len = (it.value / total) * c;
            const el = (
              <circle key={it.label} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} strokeWidth={18}
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

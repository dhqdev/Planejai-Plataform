import type { ReactNode } from "react";

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

export function Modal({ title, icon, onClose, children, footer }: { title: string; icon?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="card modal">
        <div className="modal-head">
          {icon}
          <strong>{title}</strong>
          <span className="spacer" />
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Fechar">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  if (value == null) return <pre className="json muted">vazio</pre>;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="json">{text}</pre>;
}

export function Loading() {
  return <div className="empty">Carregando…</div>;
}

export function ErrorBox({ error }: { error: string | null }) {
  return error ? <div className="error-box">{error}</div> : null;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

const ICONS: Record<string, string> = {
  google: "G",
  notion: "N",
  github: "🐙",
  linear: "◐",
  slack: "#",
  search: "🔎",
  browser: "🌐",
  payment: "💳",
};

export function IntegrationIcon({ icon }: { icon: string }) {
  return <div className="logo">{ICONS[icon] ?? "🔌"}</div>;
}

export const AGENT_LABEL: Record<string, string> = {
  cto: "🧠 CTO",
  pesquisador: "🔎 Pesquisador",
  agenda: "📅 Agenda",
  financeiro: "💰 Financeiro",
  comunicacao: "✉️ Comunicação",
  produtividade: "🗂️ Produtividade",
};

export function Stat({ label, value, sub, icon, tone }: { label: string; value: ReactNode; sub?: ReactNode; icon?: string; tone?: "ok" | "info" | "warn" }) {
  return (
    <div className={`card card-pad stat ${tone ?? ""}`}>
      {icon && <div className="stat-ico">{icon}</div>}
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}

export const CATEGORY_COLORS = ["#ff6d5a", "#5b6cff", "#24a148", "#f5a524", "#9b5bff", "#00a3c4", "#e5484d", "#ff8ac2", "#7c8b2e", "#8d6e63", "#3fb68b", "#c27c0e", "#6e6e7d", "#2b6cb0"];

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

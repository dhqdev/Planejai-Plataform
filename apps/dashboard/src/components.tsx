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

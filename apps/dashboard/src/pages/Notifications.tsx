import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ago, api } from "../api";
import { Empty, ErrorBox, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";
import { refreshUnread } from "../notify";

interface Item { id: number; kind: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string }

const KIND_ICON: Record<string, string> = {
  cliente: "user-plus",
  limite: "wallet",
  lembrete: "calendar",
  conexao: "link",
  automacao: "repeat",
  seguranca: "shield",
  whatsapp: "phone",
};

export function NotificationsPage() {
  const nav = useNavigate();
  const { data, error, reload, setData } = useApi<{ items: Item[]; unread: number }>("/api/notifications", { poll: 30000 });
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [perm, setPerm] = useState(() => (typeof Notification === "undefined" ? "denied" : Notification.permission));
  const items = (data?.items ?? []).filter((n) => filter === "all" || !n.read_at);

  const markAll = async () => {
    haptic(10);
    await api("/api/notifications/read", { method: "POST", json: {}, headers: { "x-pj-quiet": "1" } });
    void reload();
    refreshUnread();
  };
  const open = async (n: Item) => {
    haptic();
    if (!n.read_at) {
      setData((d) => (d ? { ...d, unread: Math.max(0, d.unread - 1), items: d.items.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)) } : d));
      await api("/api/notifications/read", { method: "POST", json: { ids: [n.id] }, headers: { "x-pj-quiet": "1" } }).catch(() => {});
      refreshUnread();
    }
    if (n.link) nav(n.link);
  };

  return (
    <div className="page fit">
      <PageHead
        title="Notificações"
        subtitle="Avisos do sistema e do seu assistente. A bolinha no menu some quando você lê."
        actions={
          <div className="row">
            <div className="seg">
              <button className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>Todas</button>
              <button className={filter === "unread" ? "active" : ""} onClick={() => setFilter("unread")}>Não lidas{data?.unread ? ` · ${data.unread}` : ""}</button>
            </div>
            {perm === "default" && (
              <button className="btn btn-sm" onClick={async () => { haptic(); setPerm(await Notification.requestPermission()); }}>
                <Icon name="bell" size={15} /> Avisar no navegador
              </button>
            )}
            <button className="btn btn-sm" disabled={!data?.unread} onClick={markAll}><Icon name="check" size={15} /> Marcar todas como lidas</button>
          </div>
        }
      />
      <ErrorBox error={error} />
      <div className="card notif-list scroll-y">
        {items.map((n) => (
          <button key={n.id} className={`notif-item ${n.read_at ? "" : "unread"}`} onClick={() => open(n)}>
            <span className="notif-ico"><Icon name={KIND_ICON[n.kind] ?? "bell"} size={17} /></span>
            <span className="notif-text">
              <strong>{n.title}</strong>
              {n.body && <span className="muted">{n.body}</span>}
            </span>
            <span className="notif-when mono">{ago(n.created_at)}</span>
            {!n.read_at && <span className="notif-dot" aria-label="Não lida" />}
          </button>
        ))}
        {data && !items.length && <Empty>{filter === "unread" ? "Tudo lido." : "Nenhuma notificação ainda."}</Empty>}
      </div>
    </div>
  );
}

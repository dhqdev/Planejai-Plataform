import { AgentFace } from "../../faces";
import { Icon } from "../../icons";
import type { Outfit } from "../../mochi/Mochi";
import { UserMochi } from "../../mochi/UserMochi";
import { who, type AgentMeta } from "./labels";

export function AgentAvatar({ meta, size = 24 }: { meta: AgentMeta; size?: number }) {
  if (meta.face !== undefined) return <AgentFace face={meta.face} size={size} title={who(meta)} />;
  return (
    <span className="ex-avatar-ico" style={{ width: size, height: size }} title={meta.name}>
      <Icon name={meta.icon} size={Math.round(size * 0.55)} />
    </span>
  );
}

/** Pessoa da execução: o Mochi dela com a roupinha escolhida. Sem pessoa (lembrete, sistema), as iniciais do gatilho. */
export function PersonAvatar({ name, size = 30, userId, outfit }: { name?: string | null; size?: number; userId?: string | null; outfit?: Outfit | null }) {
  if (userId) return <UserMochi name={name} outfit={outfit} seed={userId} size={size} />;
  const initials = String(name ?? "?").trim().split(/\s+/).slice(0, 2).map((p) => p[0]).join("").toUpperCase() || "?";
  return <span className="ex-person" style={{ width: size, height: size, fontSize: size * 0.38 }}>{initials}</span>;
}

export function StatusIcon({ status, size = 28 }: { status: string; size?: number }) {
  return (
    <span className={`ex-st st-${status}`} style={{ width: size, height: size }} aria-label={status === "success" ? "ok" : status === "error" ? "erro" : status === "partial" ? "parcial" : "rodando"}>
      {status === "running" ? <span className="ex-spin" /> : <Icon name={status === "success" || status === "partial" ? "check" : "x"} size={Math.round(size * 0.5)} />}
    </span>
  );
}

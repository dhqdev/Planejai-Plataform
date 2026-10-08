import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Icon } from "../../icons";
import { AgentAvatar } from "./Avatars";
import { plural, usdBR } from "./format";
import { TRIGGER_LABEL, agentMeta, channelOf, personOf, toolIcon, toolLabel, who } from "./labels";
import { teamUsage, toolUsage, type Step } from "./steps";

/* ---------- Coluna lateral ---------- */

/** Resumo ao lado da História: quem trabalhou, com quais ferramentas e os dados da execução. */
export function DetailSide({ data, steps, clientAgents }: { data: any; steps: Step[]; clientAgents: any[] }) {
  return (
    <aside className="exd-side">
      <TeamCard steps={steps} clientAgents={clientAgents} />
      <ToolsCard steps={steps} />
      <InfoCard data={data} />
    </aside>
  );
}

function SideCard({ title, icon, children }: { title: string; icon: string; children: ReactNode }) {
  return (
    <div className="card exd-card">
      <div className="exd-card-head"><Icon name={icon} size={14} /><small>{title}</small></div>
      {children}
    </div>
  );
}

function TeamCard({ steps, clientAgents }: { steps: Step[]; clientAgents: any[] }) {
  const rows = useMemo(() => teamUsage(steps), [steps]);
  const total = rows.reduce((a, r) => a + r.cost, 0);
  return (
    <SideCard title="Quem trabalhou" icon="users">
      {rows.length ? (
        <div className="exd-team">
          {rows.map((r) => {
            const m = agentMeta(r.agent, clientAgents);
            return (
              <div key={r.agent} className="exd-team-row">
                <AgentAvatar meta={m} size={32} />
                <div className="exd-team-text">
                  <strong>{who(m)}</strong>
                  <small>{m.persona ? m.name : ""}{m.persona ? " · " : ""}{r.llm} IA · {plural(r.actions, "ação", "ações")}{r.errors ? ` · ${r.errors} erro${r.errors > 1 ? "s" : ""}` : ""}</small>
                  <span className="exd-bar"><i style={{ width: `${total ? Math.max(3, (r.cost / total) * 100) : 0}%` }} /></span>
                </div>
                <span className="mono exd-team-cost">{usdBR(r.cost)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted exd-none">Ninguém do time precisou entrar.</p>
      )}
    </SideCard>
  );
}

function ToolsCard({ steps }: { steps: Step[] }) {
  const tools = toolUsage(steps);
  if (!tools.length) return null;
  return (
    <SideCard title="Ferramentas usadas" icon="settings">
      <div className="exd-tools">
        {tools.map(([name, t]) => (
          <span key={name} className={`exd-tool ${t.err ? "err" : ""}`} title={name}>
            <Icon name={toolIcon(name)} size={13} /> {toolLabel(name)}
            {t.n > 1 && <b className="mono">{t.n}×</b>}
          </span>
        ))}
      </div>
    </SideCard>
  );
}

function InfoCard({ data }: { data: any }) {
  const channel = channelOf(data);
  return (
    <SideCard title="Detalhes" icon="hash">
      <dl className="exd-kv">
        <dt>Pessoa</dt><dd>{personOf(data) ?? "Sistema"}</dd>
        {channel && <><dt>Canal</dt><dd>{channel}</dd></>}
        <dt>Gatilho</dt><dd>{TRIGGER_LABEL[data.trigger] ?? data.trigger}</dd>
        <dt>Início</dt><dd className="mono">{new Date(data.started_at).toLocaleString("pt-BR")}</dd>
        {data.finished_at && <><dt>Fim</dt><dd className="mono">{new Date(data.finished_at).toLocaleString("pt-BR")}</dd></>}
        <dt>ID</dt><dd className="mono exd-id" title={data.id}>{String(data.id).slice(0, 8)}</dd>
      </dl>
      {data.conversation_id && (
        <Link className="btn btn-sm exd-conv" to={`/executions?conversation=${data.conversation_id}`}>
          <Icon name="list" size={13} /> Outras desta conversa
        </Link>
      )}
    </SideCard>
  );
}

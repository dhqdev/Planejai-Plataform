import { useState } from "react";
import { api } from "../api";
import { AgentTag, Empty, ErrorBox, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

type Meeting = {
  id: string;
  asks: number;
  summary: string | null;
  learned: { category: string; fact: string; changed?: boolean }[];
  changes: {
    style?: string | null;
    agent_notes?: { agent: string; note: string; persona: string }[];
    created?: { name: string; persona: string; focus: string }[];
    updated?: string[];
    retired?: string[];
    tabs?: string[];
    custom?: string[];
    topics?: string[];
  };
  created_at: string;
};

const when = (iso: string) => {
  const d = new Date(iso);
  const date = d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  return `${date[0]!.toUpperCase()}${date.slice(1)} · ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
};

/** Atas das reuniões das 19h: o que o time percebeu, aprendeu e mudou para a pessoa. Cada um vê só as suas. */
export function MeetingsPage() {
  const { data, error, reload } = useApi<Meeting[]>("/api/meetings", { poll: 120000 });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const runNow = async () => {
    haptic();
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/meetings/run", { method: "POST", json: {} });
      await reload();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page meet-page">
      <PageHead
        title="Reuniões das 19h"
        subtitle="Todo dia às 19h o time revisa as conversas do dia e se ajusta a você. Aqui fica a ata de cada reunião."
        actions={
          <button className="btn" disabled={busy} onClick={() => void runNow()}>
            <Icon name="refresh" size={16} /> {busy ? "Reunindo…" : "Reunião agora"}
          </button>
        }
      />
      <ErrorBox error={error ?? msg} />
      {data && !data.length && <div className="card"><Empty>Nenhuma reunião ainda. A primeira acontece às 19h de um dia em que você conversar com ele.</Empty></div>}
      <div className="meet-list">
        {(data ?? []).map((m, i) => {
          const c = m.changes ?? {};
          const expanded = open ? open === m.id : i === 0;
          const team = [
            ...(c.created ?? []).map((a) => `Nasceu ${a.persona}, para ${a.focus}`),
            ...(c.updated ?? []).map((n) => `${n} foi ajustado ao seu gosto`),
            ...(c.retired ?? []).map((n) => `${n} saiu do time por falta de uso`),
            ...(c.tabs ?? []).map((t) => `Liberou a tela ${t}`),
            ...(c.custom ?? []).map((t) => `Criou a aba ${t}`),
          ];
          const nothing = !m.learned.length && !team.length && !c.style && !(c.agent_notes ?? []).length;
          return (
            <article key={m.id} className={`card meet ${expanded ? "open" : ""}`}>
              <button className="meet-head" aria-expanded={expanded} onClick={() => { haptic(5); setOpen(expanded ? "none" : m.id); }}>
                <div>
                  <strong>{when(m.created_at)}</strong>
                  <span className="muted">
                    {m.asks} {m.asks === 1 ? "pedido revisado" : "pedidos revisados"}
                    {m.learned.length ? ` · aprendeu ${m.learned.length}` : ""}
                    {(c.created ?? []).length ? ` · ${c.created!.length} agente novo` : ""}
                  </span>
                </div>
                <Icon name="chevron-right" size={16} />
              </button>
              {expanded && (
                <div className="meet-body">
                  {m.summary && <p className="meet-summary">{m.summary}</p>}
                  {m.learned.length > 0 && (
                    <section>
                      <h4>Aprendeu sobre você</h4>
                      <ul>{m.learned.map((l, k) => <li key={k}>{l.fact}{l.changed && <span className="badge">atualizado</span>}</li>)}</ul>
                    </section>
                  )}
                  {(c.agent_notes ?? []).length > 0 && (
                    <section>
                      <h4>O que os agentes anotaram</h4>
                      <ul className="meet-notes">{c.agent_notes!.map((n) => <li key={n.agent}><AgentTag id={n.agent} /><p>{n.note}</p></li>)}</ul>
                    </section>
                  )}
                  {team.length > 0 && (
                    <section>
                      <h4>Mudou no time</h4>
                      <ul>{team.map((t, k) => <li key={k}>{t}</li>)}</ul>
                    </section>
                  )}
                  {c.style && (
                    <section>
                      <h4>Novo jeito de falar com você</h4>
                      <p>{c.style}</p>
                    </section>
                  )}
                  {(c.topics ?? []).length > 0 && (
                    <div className="mem-topics">{c.topics!.map((t) => <span key={t} className="chip">{t}</span>)}</div>
                  )}
                  {nothing && <p className="muted">Nada mudou nessa reunião: o time achou que já estava tudo certo.</p>}
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

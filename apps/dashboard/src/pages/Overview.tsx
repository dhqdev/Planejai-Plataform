import { Link, useNavigate } from "react-router-dom";
import { ago, ms, usd } from "../api";
import { AGENT_LABEL, ErrorBox, Loading, PageHead, Stat, Status } from "../components";
import { useApi } from "../hooks";

export function OverviewPage() {
  const { data, error } = useApi("/api/overview", { poll: 15000 });
  const execs = useApi<any[]>("/api/executions?limit=8", { poll: 15000 });
  const nav = useNavigate();
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const max = Math.max(1, ...data.daily.map((d: any) => Number(d.executions)));

  return (
    <div className="page">
      <PageHead title="Painel" subtitle="O que o seu agente fez nas últimas horas" actions={<Link className="btn btn-primary" to="/playground">▶ Testar agente</Link>} />

      {(!data.openrouter || !data.channel.configured) && (
        <div className="card card-pad" style={{ marginBottom: 14, borderColor: "var(--warn)" }}>
          <strong>Falta configurar:</strong>{" "}
          {!data.openrouter && <span>OPENROUTER_API_KEY no .env da stack. </span>}
          {!data.channel.configured && <span>o canal WhatsApp ({data.channel.provider}). Veja em <Link to="/settings" style={{ color: "var(--accent)" }}>Configurações</Link>.</span>}
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat icon="⚡" label="Execuções (24h)" value={data.stats.executions_24h} sub={`${data.stats.errors_24h} com erro`} />
        <Stat icon="⏱" tone="info" label="Tempo médio de resposta" value={ms(Math.round(data.stats.avg_ms_24h))} sub="últimas 24h" />
        <Stat icon="💲" tone="warn" label="Custo OpenRouter (24h)" value={usd(data.stats.cost_24h)} sub={`${usd(data.stats.cost_month)} no mês`} />
        <Stat icon="💬" tone="ok" label="Mensagens (24h)" value={data.counts.messages_24h} sub={`${data.counts.people} pessoas · ${data.counts.reminders} lembretes`} />
      </div>

      <div className="row row-wrap" style={{ marginBottom: 14 }}>
        <span className="chip">{data.redis?.ok ? "🟢" : data.redis?.enabled ? "🔴" : "⚪"} Redis {data.redis?.ok ? `· ${data.redis.keys} conversas na memória curta · ${data.redis.memory}` : data.redis?.enabled ? "fora do ar" : "não configurado"}</span>
        <span className="chip">🧹 mensagens guardadas por {data.retentionHours}h, depois viram resumo</span>
        {Number(data.counts.pending_people) > 0 && <Link className="chip" to="/people">👥 {data.counts.pending_people} número(s) aguardando aprovação</Link>}
        {Number(data.counts.pending_accounts) > 0 && <Link className="chip" to="/accounts">🔐 {data.counts.pending_accounts} cadastro(s) para aprovar</Link>}
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <div className="card card-pad">
          <h3>Execuções por dia</h3>
          <div className="bars">
            {data.daily.map((d: any) => (
              <div key={d.day} className="bar" title={`${d.day}: ${d.executions} execuções, ${d.errors} erros, ${usd(d.cost)}`} style={{ height: `${(Number(d.executions) / max) * 100}%` }} />
            ))}
          </div>
          <div className="bars-labels">
            {data.daily.map((d: any) => (
              <span key={d.day}>{d.day.slice(8)}</span>
            ))}
          </div>
        </div>
        <div className="card card-pad">
          <h3>Uso por agente (7 dias)</h3>
          <table className="table">
            <thead>
              <tr><th>Agente</th><th>Chamadas LLM</th><th>Ferramentas</th><th>Custo</th></tr>
            </thead>
            <tbody>
              {data.byAgent.map((a: any) => (
                <tr key={a.agent}>
                  <td>{AGENT_LABEL[a.agent] ?? a.agent}</td>
                  <td>{a.llm_calls}</td>
                  <td>{a.tool_calls}</td>
                  <td>{usd(a.cost)}</td>
                </tr>
              ))}
              {!data.byAgent.length && <tr><td colSpan={4} className="muted">Sem dados ainda</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-pad row"><h3 style={{ margin: 0 }}>Últimas execuções</h3><span className="spacer" /><Link to="/executions" className="btn btn-sm">Ver todas</Link></div>
        <table className="table">
          <tbody>
            {(execs.data ?? []).map((e) => (
              <tr key={e.id} className="clickable" onClick={() => nav(`/executions/${e.id}`)}>
                <td style={{ width: 120 }}><Status status={e.status} /></td>
                <td className="ellipsis">{e.input}</td>
                <td className="muted">{e.user_name ?? e.phone}</td>
                <td className="muted">{ago(e.started_at)}</td>
              </tr>
            ))}
            {execs.data && !execs.data.length && <tr><td className="muted">Nenhuma execução ainda. Mande uma mensagem no WhatsApp ou use o Playground.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

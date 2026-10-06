import { api, when } from "../api";
import { Empty, ErrorBox, PageHead, Status } from "../components";
import { useApi } from "../hooks";

export function RemindersPage() {
  const { data, error, reload } = useApi<any[]>("/api/reminders", { poll: 15000 });
  return (
    <div className="page">
      <PageHead title="Lembretes" subtitle="Mensagens proativas agendadas pelo agente. Na hora, o CTO escreve a mensagem com o contexto." />
      <ErrorBox error={error} />
      <div className="card">
        <table className="table">
          <thead><tr><th>Status</th><th>O que lembrar</th><th>Quando</th><th>Recorrência</th><th>Pessoa</th><th /></tr></thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.id}>
                <td><Status status={r.status} /></td>
                <td>{r.intent}</td>
                <td className="muted">{when(r.due_at)}</td>
                <td className="mono">{r.cron ?? "–"}</td>
                <td>{r.user_name ?? `+${r.phone}`}</td>
                <td>
                  {r.status === "scheduled" && (
                    <button className="btn btn-sm btn-danger" onClick={async () => { await api(`/api/reminders/${r.id}`, { method: "DELETE" }); void reload(); }}>
                      Cancelar
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !data.length && <Empty>Nenhum lembrete. Peça no WhatsApp: "me lembra de ligar pro dentista amanhã às 9h".</Empty>}
      </div>
    </div>
  );
}

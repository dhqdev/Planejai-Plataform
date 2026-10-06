import { Link, useNavigate, useParams } from "react-router-dom";
import { ago, when } from "../api";
import { Empty, ErrorBox, PageHead } from "../components";
import { useApi } from "../hooks";

export function ConversationsPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const list = useApi<any[]>("/api/conversations", { poll: 10000 });
  const conv = list.data?.find((c) => c.id === id);

  return (
    <div className="page-wide">
      <PageHead title="Conversas" subtitle="Tudo que o agente conversou no WhatsApp" />
      <ErrorBox error={list.error} />
      <div className="split">
        <div className="card" style={{ maxHeight: "calc(100vh - 150px)", overflow: "auto" }}>
          {(list.data ?? []).map((c) => (
            <div key={c.id} className={`list-item ${c.id === id ? "active" : ""}`} onClick={() => nav(`/conversations/${c.id}`)}>
              <div className="row">
                <strong>{c.name ?? `+${c.phone}`}</strong>
                <span className="spacer" />
                <span className="muted" style={{ fontSize: 11 }}>{ago(c.updated_at)}</span>
              </div>
              <div className="muted ellipsis" style={{ maxWidth: 280 }}>{c.last_message}</div>
            </div>
          ))}
          {list.data && !list.data.length && <Empty>Nenhuma conversa ainda</Empty>}
        </div>
        <div>
          {id ? <Thread id={id} summary={conv?.summary} /> : <div className="card"><Empty>Escolha uma conversa</Empty></div>}
        </div>
      </div>
    </div>
  );
}

function Thread({ id, summary }: { id: string; summary?: string | null }) {
  const { data, error } = useApi<any[]>(`/api/conversations/${id}/messages`, { poll: 5000 });
  return (
    <div className="card card-pad">
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="spacer" />
        <Link className="btn btn-sm" to={`/executions?conversation=${id}`}>Execuções</Link>
      </div>
      {summary && (
        <details style={{ marginBottom: 10 }}>
          <summary className="muted">Resumo de memória da conversa</summary>
          <pre className="json">{summary}</pre>
        </details>
      )}
      <ErrorBox error={error} />
      <Messages messages={data ?? []} />
    </div>
  );
}

export function Messages({ messages }: { messages: any[] }) {
  return (
    <div className="chat">
      {messages.map((m) => (
        <div key={m.id} className={`bubble ${m.role}`}>
          {m.role === "event" && "⚙ "}
          {m.meta?.kind === "audio" && <div className="muted">🎤 {m.meta.transcript ? "áudio transcrito:" : "áudio"}</div>}
          {m.meta?.kind === "image" && <div className="muted">🖼 foto{m.meta.image_description ? `: ${m.meta.image_description.slice(0, 200)}…` : ""}</div>}
          {m.media?.url && m.role === "assistant" && <img src={m.media.url} alt="" />}
          {m.meta?.transcript ?? m.content}
          <div className="time">{when(m.created_at)}</div>
          {m.meta?.reaction && <span className="reaction">{m.meta.reaction}</span>}
          {m.meta?.user_reaction && <span className="reaction">{m.meta.user_reaction}</span>}
        </div>
      ))}
      {!messages.length && <Empty>Sem mensagens</Empty>}
    </div>
  );
}

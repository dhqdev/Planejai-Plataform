import { useEffect, useState } from "react";
import { CLIENT_DOING, ROLE_DOING } from "../agentProps";
import { ago } from "../api";
import { Empty, ErrorBox, Loading, Modal, PageHead } from "../components";
import { AgentFace, type Face } from "../faces";
import { useApi } from "../hooks";

interface Member {
  id: string;
  name: string;
  persona?: string;
  face?: Face;
  role?: string;
  focus?: string;
  uses?: number;
  created_at?: string;
  kind?: string;
}

/** "Lendo o comprovante...": uma frase por vez, trocando devagar (some com movimento reduzido). */
function Doing({ id }: { id: string }) {
  const list = ROLE_DOING[id] ?? CLIENT_DOING;
  const [i, setI] = useState(() => Math.floor(Math.random() * list.length));
  useEffect(() => {
    const t = setInterval(() => !document.hidden && setI((n) => (n + 1) % list.length), 4200 + Math.random() * 1800);
    return () => clearInterval(t);
  }, [list.length]);
  return (
    <span className="team-doing" aria-hidden="true">
      <span key={i}>{list[i]}</span>
    </span>
  );
}

/** Meu time: o Juvenal (CTO), os especialistas e os agentes criados só para esta pessoa, cada um com nome e carinha. */
export function TeamPage() {
  const { data, error } = useApi<{ core: Member[]; mine: Member[]; notes?: { agent: string; note: string | null; user_note?: string | null }[] }>("/api/me/team");
  const [sel, setSel] = useState<Member | null>(null);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const noteOf = (id: string) => data.notes?.find((n) => n.agent === id);

  const Card = ({ m, lead }: { m: Member; lead?: boolean }) => (
    <button className={`team-card ${lead ? "lead" : ""}`} onClick={() => setSel(m)}>
      <span className="face-tile"><AgentFace face={m.face} size={lead ? 70 : 76} agent={m.id} live /></span>
      <strong>{m.persona ?? m.name}</strong>
      <small>{m.focus ?? m.name}</small>
      <Doing id={m.id} />
    </button>
  );

  return (
    <div className="page">
      <PageHead title="Meu time" subtitle="Quem cuida de você no WhatsApp. Toda noite o Juvenal reúne o time e ajusta cada um ao seu jeito." />
      <div className="team-grid" style={{ marginBottom: 22 }}>
        {data.core.map((m) => <Card key={m.id} m={m} lead={m.id === "cto"} />)}
      </div>
      <h3>Criados para você</h3>
      {data.mine.length ? (
        <div className="team-grid">{data.mine.map((m) => <Card key={m.id} m={m} />)}</div>
      ) : (
        <div className="card"><Empty>Quando um assunto aparece bastante nas suas conversas, o time cria um agente só para ele.</Empty></div>
      )}
      {sel && (
        <Modal title={sel.persona ?? sel.name} icon={<AgentFace face={sel.face} size={26} />} onClose={() => setSel(null)}>
          <p style={{ marginTop: 0 }}>{sel.role ?? sel.focus}</p>
          <dl className="kv">
            <dt>Função</dt>
            <dd>{sel.name}</dd>
            {sel.uses != null && (<><dt>Usado</dt><dd>{sel.uses} vezes</dd></>)}
            {sel.created_at && (<><dt>Criado</dt><dd>{ago(sel.created_at)}</dd></>)}
            {noteOf(sel.id)?.user_note && (<><dt>Você pediu</dt><dd>{noteOf(sel.id)!.user_note}</dd></>)}
            {noteOf(sel.id)?.note && (<><dt>Aprendeu</dt><dd>{noteOf(sel.id)!.note}</dd></>)}
          </dl>
        </Modal>
      )}
    </div>
  );
}

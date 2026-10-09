import { useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { ago, api, day } from "../api";
import { Empty, ErrorBox, Loading, PageHead, alertDialog, confirmDialog } from "../components";
import { FIT_QUERY, useApi, useMedia } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

type State = "them" | "you" | "done" | "failed" | "cancelled" | "expired";
type Line = { from: "nos" | "eles" | "pessoa"; text: string; at: string };
type Errand = {
  id: string;
  place: string;
  phone: string;
  goal: string;
  allowed: string | null;
  state: State;
  question: string | null;
  outcome: string | null;
  appointment_at: string | null;
  messages_left: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
  last: Line | null;
  log: Line[];
  next: { preview: string; allowed: string | null; created_at: string } | null;
};
type Draft = { id: string; place: string; phone: string; goal: string; allowed: string | null; preview: string; created_at: string };
type ContactChat = {
  phone: string;
  name: string | null;
  member: boolean;
  waiting_you: boolean;
  updated_at: string;
  last: Line | null;
  log: Line[];
  scheduled: { id: string; text: string; send_at: string }[];
};
type Data = { errands: Errand[]; drafts: Draft[]; contacts?: ContactChat[]; follow: string };
type Filter = "tudo" | "lugares" | "pessoas";

const LABEL: Record<State, string> = {
  them: "Esperando eles",
  you: "Esperando você",
  done: "Concluído",
  failed: "Concluído",
  cancelled: "Cancelado",
  expired: "Vencido",
};
const OPEN: State[] = ["them", "you"];
const hour = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const phoneLabel = (p: string) => {
  const m = p.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${p}`;
};
const contactName = (c: ContactChat) => c.name || phoneLabel(c.phone);
const initials = (name: string) => {
  const w = name.replace(/[^\p{L}\s]/gu, "").trim().split(/\s+/).filter(Boolean);
  return w.length ? (w[0]![0]! + (w.length > 1 ? w.at(-1)![0]! : "")).toUpperCase() : "#";
};
const contactState = (c: ContactChat) => (c.waiting_you ? "Respondeu" : c.scheduled.length ? "Agendada" : c.log.length ? "Enviado" : "");

/**
 * Recados: todas as conversas que o assistente tem em nome da pessoa, como no WhatsApp: com estabelecimentos
 * (recados) e com pessoas (mensagens avulsas e contatos do Planejai). Particular (só os próprios).
 * Mostra a próxima mensagem antes do "sim" e deixa cancelar sem mandar nada.
 */
export function ErrandsPage() {
  const { data, error, reload } = useApi<Data>("/api/errands", { poll: 10000 });
  const fit = useMedia(FIT_QUERY);
  // a conversa aberta fica na URL: no celular o "voltar" do aparelho (ou o gesto) volta para a lista
  const [params, setParams] = useSearchParams();
  const fromList = Boolean((useLocation().state as { fromList?: boolean } | null)?.fromList);
  const picked = params.get("r");
  const setPicked = (id: string) => {
    setParams({ r: id }, { replace: fit || picked != null, state: { fromList: !fit } });
    if (!fit) document.getElementById("conteudo")?.scrollTo({ top: 0 });
  };
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("tudo");
  const [q, setQ] = useState("");
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Loading />;

  const draft = data.drafts[0] ?? null;
  const list = data.errands;
  const people = data.contacts ?? [];
  // no notebook sempre há um aberto à direita; no celular a conversa abre no lugar da lista
  const first = draft ? `draft:${draft.id}` : [...list.map((e) => ({ id: e.id, at: e.updated_at })), ...people.map((c) => ({ id: `c:${c.phone}`, at: c.updated_at }))].sort((a, b) => (a.at < b.at ? 1 : -1))[0]?.id;
  const selId = picked ?? (fit ? first : null) ?? null;
  const sel = list.find((e) => e.id === selId) ?? null;
  const selContact = people.find((c) => `c:${c.phone}` === selId) ?? null;
  const showDraft = draft && selId === `draft:${draft.id}`;

  const run = async (path: string, init: Parameters<typeof api>[1]) => {
    setBusy(true);
    try {
      await api(path, init);
      haptic(8);
    } catch (e) {
      void alertDialog("Não deu certo", (e as Error).message);
    } finally {
      setBusy(false);
      reload();
    }
  };
  const cancel = async (e: Errand) => {
    if (await confirmDialog({ title: `Cancelar o recado com ${e.place}?`, body: "Nada é enviado para eles; o assistente só para de acompanhar.", confirmLabel: "Cancelar recado", cancelLabel: "Voltar", danger: true }))
      void run(`/api/errands/${e.id}/cancel`, { method: "POST" });
  };
  const cancelScheduled = async (c: ContactChat, id: string) => {
    if (await confirmDialog({ title: `Cancelar a mensagem para ${contactName(c)}?`, body: "Ela ainda não saiu e não vai sair.", confirmLabel: "Cancelar mensagem", cancelLabel: "Voltar", danger: true }))
      void run(`/api/direct/${id}`, { method: "DELETE" });
  };
  const discard = async (d: Draft) => {
    if (await confirmDialog({ title: "Descartar este recado?", body: "Ele ainda não foi enviado e não vai sair.", confirmLabel: "Descartar", cancelLabel: "Voltar", danger: true }))
      void run(`/api/errands/drafts/${d.id}`, { method: "DELETE" });
  };

  const detailOpen = fit || selId != null;
  const back = () => (fromList ? window.history.back() : setParams({}, { replace: true }));
  const norm = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const term = norm(q.trim());
  const match = (...parts: (string | null | undefined)[]) => !term || parts.some((p) => p && norm(p).includes(term));
  const places = filter === "pessoas" ? [] : list.filter((e) => match(e.place, e.goal, e.phone));
  const contacts = filter === "lugares" ? [] : people.filter((c) => match(c.name, c.phone, c.last?.text));
  const showDraftRow = draft && filter !== "pessoas" && match(draft.place, draft.goal);
  const total = list.length + people.length + (draft ? 1 : 0);
  const listView = (
    <div className="card errand-list" aria-label="Conversas">
      {total > 0 && (
        <div className="errand-tools">
          <div className="seg" role="group" aria-label="Mostrar">
            {(["tudo", "lugares", "pessoas"] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
                {f === "tudo" ? "Tudo" : f === "lugares" ? `Lugares${list.length + (draft ? 1 : 0) ? ` ${list.length + (draft ? 1 : 0)}` : ""}` : `Pessoas${people.length ? ` ${people.length}` : ""}`}
              </button>
            ))}
          </div>
          {total > 6 && <input className="input errand-search" type="search" placeholder="Buscar" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar conversa" />}
        </div>
      )}
      {showDraftRow && (
        <button className={`errand-row${showDraft ? " active" : ""}`} onClick={() => setPicked(`draft:${draft.id}`)}>
          <Avatar name={draft.place} place />
          <span className="errand-row-body">
            <span className="errand-row-top">
              <strong>{draft.place}</strong>
              <span className="errand-state you">Esperando seu sim</span>
            </span>
            <span className="errand-row-goal">{draft.goal}</span>
            <span className="errand-row-last muted">Ainda não enviado · {ago(draft.created_at)}</span>
          </span>
        </button>
      )}
      {filter === "tudo" && places.length > 0 && contacts.length > 0 && <div className="errand-section">Lugares</div>}
      {places.map((e) => (
        <button key={e.id} className={`errand-row${e.id === selId ? " active" : ""}`} onClick={() => setPicked(e.id)}>
          <Avatar name={e.place} place />
          <span className="errand-row-body">
            <span className="errand-row-top">
              <strong>{e.place}</strong>
              <span className={`errand-state ${e.state}`}>{LABEL[e.state]}</span>
            </span>
            <span className="errand-row-goal">{e.goal}</span>
            {e.last && (
              <span className="errand-row-last muted">
                {e.last.from === "nos" ? "Nós: " : e.last.from === "eles" ? "Eles: " : "Você: "}
                {e.last.text} · {ago(e.updated_at)}
              </span>
            )}
          </span>
        </button>
      ))}
      {filter === "tudo" && places.length > 0 && contacts.length > 0 && <div className="errand-section">Pessoas</div>}
      {contacts.map((c) => (
        <button key={c.phone} className={`errand-row${`c:${c.phone}` === selId ? " active" : ""}`} onClick={() => setPicked(`c:${c.phone}`)}>
          <Avatar name={contactName(c)} />
          <span className="errand-row-body">
            <span className="errand-row-top">
              <strong>{contactName(c)}</strong>
              <span className={`errand-state ${c.waiting_you ? "you" : c.scheduled.length ? "them" : "done"}`}>{contactState(c)}</span>
            </span>
            <span className="errand-row-last muted">
              {c.last ? (
                <>
                  {c.last.from === "nos" ? "Você: " : ""}
                  {c.last.text} · {ago(c.last.at)}
                </>
              ) : c.scheduled[0] ? (
                <>Sai {day(c.scheduled[0].send_at)}: {c.scheduled[0].text}</>
              ) : null}
            </span>
          </span>
        </button>
      ))}
      {total > 0 && !showDraftRow && !places.length && !contacts.length && (
        <Empty>{term ? "Nada com esse nome." : filter === "pessoas" ? "Nenhuma conversa com pessoas ainda." : "Nenhum recado com lugares ainda."}</Empty>
      )}
      {!total && (
        <Empty>
          Nenhuma conversa ainda. Peça no WhatsApp, por exemplo: "pergunta no petshop aqui perto quanto custa a tosa" ou "manda pra Ana que eu chego às 8".
        </Empty>
      )}
    </div>
  );

  return (
    <div className={`page errands-page${fit ? " fit" : detailOpen ? " reading" : ""}`}>
      <PageHead title="Recados" subtitle="Todas as conversas que o assistente tem por você, com lugares e com pessoas. Atualiza sozinho enquanto a tela está aberta." />
      <div className={`errand-grid${detailOpen && !fit ? " detail-only" : ""}`}>
        {(fit || !detailOpen) && listView}
        {detailOpen && (
          <div className="card errand-detail">
            {!fit && (
              <button className="btn btn-sm errand-back" onClick={back}>
                <Icon name="chevron-left" size={15} /> Recados
              </button>
            )}
            {showDraft && draft ? (
              <DraftView d={draft} busy={busy} onDiscard={() => discard(draft)} />
            ) : sel ? (
              <ErrandView e={sel} busy={busy} onCancel={() => cancel(sel)} />
            ) : selContact ? (
              <ContactView c={selContact} busy={busy} onCancel={(id) => cancelScheduled(selContact, id)} />
            ) : (
              <Empty>Escolha uma conversa para ver.</Empty>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function DraftView({ d, busy, onDiscard }: { d: Draft; busy: boolean; onDiscard: () => void }) {
  return (
    <>
      <div className="errand-head">
        <div>
          <h3>{d.place}</h3>
          <p className="muted">{d.goal}</p>
        </div>
        <button className="btn btn-sm" disabled={busy} onClick={onDiscard}>Descartar</button>
      </div>
      <div className="errand-chat">
        <Bubble line={{ from: "nos", text: d.preview, at: d.created_at }} next />
      </div>
      <p className="errand-note">
        Ainda não foi enviado. Responda <strong>sim</strong> no WhatsApp para mandar exatamente essa mensagem
        {d.allowed ? <>; se {d.allowed.replace(/^se\s+/i, "")}, o assistente já fecha por você.</> : "; ele traz a resposta para você."}
      </p>
    </>
  );
}

function ErrandView({ e, busy, onCancel }: { e: Errand; busy: boolean; onCancel: () => void }) {
  const open = OPEN.includes(e.state);
  return (
    <>
      <div className="errand-head">
        <div>
          <h3>{e.place}</h3>
          <p className="muted">{e.goal}</p>
        </div>
        {open && <button className="btn btn-sm" disabled={busy} onClick={onCancel}>Cancelar recado</button>}
      </div>
      <div className="errand-facts">
        <span className={`errand-state ${e.state}`}>{LABEL[e.state]}</span>
        <span>{e.allowed ? `Liberado: ${e.allowed}` : "Só pergunta, não fecha nada"}</span>
        {open && <span>{e.messages_left} mensagem(ns) restante(s)</span>}
        {open && <span>acompanha até {day(e.expires_at)}</span>}
      </div>
      <div className="errand-chat">
        {e.log.map((l, i) => <Bubble key={`${l.at}-${i}`} line={l} />)}
        {e.next && <Bubble line={{ from: "nos", text: e.next.preview, at: e.next.created_at }} next />}
      </div>
      {e.state === "you" && (e.next || e.question) && (
        <p className="errand-note">
          {e.next ? (
            <>A próxima mensagem só sai quando você responder <strong>sim</strong> no WhatsApp.</>
          ) : (
            <>Eles perguntaram: {e.question} Responda no WhatsApp.</>
          )}
        </p>
      )}
      {e.outcome && !open && (
        <p className="errand-note">
          {e.state === "failed" ? "Não deu certo: " : "Resultado: "}
          {e.outcome}
          {e.appointment_at ? ` · marcado para ${day(e.appointment_at)}` : ""}
        </p>
      )}
    </>
  );
}

function Avatar({ name, place }: { name: string; place?: boolean }) {
  return (
    <span className={`errand-avatar${place ? " place" : ""}`} aria-hidden="true">
      {place ? <Icon name="shop" size={15} /> : initials(name)}
    </span>
  );
}

function ContactView({ c, busy, onCancel }: { c: ContactChat; busy: boolean; onCancel: (id: string) => void }) {
  const name = contactName(c);
  return (
    <>
      <div className="errand-head">
        <div className="errand-who">
          <Avatar name={name} />
          <div>
            <h3>{name}</h3>
            <p className="muted">
              {c.name ? phoneLabel(c.phone) : ""}
              {c.name && c.member ? " · " : ""}
              {c.member ? "usa o Planejai" : ""}
            </p>
          </div>
        </div>
      </div>
      <div className="errand-chat">
        {c.log.map((l, i) => <Bubble key={`${l.at}-${i}`} line={l} />)}
        {c.scheduled.map((m) => (
          <div key={m.id} className="errand-bubble ours next">
            <span className="errand-bubble-tag">Agendada para {day(m.send_at)}</span>
            <span className="errand-bubble-text">{m.text}</span>
            <button className="errand-bubble-cancel" disabled={busy} onClick={() => onCancel(m.id)}>Cancelar</button>
          </div>
        ))}
        {!c.log.length && !c.scheduled.length && <p className="errand-note">Nada por aqui ainda.</p>}
      </div>
      <p className="errand-note">
        {c.waiting_you ? <><strong>{name.split(" ")[0]} respondeu.</strong> </> : null}
        Para mandar algo, é só pedir no WhatsApp, por exemplo: "manda pro {name.split(" ")[0]} que eu já tô chegando". Nada sai sem o seu <strong>sim</strong>.
      </p>
    </>
  );
}

function Bubble({ line, next }: { line: Line; next?: boolean }) {
  if (line.from === "pessoa") return <div className="errand-decided">Você decidiu: {line.text}</div>;
  return (
    <div className={`errand-bubble ${line.from === "nos" ? "ours" : "theirs"}${next ? " next" : ""}`}>
      {next && <span className="errand-bubble-tag">Próxima mensagem</span>}
      <span className="errand-bubble-text">{line.text}</span>
      <span className="errand-bubble-time">{next ? "não enviada" : hour(line.at)}</span>
    </div>
  );
}

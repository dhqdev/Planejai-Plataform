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
type Data = { errands: Errand[]; drafts: Draft[]; follow: string };

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

/**
 * Recados: a conversa que o assistente está tendo com um estabelecimento em nome da pessoa, como no WhatsApp.
 * Particular (só os próprios). Mostra a próxima mensagem antes do "sim" e deixa cancelar sem mandar nada.
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
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Loading />;

  const draft = data.drafts[0] ?? null;
  const list = data.errands;
  // no notebook sempre há um aberto à direita; no celular a conversa abre no lugar da lista
  const selId = picked ?? (fit ? (draft ? `draft:${draft.id}` : list[0]?.id) : null) ?? null;
  const sel = list.find((e) => e.id === selId) ?? null;
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
  const discard = async (d: Draft) => {
    if (await confirmDialog({ title: "Descartar este recado?", body: "Ele ainda não foi enviado e não vai sair.", confirmLabel: "Descartar", cancelLabel: "Voltar", danger: true }))
      void run(`/api/errands/drafts/${d.id}`, { method: "DELETE" });
  };

  const detailOpen = fit || selId != null;
  const back = () => (fromList ? window.history.back() : setParams({}, { replace: true }));
  const listView = (
    <div className="card errand-list" aria-label="Recados">
      {draft && (
        <button className={`errand-row${showDraft ? " active" : ""}`} onClick={() => setPicked(`draft:${draft.id}`)}>
          <span className="errand-row-top">
            <strong>{draft.place}</strong>
            <span className="errand-state you">Esperando seu sim</span>
          </span>
          <span className="errand-row-goal">{draft.goal}</span>
          <span className="errand-row-last muted">Ainda não enviado · {ago(draft.created_at)}</span>
        </button>
      )}
      {list.map((e) => (
        <button key={e.id} className={`errand-row${e.id === selId ? " active" : ""}`} onClick={() => setPicked(e.id)}>
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
        </button>
      ))}
      {!draft && !list.length && <Empty>Nenhum recado ainda. Peça no WhatsApp, por exemplo: "pergunta no petshop aqui perto quanto custa a tosa".</Empty>}
    </div>
  );

  return (
    <div className={`page errands-page${fit ? " fit" : detailOpen ? " reading" : ""}`}>
      <PageHead title="Recados" subtitle="As conversas que o assistente tem com lugares por você. Atualiza sozinho enquanto a tela está aberta." />
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
            ) : (
              <Empty>Escolha um recado para ver a conversa.</Empty>
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

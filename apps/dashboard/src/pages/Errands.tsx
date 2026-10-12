import { type ReactNode, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";
import { ago, api, day } from "../api";
import { Empty, ErrorBox, Loading, Modal, PageHead, alertDialog, confirmDialog } from "../components";
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
  reply_until: string | null;
  updated_at: string;
  last: Line | null;
  log: Line[];
  scheduled: { id: string; text: string; send_at: string }[];
};
type Follow = "auto" | "on" | "off";
type Prefs = {
  phone: string;
  nickname: string | null;
  color: string | null;
  tone: string | null;
  signature: string | null;
  note: string | null;
  pinned: boolean;
  archived: boolean;
  follow: Follow;
};
type Data = { errands: Errand[]; drafts: Draft[]; contacts?: ContactChat[]; follow: string; prefs?: Record<string, Prefs> };
type Filter = "tudo" | "lugares" | "pessoas" | "arquivadas";

const COLORS: { id: string; label: string }[] = [
  { id: "violeta", label: "Violeta" },
  { id: "azul", label: "Azul" },
  { id: "verde", label: "Verde" },
  { id: "ambar", label: "Âmbar" },
  { id: "rosa", label: "Rosa" },
  { id: "cinza", label: "Cinza" },
];
const TONES: { id: string; label: string; help: string }[] = [
  { id: "", label: "Padrão", help: "Educado e natural, como sempre." },
  { id: "formal", label: "Formal", help: "Senhor/senhora, sem gíria. Bom para clínica, escritório, fornecedor." },
  { id: "descontraido", label: "Leve", help: "Próximo, como amigo. Bom para família e amigos." },
  { id: "curto", label: "Direto", help: "Curto e sem rodeio." },
];

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
const contactName = (c: ContactChat, p?: Prefs) => p?.nickname || c.name || phoneLabel(c.phone);
const placeName = (e: Errand, p?: Prefs) => p?.nickname || e.place;
const byPin = <T,>(list: T[], pin: (x: T) => boolean) => [...list.filter(pin), ...list.filter((x) => !pin(x))];
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
  const prefs = data.prefs ?? {};
  const pref = (phone: string): Prefs | undefined => prefs[phone];
  const archivedOf = (phone: string) => Boolean(pref(phone)?.archived);
  const list = data.errands;
  const people = data.contacts ?? [];
  const archivedCount = list.filter((e) => archivedOf(e.phone)).length + people.filter((c) => archivedOf(c.phone)).length;
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
    if (await confirmDialog({ title: `Cancelar a mensagem para ${contactName(c, pref(c.phone))}?`, body: "Ela ainda não saiu e não vai sair.", confirmLabel: "Cancelar mensagem", cancelLabel: "Voltar", danger: true }))
      void run(`/api/direct/${id}`, { method: "DELETE" });
  };
  const discard = async (d: Draft) => {
    if (await confirmDialog({ title: "Descartar este recado?", body: "Ele ainda não foi enviado e não vai sair.", confirmLabel: "Descartar", cancelLabel: "Voltar", danger: true }))
      void run(`/api/errands/drafts/${d.id}`, { method: "DELETE" });
  };

  const save = (phone: string, patch: Partial<Prefs>) => run(`/api/errands/chats/${encodeURIComponent(phone)}`, { method: "PUT", body: JSON.stringify(patch) });
  const setFollow = async (phone: string, name: string, follow: Follow, openErrand: boolean) => {
    if (follow === "off" && openErrand && !(await confirmDialog({ title: `Parar de acompanhar ${name}?`, body: "O recado em andamento é cancelado. Nada é enviado para eles, e as respostas deixam de chegar para você.", confirmLabel: "Parar", cancelLabel: "Voltar", danger: true })))
      return;
    void save(phone, { follow });
  };
  const removeFollow = async (phone: string, name: string) => {
    if (
      await confirmDialog({
        title: `Excluir o acompanhamento de ${name}?`,
        body: "O assistente para de acompanhar, cancela o que estava agendado ou em andamento (nada é enviado) e a conversa sai daqui. O apelido e o jeito que você escolheu ficam guardados.",
        confirmLabel: "Excluir",
        cancelLabel: "Voltar",
        danger: true,
      })
    ) {
      await run(`/api/errands/chats/${encodeURIComponent(phone)}`, { method: "DELETE" });
      back();
    }
  };

  const detailOpen = fit || selId != null;
  const back = () => (fromList ? window.history.back() : setParams({}, { replace: true }));
  const norm = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const term = norm(q.trim());
  const match = (...parts: (string | null | undefined)[]) => !term || parts.some((p) => p && norm(p).includes(term));
  // arquivada só aparece no filtro Arquivadas; fixada sobe para o topo da sua seção
  const shelf = (phone: string) => (filter === "arquivadas" ? archivedOf(phone) : !archivedOf(phone));
  const places = filter === "pessoas" ? [] : byPin(list.filter((e) => shelf(e.phone) && match(e.place, pref(e.phone)?.nickname, e.goal, e.phone)), (e) => Boolean(pref(e.phone)?.pinned));
  const contacts = filter === "lugares" ? [] : byPin(people.filter((c) => shelf(c.phone) && match(c.name, pref(c.phone)?.nickname, c.phone, c.last?.text)), (c) => Boolean(pref(c.phone)?.pinned));
  const showDraftRow = draft && filter !== "pessoas" && filter !== "arquivadas" && match(draft.place, draft.goal);
  const total = list.length + people.length + (draft ? 1 : 0);
  const listView = (
    <div className="card errand-list" aria-label="Conversas">
      {total > 0 && (
        <div className="errand-tools">
          <div className="seg" role="group" aria-label="Mostrar">
            {(["tudo", "lugares", "pessoas", ...(archivedCount || filter === "arquivadas" ? ["arquivadas"] : [])] as Filter[]).map((f) => (
              <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>
                {f === "tudo"
                  ? "Tudo"
                  : f === "lugares"
                    ? `Lugares${list.length + (draft ? 1 : 0) ? ` ${list.length + (draft ? 1 : 0)}` : ""}`
                    : f === "pessoas"
                      ? `Pessoas${people.length ? ` ${people.length}` : ""}`
                      : `Arquivadas ${archivedCount}`}
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
          <Avatar name={placeName(e, pref(e.phone))} place color={pref(e.phone)?.color} />
          <span className="errand-row-body">
            <span className="errand-row-top">
              <strong>
                {pref(e.phone)?.pinned && <Icon name="bookmark" size={12} className="errand-pin" />}
                {placeName(e, pref(e.phone))}
              </strong>
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
          <Avatar name={contactName(c, pref(c.phone))} color={pref(c.phone)?.color} />
          <span className="errand-row-body">
            <span className="errand-row-top">
              <strong>
                {pref(c.phone)?.pinned && <Icon name="bookmark" size={12} className="errand-pin" />}
                {contactName(c, pref(c.phone))}
              </strong>
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
        <Empty>{term ? "Nada com esse nome." : filter === "arquivadas" ? "Nenhuma conversa arquivada." : filter === "pessoas" ? "Nenhuma conversa com pessoas ainda." : "Nenhum recado com lugares ainda."}</Empty>
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
              <ErrandView
                e={sel}
                p={pref(sel.phone)}
                busy={busy}
                onCancel={() => cancel(sel)}
                onSave={(patch) => save(sel.phone, patch)}
                onFollow={(f) => setFollow(sel.phone, placeName(sel, pref(sel.phone)), f, OPEN.includes(sel.state))}
                onRemove={() => removeFollow(sel.phone, placeName(sel, pref(sel.phone)))}
              />
            ) : selContact ? (
              <ContactView
                c={selContact}
                p={pref(selContact.phone)}
                busy={busy}
                onCancel={(id) => cancelScheduled(selContact, id)}
                onSave={(patch) => save(selContact.phone, patch)}
                onFollow={(f) => setFollow(selContact.phone, contactName(selContact, pref(selContact.phone)), f, false)}
                onRemove={() => removeFollow(selContact.phone, contactName(selContact, pref(selContact.phone)))}
              />
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

type ChatActions = { p?: Prefs; busy: boolean; onSave: (patch: Partial<Prefs>) => void; onFollow: (f: Follow) => void; onRemove: () => void };

function ErrandView({ e, p, busy, onCancel, onSave, onFollow, onRemove }: { e: Errand; onCancel: () => void } & ChatActions) {
  const open = OPEN.includes(e.state);
  const name = placeName(e, p);
  const follow = p?.follow ?? "auto";
  const status =
    follow === "on"
      ? `Acompanhando sem prazo: toda resposta de ${name} chega no seu WhatsApp, mesmo depois do recado.`
      : follow === "off"
        ? `Você parou de acompanhar. Respostas de ${name} não chegam mais.`
        : open
          ? `Acompanhando até ${day(e.expires_at)}. Depois disso, ou quando o recado fechar, as respostas param de chegar.`
          : "Recado encerrado. Respostas novas deles não chegam para você.";
  return (
    <>
      <div className="errand-head">
        <div className="errand-who">
          <Avatar name={name} place color={p?.color} />
          <div>
            <h3>{name}</h3>
            <p className="muted">{p?.nickname ? `${e.place} · ${e.goal}` : e.goal}</p>
          </div>
        </div>
      </div>
      <ChatBar name={name} p={p} busy={busy} onSave={onSave}>
        {open && <button className="btn btn-sm" disabled={busy} onClick={onCancel}>Cancelar recado</button>}
      </ChatBar>
      <div className="errand-facts">
        <span className={`errand-state ${e.state}`}>{LABEL[e.state]}</span>
        <span>{e.allowed ? `Liberado: ${e.allowed}` : "Só pergunta, não fecha nada"}</span>
        {open && <span>{e.messages_left} mensagem(ns) restante(s)</span>}
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
      <FollowBox status={status} follow={follow} busy={busy} onFollow={onFollow} onRemove={onRemove} />
    </>
  );
}

/** Fixar, arquivar e personalizar a conversa (apelido, cor, tom, assinatura, anotação). */
function ChatBar({ name, p, busy, member, onSave, children }: { name: string; p?: Prefs; busy: boolean; member?: boolean; onSave: (patch: Partial<Prefs>) => void; children?: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const tone = TONES.find((t) => t.id === (p?.tone ?? ""));
  return (
    <div className="errand-bar">
      <button className={`btn btn-sm${p?.pinned ? " on" : ""}`} disabled={busy} onClick={() => onSave({ pinned: !p?.pinned })} aria-pressed={Boolean(p?.pinned)}>
        <Icon name="bookmark" size={14} /> {p?.pinned ? "Fixada" : "Fixar"}
      </button>
      <button className={`btn btn-sm${p?.archived ? " on" : ""}`} disabled={busy} onClick={() => onSave({ archived: !p?.archived })} aria-pressed={Boolean(p?.archived)}>
        <Icon name="folder" size={14} /> {p?.archived ? "Arquivada" : "Arquivar"}
      </button>
      <button className="btn btn-sm" disabled={busy} onClick={() => setEditing(true)}>
        <Icon name="edit" size={14} /> Personalizar
      </button>
      {children}
      {(p?.tone || p?.signature || p?.note) && (
        <span className="errand-bar-info">
          {[p?.tone ? `Tom ${tone?.label.toLowerCase()}` : "", p?.signature && !member ? "com assinatura" : "", p?.note ? "com anotação" : ""].filter(Boolean).join(" · ")}
        </span>
      )}
      {editing && <CustomizeModal name={name} p={p} member={member} onClose={() => setEditing(false)} onSave={onSave} />}
    </div>
  );
}

function CustomizeModal({ name, p, member, onClose, onSave }: { name: string; p?: Prefs; member?: boolean; onClose: () => void; onSave: (patch: Partial<Prefs>) => void }) {
  const [form, setForm] = useState({ nickname: p?.nickname ?? "", color: p?.color ?? "", tone: p?.tone ?? "", signature: p?.signature ?? "", note: p?.note ?? "" });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <Modal
      title={`Personalizar ${name}`}
      onClose={onClose}
      footer={(close) => (
        <>
          <button className="btn btn-ghost" onClick={close}>Cancelar</button>
          <button className="btn btn-primary" form="errand-custom">Salvar</button>
        </>
      )}
    >
      <form
        id="errand-custom"
        className="errand-custom"
        onSubmit={(ev) => {
          ev.preventDefault();
          onSave({ nickname: form.nickname, color: form.color || null, tone: form.tone || null, ...(member ? {} : { signature: form.signature }), note: form.note });
          onClose();
        }}
      >
        <div className="field">
          <label htmlFor="ec-nick">Apelido</label>
          <input id="ec-nick" className="input" maxLength={40} placeholder={name} value={form.nickname} onChange={(e) => set("nickname")(e.target.value)} />
          <div className="help">Só você vê. Aparece aqui e no aviso quando responderem.</div>
        </div>
        <div className="field">
          <span className="errand-custom-label">Cor</span>
          <div className="errand-colors" role="radiogroup" aria-label="Cor">
            <button type="button" role="radio" aria-checked={!form.color} className={`errand-color none${!form.color ? " on" : ""}`} onClick={() => set("color")("")} aria-label="Sem cor" />
            {COLORS.map((c) => (
              <button type="button" key={c.id} role="radio" aria-checked={form.color === c.id} aria-label={c.label} className={`errand-color c-${c.id}${form.color === c.id ? " on" : ""}`} onClick={() => set("color")(c.id)} />
            ))}
          </div>
        </div>
        <div className="field">
          <span className="errand-custom-label">Jeito do assistente</span>
          <div className="seg errand-tones" role="radiogroup" aria-label="Jeito do assistente">
            {TONES.map((t) => (
              <button type="button" key={t.id} role="radio" aria-checked={form.tone === t.id} className={form.tone === t.id ? "active" : ""} onClick={() => set("tone")(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="help">{TONES.find((t) => t.id === form.tone)?.help}</div>
        </div>
        {!member && (
          <div className="field">
            <label htmlFor="ec-sig">Assinatura</label>
            <input id="ec-sig" className="input" maxLength={60} placeholder="Ex.: Abraço, David" value={form.signature} onChange={(e) => set("signature")(e.target.value)} />
            <div className="help">Vai no fim de cada mensagem avulsa e da primeira mensagem de um recado para esse número.</div>
          </div>
        )}
        <div className="field">
          <label htmlFor="ec-note">Anotação para o assistente</label>
          <textarea id="ec-note" className="input" rows={3} maxLength={240} placeholder="Ex.: chamar de Dona Lúcia; só atende à tarde" value={form.note} onChange={(e) => set("note")(e.target.value)} />
          <div className="help">O assistente lê antes de escrever para esse número.</div>
        </div>
      </form>
    </Modal>
  );
}

/** Acompanhamento: se as respostas desse número chegam para a pessoa, e por quanto tempo. */
function FollowBox({ status, follow, busy, onFollow, onRemove, hideModes }: { status: string; follow: Follow; busy: boolean; onFollow: (f: Follow) => void; onRemove: () => void; hideModes?: boolean }) {
  return (
    <section className="errand-follow" aria-label="Acompanhamento">
      <div className="errand-follow-top">
        <strong>Acompanhamento</strong>
        {!hideModes && (
          <div className="seg" role="radiogroup" aria-label="Acompanhamento">
            {(
              [
                ["auto", "Normal"],
                ["on", "Sem prazo"],
                ["off", "Parado"],
              ] as [Follow, string][]
            ).map(([f, label]) => (
              <button key={f} role="radio" aria-checked={follow === f} className={follow === f ? "active" : ""} disabled={busy} onClick={() => follow !== f && onFollow(f)}>
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="errand-note">{status}</p>
      <button className="btn btn-sm btn-danger errand-follow-del" disabled={busy} onClick={onRemove}>
        <Icon name="trash" size={14} /> Excluir acompanhamento
      </button>
    </section>
  );
}

function Avatar({ name, place, color }: { name: string; place?: boolean; color?: string | null }) {
  return (
    <span className={`errand-avatar${place ? " place" : ""}${color ? ` c-${color}` : ""}`} aria-hidden="true">
      {place ? <Icon name="shop" size={15} /> : initials(name)}
    </span>
  );
}

function ContactView({ c, p, busy, onCancel, onSave, onFollow, onRemove }: { c: ContactChat; onCancel: (id: string) => void } & ChatActions) {
  const name = contactName(c, p);
  const first = name.split(" ")[0];
  const follow = p?.follow ?? "auto";
  const status = c.member
    ? `${first} usa o Planejai: o que ${first} responder chega pelo assistente, sem prazo. Excluir só tira a conversa daqui.`
    : follow === "on"
      ? `Acompanhando sem prazo: toda resposta de ${first} chega no seu WhatsApp.`
      : follow === "off"
        ? `Você parou de acompanhar. Respostas de ${first} não chegam mais (voltam a chegar se você mandar algo de novo).`
        : c.reply_until
          ? `Acompanhando até ${day(c.reply_until)}: até lá, o que ${first} responder chega no seu WhatsApp.`
          : c.scheduled.length
            ? "Começa quando a mensagem agendada sair: as respostas chegam por 3 dias."
            : `Sem acompanhamento agora: a última mensagem saiu há mais de 3 dias. Escolha Sem prazo para receber as respostas de ${first}.`;
  return (
    <>
      <div className="errand-head">
        <div className="errand-who">
          <Avatar name={name} color={p?.color} />
          <div>
            <h3>{name}</h3>
            <p className="muted">
              {[p?.nickname && c.name && c.name !== p.nickname ? c.name : "", name !== phoneLabel(c.phone) ? phoneLabel(c.phone) : "", c.member ? "usa o Planejai" : ""].filter(Boolean).join(" · ")}
            </p>
          </div>
        </div>
      </div>
      <ChatBar name={name} p={p} busy={busy} member={c.member} onSave={onSave} />
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
        {c.waiting_you ? <><strong>{first} respondeu.</strong> </> : null}
        Para mandar algo, é só pedir no WhatsApp, por exemplo: "manda pro {name.split(" ")[0]} que eu já tô chegando". Nada sai sem o seu <strong>sim</strong>.
      </p>
      <FollowBox status={status} follow={follow} busy={busy} onFollow={onFollow} onRemove={onRemove} hideModes={c.member} />
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

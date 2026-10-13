import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ErrorBox, Loading, Modal, PageHead, confirmDialog } from "../components";
import { FIT_QUERY, useMedia } from "../hooks";
import { Icon } from "../icons";
import { useLongPress } from "../ios";

interface Contact {
  id: string;
  name: string;
  phone: string;
  label: string | null;
  approximate?: true;
}
interface Data {
  total: number;
  noname: number;
  items: Contact[];
}
interface Result {
  saved: number;
  added: number;
  skipped: number;
  over_limit: number;
}

const PAGE = 200;

/** +55 (19) 99123-4567; número de fora fica com o DDI. */
const showPhone = (p: string) => {
  const m = p.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${p}`;
};

/** ";;;;" e afins (importação antiga) não são nome. */
const named = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** Duas iniciais para o círculo do cartão. */
function initials(name: string) {
  const words = name.normalize("NFC").replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  const first = [...words[0]!][0] ?? "";
  const last = words.length > 1 ? [...words[words.length - 1]!][0] ?? "" : "";
  return (first + last).toLocaleUpperCase("pt-BR");
}

/** Letra do grupo (sem acento); número e símbolo vão para "#". */
function letterOf(name: string) {
  const ch = name.normalize("NFD").replace(/[̀-ͯ]/g, "").trim()[0]?.toLocaleUpperCase("pt-BR") ?? "";
  return /[A-Z]/.test(ch) ? ch : "#";
}

// seletor de contatos do celular (Chrome no Android); o iPhone não tem, lá vai pelo arquivo
const picker = typeof navigator !== "undefined" && "contacts" in navigator ? (navigator as any).contacts : null;

/**
 * Tira foto e o que não serve do .vcf antes de mandar (foto de contato pesa megas). Mantém a dobra de linha
 * (começa com espaço) e a quebra "suave" do quoted-printable (linha termina com "="), senão o nome chega cortado.
 */
function slimVcf(text: string) {
  const out: string[] = [];
  let skip = false;
  let qp = false;
  let qpOpen = false;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (!qpOpen && !/^[ \t]/.test(line)) {
      skip = !/^(?:[A-Za-z0-9-]+\.)?(BEGIN|END|VERSION|FN|N|NICKNAME|ORG|EMAIL|TEL)[;:]/i.test(line);
      qp = /^[^:]*QUOTED-PRINTABLE/i.test(line);
    }
    if (!skip) out.push(line);
    qpOpen = qp && line.endsWith("=");
  }
  return out.join("\n");
}

/**
 * Agenda de contatos: importa do celular (arquivo .vcf ou o seletor do Android) para o assistente achar o número
 * pelo nome na hora de mandar mensagem. Cada um vê só a sua. Contatos em cartões, carregando aos poucos ao rolar.
 */
export function ContactsPage() {
  const fit = useMedia(FIT_QUERY);
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [onlyNoName, setOnlyNoName] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const seq = useRef(0);
  const url = (offset: number) => `/api/contatos?limit=${PAGE}&offset=${offset}${query ? `&q=${encodeURIComponent(query)}` : ""}${onlyNoName && !query ? "&sem_nome=1" : ""}`;
  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const d = await api<Data>(url(0));
      if (my === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (my === seq.current) setError((e as Error).message);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, onlyNoName]);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    if (!data?.noname) setOnlyNoName(false);
  }, [data?.noname]);

  const shown = onlyNoName && !query ? (data?.noname ?? 0) : (data?.total ?? 0);
  const hasMore = Boolean(data && !query && data.items.length < shown);
  const loadMore = useCallback(async () => {
    if (!data || more || !hasMore) return;
    setMore(true);
    const my = seq.current;
    try {
      const d = await api<Data>(url(data.items.length));
      if (my === seq.current) setData((cur) => (cur ? { ...d, items: [...cur.items, ...d.items.filter((c) => !cur.items.some((x) => x.id === c.id))] } : d));
    } finally {
      setMore(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, more, hasMore]);

  // carrega mais quando o fim da lista aparece (rolando dentro do cartão no notebook, ou a página no celular)
  const sentinel = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && void loadMore(), { root: fit ? scroller.current : null, rootMargin: "600px" });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore, fit]);

  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [writing, setWriting] = useState<Contact | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const send = async (json: unknown) => {
    setErr(null);
    setResult(null);
    setBusy(true);
    try {
      setResult(await api<Result>("/api/contatos/importar", { method: "POST", json }));
      void reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fromFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    await send({ vcf: slimVcf(await f.text()) });
  };
  const fromPhone = async () => {
    try {
      const picked: { name?: string[]; tel?: string[] }[] = await picker.select(["name", "tel"], { multiple: true });
      if (!picked.length) return;
      await send({ contacts: picked.map((c) => ({ name: c.name?.[0] ?? "", phones: (c.tel ?? []).map((number) => ({ number })) })) });
    } catch {
      /* fechou o seletor */
    }
  };

  const remove = async (c: Contact) => {
    if (!(await confirmDialog({ title: `Apagar ${named(c.name) ? c.name : showPhone(c.phone)}?`, body: "Sai da sua agenda. O assistente deixa de achar esse número pelo nome.", confirmLabel: "Apagar", danger: true })))
      return;
    await api(`/api/contatos/${c.id}`, { method: "DELETE" });
    setData((cur) => (cur ? { ...cur, total: cur.total - 1, noname: cur.noname - (named(c.name) ? 0 : 1), items: cur.items.filter((x) => x.id !== c.id) } : cur));
  };
  const rename = async (c: Contact, name: string) => {
    const r = await api<{ name: string }>(`/api/contatos/${c.id}`, { method: "PATCH", json: { name } });
    setEditing(null);
    setData((cur) =>
      cur ? { ...cur, noname: cur.noname - (named(c.name) ? 0 : 1), items: cur.items.map((x) => (x.id === c.id ? { ...x, name: r.name } : x)).filter((x) => !(onlyNoName && x.id === c.id)) } : cur,
    );
  };
  const copy = (c: Contact) => void navigator.clipboard?.writeText(c.phone);

  // segurar o contato no celular: copiar, renomear ou apagar
  const press = useLongPress(
    (el) => {
      const c = data?.items.find((x) => String(x.id) === el.dataset.id);
      if (!c) return [];
      return [
        { label: "Mandar mensagem", icon: "send", onSelect: () => setWriting(c) },
        { label: "Copiar número", icon: "copy", onSelect: () => copy(c) },
        { label: named(c.name) ? "Mudar nome" : "Dar nome", icon: "edit", onSelect: () => setEditing(c.id) },
        { label: "Apagar", icon: "trash", danger: true, onSelect: () => void remove(c) },
      ];
    },
    (el) => {
      const c = data?.items.find((x) => String(x.id) === el.dataset.id);
      return c ? (named(c.name) ? c.name : showPhone(c.phone)) : undefined;
    },
  );

  if (error && !data) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;

  // grupos por letra (só na lista completa; na busca a ordem é por parecença)
  const groups: { letter: string; items: Contact[] }[] = [];
  for (const c of data.items) {
    const letter = query ? "" : named(c.name) ? letterOf(c.name) : "Sem nome";
    const last = groups[groups.length - 1];
    if (last && last.letter === letter) last.items.push(c);
    else groups.push({ letter, items: [c] });
  }

  return (
    <div className={`page ct-page${fit ? " fit" : ""}`}>
      <PageHead title="Contatos" subtitle='Traga os contatos do celular e peça no WhatsApp: "manda pra Ana que eu chego às 8". O assistente acha o número pelo nome.' />

      <div className="ct-body">
        <aside className="ct-side">
          <section className="card card-pad ct-import">
            <h3 className="cp-h"><Icon name="download" size={16} /> Importar do celular</h3>
            <div className="ct-actions">
              {picker && (
                <button className="btn btn-primary" disabled={busy} onClick={fromPhone}>
                  <Icon name="users" size={15} /> Escolher contatos
                </button>
              )}
              <button className={`btn ${picker ? "" : "btn-primary"}`} disabled={busy} onClick={() => file.current?.click()}>
                <Icon name="file" size={15} /> {busy ? "Importando…" : "Enviar arquivo .vcf"}
              </button>
              <input ref={file} type="file" accept=".vcf,text/vcard,text/x-vcard" hidden onChange={fromFile} />
            </div>
            {result && (
              <p className="cp-ok">
                <Icon name="check" size={14} /> {result.added} novos{result.saved - result.added > 0 ? `, ${result.saved - result.added} atualizados` : ""}
                {result.skipped > 0 ? `. ${result.skipped} sem nome ou sem celular ficaram de fora` : ""}
                {result.over_limit > 0 ? `. ${result.over_limit} passaram do limite de 5.000` : ""}.
              </p>
            )}
            {err && <p className="cp-err">{err}</p>}
            <details className="ct-how">
              <summary>Como tirar o arquivo do celular</summary>
              <p><strong>iPhone:</strong> abra Contatos, toque em Listas, segure em "Todos os Contatos" e escolha Exportar. Salve o arquivo e envie aqui.</p>
              <p><strong>Android:</strong> abra Contatos, vá em Corrigir e gerenciar (ou Configurações) e toque em Exportar para arquivo. Envie o .vcf aqui. No Chrome do Android dá também para tocar em "Escolher contatos" e marcar vários.</p>
              <p className="muted">Ficam só nome e número, e só você vê. Importar de novo atualiza sem duplicar.</p>
            </details>
          </section>

          <section className="card card-pad">
            <h3 className="cp-h"><Icon name="user-plus" size={16} /> Novo contato</h3>
            <AddContact onSaved={() => void reload()} />
          </section>

          {data.total > 0 && (
            <button
              className="link-btn ct-clear"
              onClick={async () => {
                if (!(await confirmDialog({ title: "Apagar todos os contatos?", body: "A agenda fica vazia. Dá para importar de novo quando quiser.", confirmLabel: "Apagar todos", danger: true }))) return;
                await api("/api/contatos", { method: "DELETE" });
                setResult(null);
                void reload();
              }}
            >
              Apagar todos os contatos
            </button>
          )}
        </aside>

        <section className="card ct-book">
          <div className="ct-head">
            <h3 className="cp-h">
              <Icon name="users" size={16} /> Sua agenda <span className="muted ct-count">{data.total.toLocaleString("pt-BR")}</span>
            </h3>
            <label className="ct-search">
              <Icon name="search" size={15} />
              <input type="search" placeholder="Buscar nome ou número" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar contato" />
            </label>
            {data.noname > 0 && !query && (
              <div className="seg" role="group" aria-label="Mostrar">
                <button className={!onlyNoName ? "active" : ""} onClick={() => setOnlyNoName(false)}>Todos</button>
                <button className={onlyNoName ? "active" : ""} onClick={() => setOnlyNoName(true)}>Sem nome {data.noname.toLocaleString("pt-BR")}</button>
              </div>
            )}
          </div>
          {data.noname > 0 && !query && (
            <p className="ct-note">
              {data.noname === 1 ? "1 contato veio" : `${data.noname.toLocaleString("pt-BR")} contatos vieram`} sem nome de uma importação antiga. Envie o mesmo arquivo .vcf de novo: os nomes
              entram no lugar, sem duplicar. Também dá para tocar no cartão e escrever o nome.
            </p>
          )}

          <div className="ct-scroll" ref={scroller}>
            {data.items.length === 0 ? (
              <p className="muted ct-empty">{query ? "Ninguém com esse nome ou número." : "Nenhum contato ainda. Envie o arquivo do celular ou adicione um por um."}</p>
            ) : (
              groups.map((g, i) => (
                <div key={`${g.letter}-${i}`} className="ct-group">
                  {g.letter && <h4 className="ct-letter">{g.letter}</h4>}
                  <ul className="ct-grid">
                    {g.items.map((c) => (
                      <ContactCard
                        key={c.id}
                        c={c}
                        editing={editing === c.id}
                        onEdit={() => setEditing(c.id)}
                        onCancel={() => setEditing(null)}
                        onRename={(name) => rename(c, name)}
                        onCopy={() => copy(c)}
                        onWrite={() => setWriting(c)}
                        onRemove={() => void remove(c)}
                        press={press}
                      />
                    ))}
                  </ul>
                </div>
              ))
            )}
            {hasMore && (
              <div ref={sentinel} className="ct-more">
                <button className="btn" disabled={more} onClick={() => void loadMore()}>
                  {more ? "Carregando…" : `Mostrar mais (${(shown - data.items.length).toLocaleString("pt-BR")})`}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
      {writing && <WriteMessage c={writing} onClose={() => setWriting(null)} />}
    </div>
  );
}

/**
 * Mensagem a partir do contato: escreve, vê exatamente como vai sair (com a apresentação e o aviso do SAIR
 * no primeiro contato) e só então envia. Sai como mensagem avulsa; a resposta volta no WhatsApp e em Recados.
 */
function WriteMessage({ c, onClose }: { c: Contact; onClose: () => void }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const who = named(c.name) ? c.name : showPhone(c.phone);
  const call = async (confirm: boolean) => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ preview?: string; ok?: boolean; tip?: string | null }>(`/api/contatos/${c.id}/mensagem`, { method: "POST", json: { message: text, confirm } });
      if (confirm) setDone(r.tip ?? `Mandei para ${who}. Se responder, a resposta chega no seu WhatsApp e aparece em Recados.`);
      else setPreview(r.preview ?? "");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Mensagem para ${who}`}
      icon={<Icon name="send" size={18} />}
      onClose={onClose}
      footer={(close) =>
        done ? (
          <button className="btn btn-primary" onClick={close}>Fechar</button>
        ) : preview != null ? (
          <>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setPreview(null)}>Editar</button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void call(true)}>{busy ? "Enviando…" : "Enviar"}</button>
          </>
        ) : (
          <>
            <button className="btn btn-ghost" onClick={close}>Cancelar</button>
            <button className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => void call(false)}>Continuar</button>
          </>
        )
      }
    >
      <ErrorBox error={err} />
      {done ? (
        <p className="ct-msg-done"><Icon name="check" size={15} /> {done}</p>
      ) : preview != null ? (
        <>
          <p className="muted ct-msg-hint">Vai sair assim no WhatsApp de {who} ({showPhone(c.phone)}):</p>
          <div className="ct-msg-preview">{preview}</div>
        </>
      ) : (
        <div className="field">
          <label htmlFor="ct-msg">O que você quer mandar</label>
          <textarea id="ct-msg" className="textarea" rows={4} maxLength={2000} autoFocus={!matchMedia("(pointer: coarse)").matches} value={text} onChange={(e) => setText(e.target.value)} placeholder="Oi! Chego às 8, tudo certo?" />
          <small className="muted">Sai pelo número do Planejai, com uma apresentação dizendo que é seu assistente. Antes de enviar você vê o texto final.</small>
        </div>
      )}
    </Modal>
  );
}

function ContactCard({
  c,
  editing,
  onEdit,
  onCancel,
  onRename,
  onCopy,
  onWrite,
  onRemove,
  press,
}: {
  c: Contact;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onRename: (name: string) => Promise<void>;
  onCopy: () => void;
  onWrite: () => void;
  onRemove: () => void;
  press: ReturnType<typeof useLongPress>;
}) {
  const ok = named(c.name);
  const [name, setName] = useState(ok ? c.name : "");
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (editing) {
      setName(ok ? c.name : "");
      setErr(null);
    }
  }, [editing, ok, c.name]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await onRename(name);
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  };

  return (
    <li className={`ct-card${ok ? "" : " noname"}${editing ? " editing" : ""}`} data-id={c.id} {...(editing ? {} : press)}>
      <span className="ct-avatar" aria-hidden="true">{ok ? initials(c.name) : <Icon name="user" size={18} />}</span>
      {editing ? (
        <form className="ct-edit" onSubmit={submit}>
          <input className="input" autoFocus placeholder="Nome do contato" value={name} onChange={(e) => setName(e.target.value)} aria-label="Nome do contato" onKeyDown={(e) => e.key === "Escape" && onCancel()} />
          <small className="ct-phone">{showPhone(c.phone)}</small>
          {err && <small className="cp-err">{err}</small>}
          <div className="ct-edit-actions">
            <button type="button" className="btn btn-sm" onClick={onCancel}>Cancelar</button>
            <button className="btn btn-sm btn-primary">Salvar</button>
          </div>
        </form>
      ) : (
        <>
          <button type="button" className="ct-info" onClick={onEdit} title={ok ? "Mudar nome" : "Dar nome"}>
            <strong>{ok ? c.name : "Sem nome"}</strong>
            <span className="ct-sub">
              <small className="ct-phone">{showPhone(c.phone)}</small>
              {(c.label || c.approximate) && <small className="ct-tag">{c.approximate ? "nome parecido" : c.label}</small>}
            </span>
          </button>
          <button type="button" className="icon-btn sm ct-send" aria-label={`Mandar mensagem para ${ok ? c.name : showPhone(c.phone)}`} title="Mandar mensagem" onClick={onWrite}>
            <Icon name="send" size={15} />
          </button>
          <div className="ct-tools">
            <button
              className="icon-btn sm"
              aria-label={`Copiar número de ${ok ? c.name : showPhone(c.phone)}`}
              title={copied ? "Copiado" : "Copiar número"}
              onClick={() => {
                onCopy();
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
            >
              <Icon name={copied ? "check" : "copy"} size={15} />
            </button>
            <button className="icon-btn sm" aria-label={`Apagar ${ok ? c.name : showPhone(c.phone)}`} title="Apagar" onClick={onRemove}>
              <Icon name="trash" size={15} />
            </button>
          </div>
        </>
      )}
    </li>
  );
}

function AddContact({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    try {
      await api("/api/contatos", { method: "POST", json: { name, phone } });
      setName("");
      setPhone("");
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    }
  };
  return (
    <form className="ct-add" onSubmit={submit}>
      <input className="input" placeholder="Nome" value={name} onChange={(e) => setName(e.target.value)} required aria-label="Nome" />
      <input className="input" inputMode="tel" placeholder="WhatsApp com DDD" value={phone} onChange={(e) => setPhone(e.target.value)} required aria-label="WhatsApp" />
      <button className="btn">Adicionar</button>
      {err && <span className="cp-err">{err}</span>}
    </form>
  );
}

import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ErrorBox, Loading, PageHead, confirmDialog } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";

interface Contact {
  id: string;
  name: string;
  phone: string;
  label: string | null;
}
interface Data {
  total: number;
  items: Contact[];
}
interface Result {
  saved: number;
  added: number;
  skipped: number;
  over_limit: number;
}

/** +55 (19) 99123-4567; número de fora fica com o DDI. */
const showPhone = (p: string) => {
  const m = p.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : `+${p}`;
};

// seletor de contatos do celular (Chrome no Android); o iPhone não tem, lá vai pelo arquivo
const picker = typeof navigator !== "undefined" && "contacts" in navigator ? (navigator as any).contacts : null;

/** Tira foto e o que não serve do .vcf antes de mandar (foto de contato pesa megas). */
function slimVcf(text: string) {
  const out: string[] = [];
  let skip = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]/.test(line)) {
      if (!skip) out.push(line);
      continue;
    }
    skip = !/^(?:item\d+\.)?(BEGIN|END|VERSION|FN|N|ORG|TEL)[;:]/i.test(line);
    if (!skip) out.push(line);
  }
  return out.join("\n");
}

/**
 * Agenda de contatos: importa do celular (arquivo .vcf ou o seletor do Android) para o assistente achar o número
 * pelo nome na hora de mandar mensagem. Cada um vê só a sua.
 */
export function ContactsPage() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, error, reload } = useApi<Data>(`/api/contatos${query ? `?q=${encodeURIComponent(query)}` : ""}`);
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const send = async (json: unknown) => {
    setErr(null);
    setResult(null);
    setBusy(true);
    try {
      setResult(await api<Result>("/api/contatos/importar", { method: "POST", json }));
      reload();
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

  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;

  return (
    <div className="page ct-page">
      <PageHead title="Contatos" subtitle='Traga os contatos do celular e peça no WhatsApp: "manda pra Ana que eu chego às 8". O assistente acha o número pelo nome.' />

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
            {result.skipped > 0 ? `. ${result.skipped} sem celular ficaram de fora` : ""}
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
        <div className="ct-head">
          <h3 className="cp-h"><Icon name="users" size={16} /> Sua agenda <span className="muted ct-count">{data.total}</span></h3>
          <input className="input" type="search" placeholder="Buscar nome ou número" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Buscar contato" />
        </div>
        <AddContact onSaved={reload} />
        {data.items.length === 0 ? (
          <p className="muted cp-small">{query ? "Ninguém com esse nome." : "Nenhum contato ainda."}</p>
        ) : (
          <ul className="ct-list">
            {data.items.map((c) => (
              <li key={c.id}>
                <span>
                  <strong>{c.name}</strong>
                  <small>{showPhone(c.phone)}{c.label ? ` · ${c.label}` : ""}</small>
                </span>
                <button
                  className="icon-btn sm"
                  aria-label={`Apagar ${c.name}`}
                  onClick={async () => {
                    await api(`/api/contatos/${c.id}`, { method: "DELETE" });
                    reload();
                  }}
                >
                  <Icon name="trash" size={15} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {!query && data.total > data.items.length && <p className="muted cp-small">Mostrando {data.items.length} de {data.total}. Use a busca para achar os outros.</p>}
        {data.total > 0 && (
          <button
            className="link-btn ct-clear"
            onClick={async () => {
              if (!(await confirmDialog({ title: "Apagar todos os contatos?", body: "A agenda fica vazia. Dá para importar de novo quando quiser.", confirmLabel: "Apagar todos", danger: true }))) return;
              await api("/api/contatos", { method: "DELETE" });
              setResult(null);
              reload();
            }}
          >
            Apagar todos
          </button>
        )}
      </section>
    </div>
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

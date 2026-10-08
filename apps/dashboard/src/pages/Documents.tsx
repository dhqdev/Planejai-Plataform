import { useMemo, useRef, useState } from "react";
import { api, day } from "../api";
import { Empty, ErrorBox, Modal, PageHead } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

interface Doc { id: string; name: string; mimetype: string; size: number; folder: string | null; notes: string | null; source: string; created_at: string; owner_name?: string | null }
interface Resp { items: Doc[]; usage: { count: number; bytes: number; quota: number } | null; max_bytes: number }

export const bytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const kind = (m: string) => (m === "application/pdf" ? "PDF" : m.startsWith("image/") ? "Imagem" : /sheet|excel|csv/.test(m) ? "Planilha" : /word|document|text/.test(m) ? "Texto" : "Arquivo");
const readB64 = (f: File) =>
  new Promise<string>((ok, bad) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => bad(r.error);
    r.readAsDataURL(f);
  });

export function DocumentsPage() {
  const { data, error, reload } = useApi<Resp>("/api/documents", { poll: 60000 });
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState("");
  const [del, setDel] = useState<Doc | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const all = data?.items ?? [];
  const folders = useMemo(() => [...new Set(all.map((d) => d.folder).filter(Boolean) as string[])].sort(), [all]);
  const items = all.filter((d) => (!folder || d.folder === folder) && (!q || `${d.name} ${d.notes ?? ""} ${d.folder ?? ""} ${d.owner_name ?? ""}`.toLowerCase().includes(q.toLowerCase())));

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    haptic(10);
    setBusy(true);
    setErr(null);
    try {
      for (const f of Array.from(files)) {
        if (data && f.size > data.max_bytes) throw new Error(`${f.name}: grande demais (máx. ${bytes(data.max_bytes)})`);
        await api("/api/documents", { method: "POST", json: { name: f.name, mimetype: f.type || "application/octet-stream", base64: await readB64(f), folder: newFolder.trim() || folder } });
      }
      void reload();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  };

  const used = data?.usage;
  return (
    <div className="page fit docs-page">
      <PageHead
        title="Documentos"
        subtitle="PDFs, fotos e arquivos guardados. Mande no WhatsApp com “guarda esse documento” e peça de volta quando precisar."
        actions={
          <div className="row">
            <input className="input" style={{ width: 200 }} placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} />
            <input ref={input} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => input.current?.click()}>
              <Icon name="plus" size={15} /> {busy ? "Enviando…" : "Enviar arquivo"}
            </button>
          </div>
        }
      />
      <ErrorBox error={error ?? err} />
      <div className="docs-bar">
        <div className="docs-folders">
          <button className={`chip ${!folder ? "active" : ""}`} onClick={() => setFolder(null)}>Todos <span className="mono">{all.length}</span></button>
          {folders.map((f) => (
            <button key={f} className={`chip ${folder === f ? "active" : ""}`} onClick={() => setFolder(f)}>
              <Icon name="folder" size={13} /> {f} <span className="mono">{all.filter((d) => d.folder === f).length}</span>
            </button>
          ))}
          <input className="input input-sm docs-newfolder" placeholder="Pasta para o próximo envio" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />
        </div>
        {used && (
          <div className="docs-usage" title="Espaço usado">
            <span className="label-sm">Espaço</span>
            <span className="mono">{bytes(used.bytes)} / {bytes(used.quota)}</span>
            <span className="docs-meter"><span style={{ width: `${Math.min(100, (used.bytes / used.quota) * 100)}%` }} /></span>
          </div>
        )}
      </div>
      <div className="card docs-list scroll-y">
        <table className="table">
          <thead>
            <tr><th>Nome</th><th className="hide-phone">Tipo</th><th className="hide-phone">Pasta</th><th className="hide-phone">Tamanho</th><th>Quando</th><th /></tr>
          </thead>
          <tbody>
            {items.map((d) => (
              <tr key={d.id}>
                <td>
                  <a className="doc-name" href={`/api/documents/${d.id}/file?inline=1`} target="_blank" rel="noreferrer">
                    <Icon name={d.mimetype.startsWith("image/") ? "eye" : "file"} size={16} />
                    <span>{d.name}</span>
                  </a>
                  {d.notes && <div className="muted doc-notes">{d.notes}</div>}
                </td>
                <td className="hide-phone muted">{kind(d.mimetype)}</td>
                <td className="hide-phone muted">{d.folder ?? "–"}</td>
                <td className="hide-phone mono muted">{bytes(d.size)}</td>
                <td className="muted mono" style={{ whiteSpace: "nowrap" }}>{day(d.created_at)}</td>
                <td style={{ whiteSpace: "nowrap", textAlign: "right" }}>
                  <a className="btn btn-sm btn-ghost" href={`/api/documents/${d.id}/file`} title="Baixar" onClick={() => haptic()}><Icon name="download" size={14} /></a>
                  <button className="btn btn-sm btn-ghost" title="Apagar" onClick={() => { haptic(); setDel(d); }}><Icon name="trash" size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && !items.length && <Empty>{all.length ? "Nada com esse filtro." : "Nenhum documento ainda. Envie aqui ou mande no WhatsApp pedindo para guardar."}</Empty>}
      </div>
      {del && (
        <Modal
          title="Apagar documento"
          onClose={() => setDel(null)}
          footer={
            <>
              <button className="btn" onClick={() => setDel(null)}>Cancelar</button>
              <button
                className="btn btn-danger"
                onClick={async () => {
                  haptic(12);
                  await api(`/api/documents/${del.id}`, { method: "DELETE" }).catch((e) => setErr((e as Error).message));
                  setDel(null);
                  void reload();
                }}
              >
                Apagar
              </button>
            </>
          }
        >
          <p>“{del.name}” some de vez, do painel e do assistente.</p>
        </Modal>
      )}
    </div>
  );
}

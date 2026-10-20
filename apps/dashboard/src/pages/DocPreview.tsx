import { useEffect, useRef, useState } from "react";
import { Modal } from "../components";
import { Icon } from "../icons";

export interface PreviewDoc { id: string; name: string; mimetype: string; size: number }

type Kind = "pdf" | "image" | "text" | "video" | "audio" | "none";
const TEXT_MAX = 400 * 1024;

export function previewKind(d: { name: string; mimetype: string }): Kind {
  const m = d.mimetype.toLowerCase();
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("image/") && !m.includes("svg")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("text/") || /json|xml|csv|markdown/.test(m) || /\.(txt|md|csv|json|log)$/i.test(d.name)) return "text";
  return "none";
}

/** Páginas do PDF desenhadas em canvas: o iframe nativo mostra só a 1ª página no iPhone e nada no Android. */
function PdfPages({ blob, onError }: { blob: Blob; onError: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ done: number; total: number }>({ done: 0, total: 0 });
  useEffect(() => {
    let dead = false;
    let destroy: (() => void) | null = null;
    (async () => {
      const [pdfjs, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
      destroy = () => void pdf.destroy();
      if (dead || !box.current) return;
      setState({ done: 0, total: pdf.numPages });
      const width = box.current.clientWidth || 600;
      const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        if (dead) return;
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: (width / base.width) * ratio });
        const canvas = document.createElement("canvas");
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        canvas.className = "dp-page";
        canvas.setAttribute("aria-label", `Página ${n}`);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("canvas");
        await page.render({ canvasContext: ctx, viewport: vp }).promise;
        if (dead) return;
        box.current?.appendChild(canvas);
        setState({ done: n, total: pdf.numPages });
      }
    })().catch(() => !dead && onError());
    return () => {
      dead = true;
      destroy?.();
    };
  }, [blob, onError]);
  return (
    <div ref={box} className="dp-pdf">
      {state.done < state.total || !state.total ? <div className="dp-hint mono">{state.total ? `Página ${state.done + 1} de ${state.total}` : "Abrindo…"}</div> : null}
    </div>
  );
}

/** Pré-visualização de um documento guardado. Lê o arquivo com a sessão do painel (vale também para o que está só no Backblaze). */
export function DocPreview({ doc, onClose }: { doc: PreviewDoc; onClose: () => void }) {
  const kind = previewKind(doc);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [fail, setFail] = useState(false);
  const failed = () => setFail(true);

  useEffect(() => {
    if (kind === "none") return;
    let dead = false;
    let made: string | null = null;
    fetch(`/api/documents/${doc.id}/file?inline=1`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        const b = await r.blob();
        if (dead) return;
        if (kind === "text") setText((await b.slice(0, TEXT_MAX).text()) + (b.size > TEXT_MAX ? "\n\n… (o resto aparece ao baixar)" : ""));
        else if (kind === "pdf") setBlob(b);
        else {
          made = URL.createObjectURL(new Blob([b], { type: doc.mimetype }));
          setUrl(made);
        }
      })
      .catch(() => !dead && failed());
    return () => {
      dead = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [doc.id, doc.mimetype, kind]);

  const loading = !fail && kind !== "none" && !blob && text === null && !url;
  return (
    <Modal
      title={doc.name}
      wide
      className="doc-preview"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Fechar</button>
          <a className="btn btn-primary" href={`/api/documents/${doc.id}/file`}>
            <Icon name="download" size={15} /> Baixar
          </a>
        </>
      }
    >
      <div className="dp-stage">
        {kind === "none" || fail ? (
          <div className="dp-none">
            <Icon name="file" size={28} />
            <strong>{fail ? "Não consegui abrir aqui" : "Esse tipo não abre aqui"}</strong>
            <span className="muted">Baixe o arquivo para ver no seu aparelho.</span>
          </div>
        ) : loading ? (
          <div className="dp-hint mono">Abrindo…</div>
        ) : kind === "pdf" && blob ? (
          <PdfPages blob={blob} onError={failed} />
        ) : kind === "image" && url ? (
          <img className="dp-img" src={url} alt={doc.name} onError={failed} />
        ) : kind === "video" && url ? (
          <video className="dp-img" src={url} controls playsInline onError={failed} />
        ) : kind === "audio" && url ? (
          <audio src={url} controls onError={failed} />
        ) : text !== null ? (
          <pre className="dp-text">{text}</pre>
        ) : null}
      </div>
    </Modal>
  );
}

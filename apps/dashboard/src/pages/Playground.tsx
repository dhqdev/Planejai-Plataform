import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { ErrorBox, PageHead } from "../components";

interface Item {
  role: "user" | "assistant" | "event";
  text?: string;
  img?: string;
  reaction?: string;
  executionId?: string;
}

export function PlaygroundPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState("");
  const [image, setImage] = useState<{ base64: string; mimetype: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api<any[]>("/api/playground/history").then((rows) =>
      setItems(rows.map((r) => ({ role: r.role, text: r.content, reaction: r.meta?.reaction }))),
    );
  }, []);
  useEffect(() => end.current?.scrollIntoView({ behavior: "smooth" }), [items]);

  const send = async () => {
    if (!text.trim() && !image) return;
    const mine: Item = { role: "user", text, img: image?.preview };
    setItems((p) => [...p, mine]);
    setText("");
    setImage(null);
    setBusy(true);
    setError(null);
    try {
      const r = await api("/api/playground", { method: "POST", json: { text: mine.text, image: image ? { base64: image.base64, mimetype: image.mimetype } : undefined } });
      setItems((p) => {
        const next = [...p];
        const userIdx = next.lastIndexOf(mine);
        const reaction = r.sent.find((s: any) => s.type === "reaction");
        if (reaction && userIdx >= 0) next[userIdx] = { ...mine, reaction: reaction.emoji };
        for (const s of r.sent) {
          if (s.type === "text") next.push({ role: "assistant", text: s.text, executionId: r.executionId });
          if (s.type === "image") next.push({ role: "assistant", img: s.src, text: s.caption, executionId: r.executionId });
        }
        if (!r.sent.some((s: any) => s.type !== "reaction")) next.push({ role: "event", text: "(o agente escolheu não responder)", executionId: r.executionId });
        return next;
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHead
        title="Playground"
        subtitle="Converse com o agente aqui, do mesmo jeito que no WhatsApp"
        actions={
          <button
            className="btn"
            onClick={async () => {
              await api("/api/playground", { method: "POST", json: { reset: true } });
              setItems([]);
            }}
          >
            Nova conversa
          </button>
        }
      />
      <div className="card card-pad">
        <div className="chat" style={{ maxHeight: "60vh", overflow: "auto" }}>
          {items.map((m, i) => (
            <div key={i} className={`bubble ${m.role}`}>
              {m.img && <img src={m.img} alt="" />}
              {m.text}
              {m.executionId && (
                <div className="time">
                  <Link to={`/executions/${m.executionId}`}>ver execução →</Link>
                </div>
              )}
              {m.reaction && <span className="reaction">{m.reaction}</span>}
            </div>
          ))}
          {busy && <div className="bubble assistant muted">digitando…</div>}
          <div ref={end} />
        </div>
        <ErrorBox error={error} />
        <div className="row" style={{ marginTop: 12 }}>
          <label className="btn" title="Anexar foto">
            📎
            <input
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => {
                  const url = String(reader.result);
                  setImage({ base64: url.split(",")[1]!, mimetype: f.type, preview: url });
                };
                reader.readAsDataURL(f);
              }}
            />
          </label>
          {image && <span className="badge badge-accent">foto anexada <button className="btn btn-ghost btn-sm" onClick={() => setImage(null)}>✕</button></span>}
          <input
            className="input"
            placeholder="Mensagem"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void send()}
          />
          <button className="btn btn-primary" onClick={send} disabled={busy}>
            Enviar
          </button>
        </div>
      </div>
    </div>
  );
}

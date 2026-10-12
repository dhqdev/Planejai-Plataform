import { useEffect, useRef, useState, type PointerEvent } from "react";
import { api } from "../api";
import { ErrorBox, Modal } from "../components";
import { Icon } from "../icons";
import { haptic, isStandalone } from "../touch";

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const label = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} de ${m.slice(0, 4)}`;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const viaShare = (file: File) => (isIOS() || isStandalone()) && typeof navigator.canShare === "function" && navigator.canShare({ files: [file] });

/** Onda que sai do ponto do toque (o "afundar" do :active continua no CSS). */
function ripple(e: PointerEvent<HTMLElement>) {
  const el = e.currentTarget;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2;
  const dot = document.createElement("span");
  dot.className = "rep-ripple";
  dot.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
  el.appendChild(dot);
  dot.addEventListener("animationend", () => dot.remove());
}

/**
 * Relatório de finanças em PDF (montado no servidor por finance-report.ts, sem IA): baixar o do mês aberto,
 * mandar no WhatsApp agora e escolher o dia do mês em que ele chega sozinho (com o mês anterior completo).
 */
export function ReportModal({ month, user, readonly, onClose }: { month: string; user: string; readonly: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState<"download" | "send" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [day, setDay] = useState<string>("");
  const [loaded, setLoaded] = useState(false);
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "done">("idle");
  const pdf = useRef<File | null>(null);
  const doneTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(doneTimer.current), []);

  useEffect(() => {
    if (readonly) return;
    api<{ schedule: { day: number } | null }>("/api/finance/report/schedule")
      .then((r) => setDay(r.schedule ? String(r.schedule.day) : ""))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [readonly]);

  // celular: o PDF vai pela folha de compartilhar do aparelho (Salvar em Arquivos, WhatsApp...). No iPhone
  // instalado, um link de download abria o PDF por cima do app, sem botão de voltar.
  const share = async (file: File) => {
    try {
      await navigator.share({ files: [file], title: file.name });
      finish();
    } catch (e) {
      if ((e as Error).name === "AbortError") return setPhase("idle");
      // o toque "venceu" enquanto o PDF era gerado: o botão vira "Salvar PDF" e o próximo toque compartilha
      if ((e as Error).name === "NotAllowedError") return setPhase("ready");
      save(file);
    }
  };
  const save = (file: File) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    finish();
  };
  const finish = () => {
    haptic(12);
    setPhase("done");
    window.clearTimeout(doneTimer.current);
    doneTimer.current = window.setTimeout(() => setPhase("idle"), 2200);
  };

  const download = async () => {
    haptic(10);
    if (phase === "ready" && pdf.current) return void share(pdf.current);
    setBusy("download");
    setPhase("loading");
    setError(null);
    try {
      const res = await fetch(`/api/finance/report?month=${month}${user ? `&user=${user}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Erro ${res.status}`);
      const file = new File([await res.blob()], `Relatório financeiro - ${label(month)}.pdf`, { type: "application/pdf" });
      pdf.current = file;
      if (viaShare(file)) await share(file);
      else save(file);
    } catch (e) {
      setPhase("idle");
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    setBusy("send");
    setError(null);
    try {
      await api("/api/finance/report/send", { method: "POST", json: { month } });
      haptic(10);
      setNote("Mandei o PDF no seu WhatsApp. Ele também ficou em Documentos.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const saveDay = async (value: string) => {
    setDay(value);
    setBusy("save");
    setError(null);
    try {
      await api("/api/finance/report/schedule", { method: "PUT", json: { day: value ? Number(value) : null } });
      haptic(8);
      setNote(value ? `Combinado: todo dia ${value}, às 9h, o relatório do mês anterior chega no seu WhatsApp.` : "Envio automático desligado.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const main = {
    idle: { icon: "download", text: "Baixar PDF" },
    loading: { icon: null, text: "Gerando o PDF…" },
    ready: { icon: "download", text: "Salvar PDF" },
    done: { icon: "check", text: "Pronto" },
  }[phase];

  return (
    <Modal title="Relatório em PDF" icon={<Icon name="file" />} onClose={onClose} className="rep-modal">
      <div className="rep-hero">
        <div className={`rep-paper${phase === "loading" ? " busy" : ""}`} aria-hidden="true">
          <i className="bar" />
          <i /><i /><i className="short" />
          <span className="chart"><b style={{ height: "45%" }} /><b style={{ height: "80%" }} /><b style={{ height: "60%" }} /><b style={{ height: "95%" }} /></span>
          <em>PDF</em>
        </div>
        <strong>{label(month).replace(/^./, (c) => c.toUpperCase())}</strong>
        <p className="muted">Resumo explicado, categorias, gráficos, cartões e todos os lançamentos do mês.</p>
      </div>
      <div className="rep-actions">
        <button className={`btn btn-primary rep-btn rep-main is-${phase}`} disabled={busy != null} onPointerDown={ripple} onClick={download} aria-live="polite">
          {main.icon ? <Icon key={phase} name={main.icon} size={18} /> : <span className="rep-spin" aria-hidden="true" />}
          <span>{main.text}</span>
        </button>
        {!readonly && (
          <button className="btn rep-btn" disabled={busy != null} onPointerDown={ripple} onClick={send}>
            {busy === "send" ? <span className="rep-spin" aria-hidden="true" /> : <Icon name="send" size={17} />}
            <span>{busy === "send" ? "Mandando…" : "Mandar no WhatsApp"}</span>
          </button>
        )}
      </div>
      {note && <p className="rep-note"><Icon name="check" size={14} /> {note}</p>}
      <ErrorBox error={error} />
      {!readonly && (
        <div className="rep-auto">
          <div>
            <label htmlFor="rep-day">Todo mês no WhatsApp</label>
            <p className="muted">Às 9h, com o mês anterior completo.</p>
          </div>
          <select id="rep-day" className="select" value={day} disabled={!loaded || busy === "save"} onChange={(e) => void saveDay(e.target.value)}>
            <option value="">Desligado</option>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Dia {d}</option>)}
          </select>
        </div>
      )}
    </Modal>
  );
}

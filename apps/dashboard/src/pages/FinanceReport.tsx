import { useEffect, useState } from "react";
import { api } from "../api";
import { ErrorBox, Modal } from "../components";
import { Icon } from "../icons";
import { haptic } from "../touch";

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const label = (m: string) => `${MONTHS[Number(m.slice(5)) - 1]} de ${m.slice(0, 4)}`;

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

  useEffect(() => {
    if (readonly) return;
    api<{ schedule: { day: number } | null }>("/api/finance/report/schedule")
      .then((r) => setDay(r.schedule ? String(r.schedule.day) : ""))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [readonly]);

  const download = async () => {
    setBusy("download");
    setError(null);
    try {
      const res = await fetch(`/api/finance/report?month=${month}${user ? `&user=${user}` : ""}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Erro ${res.status}`);
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement("a");
      a.href = url;
      a.download = `Relatório financeiro - ${label(month)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      haptic(8);
    } catch (e) {
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

  const save = async (value: string) => {
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

  return (
    <Modal title="Relatório em PDF" icon={<Icon name="file" />} onClose={onClose}>
      <div className="rep-block">
        <strong>Relatório de {label(month)}</strong>
        <p className="muted">Resumo do mês explicado, gastos por categoria, evolução dos últimos 6 meses, dia a dia, maiores gastos, como você pagou, limites, contas fixas, cartões e todos os lançamentos, com gráficos e tabelas.</p>
        <div className="rep-actions">
          <button className="btn btn-primary" disabled={busy != null} onClick={download}><Icon name="download" size={16} /> {busy === "download" ? "Gerando…" : "Baixar PDF"}</button>
          {!readonly && <button className="btn" disabled={busy != null} onClick={send}><Icon name="send" size={16} /> {busy === "send" ? "Mandando…" : "Mandar no WhatsApp"}</button>}
        </div>
      </div>
      {!readonly && (
        <div className="rep-block">
          <strong>Envio automático todo mês</strong>
          <div className="field" style={{ margin: "8px 0 4px" }}>
            <label htmlFor="rep-day">Receber no WhatsApp</label>
            <select id="rep-day" className="select" value={day} disabled={!loaded || busy === "save"} onChange={(e) => void save(e.target.value)}>
              <option value="">Desligado</option>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Todo dia {d}</option>)}
            </select>
          </div>
          <p className="muted">Às 9h do dia escolhido chega o PDF do mês anterior completo. Se o mês não tiver esse dia, vai no último dia.</p>
        </div>
      )}
      {note && <p className="rep-note"><Icon name="check" size={14} /> {note}</p>}
      <ErrorBox error={error} />
    </Modal>
  );
}

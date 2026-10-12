import { useState } from "react";
import { api, brl } from "../api";
import { ErrorBox, Modal, confirmDialog } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { DateField, isoDate } from "../pickers";
import { haptic } from "../touch";

/** Valores da API em centavos (target, saved, left, perMonth) ao lado dos campos originais da meta. */
type Goal = {
  id: string;
  title: string;
  deadline: string | null;
  done_at: string | null;
  target: number;
  saved: number;
  left: number;
  pct: number;
  months: number | null;
  perMonth: number | null;
};

const money = (cents: number) => brl(cents / 100);
const dateBR = (d: string) => d.split("-").reverse().join("/");

/**
 * Metas financeiras (Finanças > Visão geral): "juntar R$ 2.000 até dezembro". Guardar e tirar daqui ou pelo WhatsApp
 * ("guardei 200 na viagem"); o Moacir vê as metas no resumo do mês e diz quanto falta por mês.
 */
export function GoalsCard({ user, readonly }: { user: string; readonly: boolean }) {
  const { data, reload } = useApi<Goal[]>(`/api/goals${user ? `?user=${user}` : ""}`);
  const [editing, setEditing] = useState<Goal | "new" | null>(null);
  const [moving, setMoving] = useState<{ goal: Goal; withdraw: boolean } | null>(null);
  const goals = data ?? [];
  return (
    <div className="card fin-side-card fin-goals">
      <div className="fin-card-head">
        <span className="tone-ico" style={{ ["--c" as any]: "var(--brand-3, var(--violet))" }}><Icon name="target" size={15} /></span>
        <h3>Metas</h3>
        <span className="spacer" />
        {!readonly && <button className="link-btn" onClick={() => { haptic(5); setEditing("new"); }}>Nova meta <Icon name="chevron-right" size={13} /></button>}
      </div>
      {goals.map((g) => (
        <div key={g.id} className={`goal-row${g.done_at ? " done" : ""}`}>
          <button className="goal-main" disabled={readonly} onClick={() => { haptic(5); setEditing(g); }}>
            <span className="goal-top">
              <span className="ellipsis">{g.title}</span>
              <strong>{g.pct}%</strong>
            </span>
            <span className="goal-bar"><i style={{ width: `${g.pct}%` }} /></span>
            <small className="muted">
              {money(g.saved)} de {money(g.target)}
              {g.done_at ? " · concluída" : g.perMonth != null ? ` · ${money(g.perMonth)}/mês até ${dateBR(g.deadline!)}` : g.deadline ? ` · até ${dateBR(g.deadline)}` : ""}
            </small>
          </button>
          {!readonly && !g.done_at && (
            <button className="btn btn-sm goal-add" aria-label={`Guardar em ${g.title}`} onClick={() => { haptic(5); setMoving({ goal: g, withdraw: false }); }}>
              <Icon name="plus" size={14} /> Guardar
            </button>
          )}
          {g.done_at && <span className="bill-ok"><Icon name="check" size={15} /></span>}
        </div>
      ))}
      {data && !goals.length && (
        <div className="fin-empty-side">
          <p className="muted">Viagem, reserva, carro novo. Diga o valor e o prazo que o Moacir mostra quanto guardar por mês e acompanha com você.</p>
          {!readonly && <button className="btn btn-brand btn-sm" onClick={() => setEditing("new")}><Icon name="plus" size={14} /> Criar meta</button>}
        </div>
      )}
      {editing && (
        <GoalForm
          initial={editing === "new" ? null : editing}
          onWithdraw={editing !== "new" && editing.saved > 0 ? () => { setMoving({ goal: editing as Goal, withdraw: true }); setEditing(null); } : undefined}
          onClose={() => { setEditing(null); void reload(); }}
        />
      )}
      {moving && <MoveForm goal={moving.goal} withdraw={moving.withdraw} onClose={() => { setMoving(null); void reload(); }} />}
    </div>
  );
}

function GoalForm({ initial, onClose, onWithdraw }: { initial: Goal | null; onClose: () => void; onWithdraw?: () => void }) {
  const [f, setF] = useState({
    title: initial?.title ?? "",
    target: initial ? String(initial.target / 100).replace(".", ",") : "",
    deadline: initial?.deadline ?? "",
    saved: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (initial) await api(`/api/goals/${initial.id}`, { method: "PATCH", json: { title: f.title, target: f.target, deadline: f.deadline || null } });
      else await api("/api/goals", { method: "POST", json: { title: f.title, target: f.target, deadline: f.deadline || null, saved: f.saved || null } });
      haptic(10);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!initial || !(await confirmDialog({ title: "Apagar a meta?", body: `${initial.title}: o histórico do que você guardou some junto.`, confirmLabel: "Apagar", danger: true }))) return;
    await api(`/api/goals/${initial.id}`, { method: "DELETE" }).catch(() => {});
    onClose();
  };
  return (
    <Modal
      title={initial ? "Ajustar meta" : "Nova meta"}
      icon={<Icon name="target" />}
      onClose={onClose}
      footer={
        <>
          {initial && <button className="btn btn-ghost" onClick={remove}><Icon name="trash" size={15} /> Apagar</button>}
          {onWithdraw && <button className="btn btn-ghost" onClick={onWithdraw}>Tirar dinheiro</button>}
          <span className="spacer" />
          <button className="btn btn-primary" disabled={busy || !f.title.trim() || !f.target.trim()} onClick={save}>{busy ? "Salvando…" : "Salvar"}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="field">
        <label htmlFor="gl-title">Para quê</label>
        <input id="gl-title" className="input" autoComplete="off" maxLength={60} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Viagem para a praia" />
      </div>
      <div className="grid grid-2" style={{ gap: 10 }}>
        <div className="field">
          <label htmlFor="gl-target">Valor da meta (R$)</label>
          <input id="gl-target" className="input" inputMode="decimal" autoComplete="off" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} placeholder="2.000,00" />
        </div>
        <div className="field">
          <label htmlFor="gl-deadline">Até quando (opcional)</label>
          <DateField id="gl-deadline" title="Até quando" presets="prazo" clearable placeholder="Sem prazo" min={isoDate(new Date())} value={f.deadline} onChange={(deadline) => setF({ ...f, deadline })} />
        </div>
        {!initial && (
          <div className="field">
            <label htmlFor="gl-saved">Já tenho guardado (R$)</label>
            <input id="gl-saved" className="input" inputMode="decimal" autoComplete="off" value={f.saved} onChange={(e) => setF({ ...f, saved: e.target.value })} placeholder="0,00" />
          </div>
        )}
      </div>
    </Modal>
  );
}

function MoveForm({ goal, withdraw, onClose }: { goal: Goal; withdraw: boolean; onClose: () => void }) {
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/goals/${goal.id}/move`, { method: "POST", json: { amount, withdraw } });
      haptic(10);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={withdraw ? `Tirar de ${goal.title}` : `Guardar em ${goal.title}`}
      icon={<Icon name="wallet" />}
      onClose={onClose}
      footer={<button className="btn btn-primary" disabled={busy || !amount.trim()} onClick={save}>{busy ? "Salvando…" : withdraw ? "Tirar" : "Guardar"}</button>}
    >
      <ErrorBox error={error} />
      <p className="muted" style={{ margin: "0 0 10px" }}>
        {money(goal.saved)} guardado de {money(goal.target)}
        {!withdraw && goal.left > 0 ? `. Faltam ${money(goal.left)}.` : "."}
      </p>
      <div className="field">
        <label htmlFor="gl-move">Valor (R$)</label>
        <input id="gl-move" className="input" inputMode="decimal" autoComplete="off" autoFocus value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={goal.perMonth ? (goal.perMonth / 100).toFixed(2).replace(".", ",") : "200,00"} />
      </div>
    </Modal>
  );
}

import { useState } from "react";
import { api, brl, day } from "../api";
import { CATEGORY_COLORS, Donut, Empty, ErrorBox, Loading, Modal, PageHead, Stat } from "../components";
import { useApi } from "../hooks";

const SOURCE: Record<string, string> = { conversa: "💬 conversa", audio: "🎙️ áudio", comprovante: "🧾 comprovante", documento: "📄 documento", painel: "🖥️ painel" };

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function FinancePage({ isSuper }: { isSuper: boolean }) {
  const [month, setMonth] = useState(thisMonth());
  const [user, setUser] = useState("");
  const [adding, setAdding] = useState(false);
  const people = useApi<any[]>(isSuper ? "/api/people" : null);
  const { data, error, reload } = useApi<any>(`/api/finance?month=${month}${user ? `&user=${user}` : ""}`, { poll: 20000 });

  const months = data?.months ?? [];
  const prev = months.find((m: any) => m.month < month && m.month === shift(month, -1));
  const expenses = Number(data?.totals?.expenses ?? 0);
  const income = Number(data?.totals?.income ?? 0);
  const diff = prev ? expenses - Number(prev.expenses) : null;
  const cats = (data?.byCategory ?? []).map((c: any) => ({ label: c.category, value: Number(c.total), count: Number(c.count) }));
  const maxDay = Math.max(1, ...(data?.daily ?? []).map((d: any) => Number(d.expenses ?? 0)));
  const maxMonth = Math.max(1, ...months.map((m: any) => Math.max(Number(m.expenses), Number(m.income))));

  return (
    <div className="page">
      <PageHead
        title={isSuper ? "Finanças" : "Meus gastos"}
        subtitle="Tudo que a pessoa contou, mandou de comprovante ou documento vira lançamento sozinho."
        actions={
          <>
            {isSuper && (
              <select className="select" style={{ width: 200 }} value={user} onChange={(e) => setUser(e.target.value)}>
                <option value="">Todas as pessoas</option>
                {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name ?? `+${p.phone}`}</option>)}
              </select>
            )}
            <input className="input" type="month" style={{ width: 160 }} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            <button className="btn btn-primary" onClick={() => setAdding(true)} disabled={isSuper && !user}>+ Lançamento</button>
          </>
        }
      />
      <ErrorBox error={error} />
      {!data ? <Loading /> : (
        <>
          <div className="grid grid-4" style={{ marginBottom: 14 }}>
            <Stat label="Gastos no mês" value={brl(expenses)} icon="💸" sub={diff == null ? `${data.totals.count} lançamentos` : (
              <span className={diff > 0 ? "trend-up" : "trend-down"}>{diff > 0 ? "▲" : "▼"} {brl(Math.abs(diff))} vs mês anterior</span>
            )} />
            <Stat label="Receitas" value={brl(income)} icon="💵" tone="ok" />
            <Stat label="Saldo" value={<span style={{ color: income - expenses < 0 ? "var(--err)" : "var(--ok)" }}>{brl(income - expenses)}</span>} icon="⚖️" tone="info" />
            <Stat label="Maior categoria" value={cats[0]?.label ?? "–"} icon="🏷️" tone="warn" sub={cats[0] ? `${brl(cats[0].value)} · ${expenses ? Math.round((cats[0].value / expenses) * 100) : 0}%` : undefined} />
          </div>

          <div className="grid grid-2" style={{ marginBottom: 14 }}>
            <div className="card card-pad">
              <h3>Por categoria</h3>
              {cats.length ? (
                <div className="donut-wrap">
                  <Donut items={cats} center={<div><div className="muted">total</div><strong>{brl(expenses)}</strong></div>} />
                  <div className="legend">
                    {cats.map((c: any, i: number) => (
                      <div className="item" key={c.label}>
                        <span className="sw" style={{ background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />
                        {c.label} <span className="muted">({c.count})</span>
                        <strong>{brl(c.value)}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              ) : <Empty>Sem gastos neste mês.</Empty>}
            </div>
            <div className="card card-pad">
              <h3>Últimos 6 meses</h3>
              <div className="bars" style={{ height: 150 }}>
                {months.map((m: any) => (
                  <div key={m.month} style={{ flex: 1, display: "flex", gap: 3, alignItems: "flex-end", height: "100%" }} title={`${m.month}: gastos ${brl(m.expenses)}, receitas ${brl(m.income)}`}>
                    <div className="bar" style={{ height: `${(Number(m.expenses) / maxMonth) * 100}%` }} />
                    <div className="bar" style={{ height: `${(Number(m.income) / maxMonth) * 100}%`, background: "var(--ok)" }} />
                  </div>
                ))}
              </div>
              <div className="bars-labels">{months.map((m: any) => <span key={m.month}>{m.month.slice(5)}/{m.month.slice(2, 4)}</span>)}</div>
              <div className="row muted" style={{ fontSize: 12, marginTop: 8 }}>
                <span className="legend"><span className="item"><span className="sw" style={{ background: "var(--accent)" }} /> gastos <span className="sw" style={{ background: "var(--ok)", marginLeft: 10 }} /> receitas</span></span>
              </div>
              <h3 style={{ marginTop: 16 }}>Gastos por dia</h3>
              <div className="bars" style={{ height: 60 }}>
                {(data.daily ?? []).map((d: any) => <div key={d.day} className="bar" title={`dia ${d.day}: ${brl(d.expenses)}`} style={{ height: `${(Number(d.expenses ?? 0) / maxDay) * 100}%` }} />)}
              </div>
            </div>
          </div>

          <div className="card">
            <table className="table">
              <thead><tr><th>Quando</th><th>Descrição</th><th>Categoria</th>{isSuper && <th>Pessoa</th>}<th>Origem</th><th style={{ textAlign: "right" }}>Valor</th><th /></tr></thead>
              <tbody>
                {data.transactions.map((t: any) => (
                  <tr key={t.id}>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>{day(t.occurred_at)}</td>
                    <td>{t.description ?? t.merchant ?? "–"}{t.merchant && t.description ? <span className="muted"> · {t.merchant}</span> : null}</td>
                    <td><span className="chip">{t.category}</span></td>
                    {isSuper && <td>{t.user_name ?? `+${t.phone}`}</td>}
                    <td className="muted">{SOURCE[t.source] ?? t.source}</td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }} className={t.kind === "income" ? "amount-in" : "amount-out"}>{t.kind === "income" ? "+ " : "− "}{brl(t.amount)}</td>
                    <td><button className="btn btn-sm btn-ghost" title="Apagar" onClick={async () => { if (confirm("Apagar este lançamento?")) { await api(`/api/finance/${t.id}`, { method: "DELETE" }); void reload(); } }}>✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!data.transactions.length && <Empty>Nada lançado neste mês. No WhatsApp é só dizer "gastei 32 no almoço" ou mandar a foto do comprovante.</Empty>}
          </div>
        </>
      )}
      {adding && <AddTransaction user={user} onClose={() => { setAdding(false); void reload(); }} />}
    </div>
  );
}

function shift(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function AddTransaction({ user, onClose }: { user: string; onClose: () => void }) {
  const cats = useApi<string[]>("/api/finance/categories");
  const [f, setF] = useState({ kind: "expense", amount: "", category: "Alimentação", description: "", date: new Date().toISOString().slice(0, 10) });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title="Novo lançamento"
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={async () => {
          try {
            await api("/api/finance", { method: "POST", json: { ...f, user: user || undefined } });
            onClose();
          } catch (e) {
            setError((e as Error).message);
          }
        }}>Salvar</button>
      }
    >
      <div className="tabs">
        <button className={f.kind === "expense" ? "active" : ""} onClick={() => setF({ ...f, kind: "expense" })}>Gasto</button>
        <button className={f.kind === "income" ? "active" : ""} onClick={() => setF({ ...f, kind: "income" })}>Receita</button>
      </div>
      <div className="field"><label>Valor (R$)</label><input className="input" inputMode="decimal" placeholder="89,90" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus /></div>
      <div className="field"><label>Categoria</label>
        <select className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{(cats.data ?? []).map((c) => <option key={c}>{c}</option>)}</select>
      </div>
      <div className="field"><label>Descrição</label><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
      <div className="field"><label>Data</label><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
      <ErrorBox error={error} />
    </Modal>
  );
}

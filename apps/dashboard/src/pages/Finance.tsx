import { useState } from "react";
import { api, brl, day } from "../api";
import { CATEGORY_COLORS, Empty, ErrorBox, Loading, Modal } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

const SOURCE: Record<string, string> = { conversa: "conversa", audio: "áudio", comprovante: "comprovante", documento: "documento", painel: "painel" };

function thisMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const CAT_ICON: Record<string, string> = {
  Alimentação: "food",
  Mercado: "cart",
  Transporte: "car",
  Moradia: "home",
  Saúde: "heart",
  Educação: "book",
  Lazer: "ticket",
  Compras: "shop",
  Assinaturas: "repeat",
  Contas: "receipt",
  Viagem: "plane",
  Salário: "briefcase",
  Investimentos: "trend",
  Outros: "hash",
};
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const monthName = (m: string) => MONTHS[Number(m.slice(5)) - 1] ?? m;

function dayLabel(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Hoje";
  if (same(d, y)) return "Ontem";
  const s = d.toLocaleDateString("pt-BR", { weekday: "short", day: "numeric", month: "short" }).replace(/\./g, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function FinancePage({ isSuper }: { isSuper: boolean }) {
  const [month, setMonth] = useState(thisMonth());
  const [user, setUser] = useState("");
  const [adding, setAdding] = useState(false);
  const [cat, setCat] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [budget, setBudget] = useState<{ category: string | null; amount?: number } | null>(null);
  const people = useApi<any[]>(isSuper ? "/api/people" : null);
  const { data, error, reload } = useApi<any>(`/api/finance?month=${month}${user ? `&user=${user}` : ""}`, { poll: 20000 });

  const months = data?.months ?? [];
  const expenses = Number(data?.totals?.expenses ?? 0);
  const income = Number(data?.totals?.income ?? 0);
  const prevTotal = Number(months.find((m: any) => m.month === shift(month, -1))?.expenses ?? NaN);
  const diff = Number.isFinite(prevTotal) ? expenses - prevTotal : null;
  const prevCat = new Map<string, number>((data?.prevByCategory ?? []).map((c: any) => [c.category, Number(c.total)]));
  const cats = (data?.byCategory ?? []).map((c: any) => ({ label: c.category as string, value: Number(c.total), count: Number(c.count) }));
  const maxMonth = Math.max(1, ...months.map((m: any) => Number(m.expenses)));
  const maxDay = Math.max(1, ...(data?.daily ?? []).map((d: any) => Number(d.expenses ?? 0)));
  const list = (data?.transactions ?? []).filter((t: any) => !cat || t.category === cat);
  const groups: [string, any[]][] = [];
  for (const t of list) {
    const k = new Date(t.occurred_at).toDateString();
    const g = groups.find(([gk]) => gk === k);
    if (g) g[1].push(t);
    else groups.push([k, [t]]);
  }
  const isCurrent = month === thisMonth();
  const budgets: { id: string; category: string | null; limit: number; spent: number }[] = data?.budgets ?? [];
  const budgetOf = new Map(budgets.filter((b) => b.category).map((b) => [b.category!, b]));
  const canBudget = !isSuper || !!user;
  const go = (n: number) => { haptic(6); setCat(null); setMonth(shift(month, n)); };

  return (
    <div className="page fin-page">
      <div className="fin-top">
        <div className="fin-month">
          <button className="icon-btn" aria-label="Mês anterior" onClick={() => go(-1)}><Icon name="chevron-left" size={18} /></button>
          <strong>{monthName(month).replace(/^./, (c) => c.toUpperCase())} <span className="muted">{month.slice(0, 4)}</span></strong>
          <button className="icon-btn" aria-label="Próximo mês" disabled={isCurrent} onClick={() => go(1)}><Icon name="chevron-right" size={18} /></button>
        </div>
        <span className="spacer" />
        {isSuper && (
          <select className="select fin-person" value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">Todas as pessoas</option>
            {(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name ?? `+${p.phone}`}</option>)}
          </select>
        )}
        <button className="btn btn-primary" onClick={() => setAdding(true)} disabled={isSuper && !user} title={isSuper && !user ? "Escolha a pessoa primeiro" : undefined}>
          <Icon name="plus" size={16} /> <span className="hide-phone">Lançamento</span>
        </button>
      </div>
      <ErrorBox error={error} />
      {!data ? <Loading /> : (
        <>
          <div className="card fin-hero">
            <div className="muted">Gastos em {monthName(month)}</div>
            <div className="fin-total">{brl(expenses)}</div>
            {diff != null && (
              <div className={`fin-diff ${diff > 0 ? "up" : "down"}`}>
                <Icon name={diff > 0 ? "arrow-up" : "arrow-down"} size={14} />
                {brl(Math.abs(diff))} {diff > 0 ? "a mais" : "a menos"} que em {monthName(shift(month, -1))}
              </div>
            )}
            {cats.length > 0 && (
              <div className="fin-stack" aria-hidden="true">
                {cats.map((c: any, i: number) => (
                  <span key={c.label} style={{ flex: c.value, background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} title={`${c.label}: ${brl(c.value)}`} />
                ))}
              </div>
            )}
            <div className="fin-mini">
              <div><small className="muted">Receitas</small><strong className="amount-in">{brl(income)}</strong></div>
              <div><small className="muted">Saldo</small><strong style={{ color: income - expenses < 0 ? "var(--err)" : "var(--ok)" }}>{brl(income - expenses)}</strong></div>
              <div><small className="muted">Lançamentos</small><strong>{data.totals.count}</strong></div>
            </div>
          </div>

          {canBudget && (
            <>
              <div className="fin-section-head">
                <h3>Limites do mês</h3>
                <button className="btn btn-sm" onClick={() => setBudget({ category: budgets.some((b) => !b.category) ? (cats[0]?.label ?? "Alimentação") : null })}>
                  <Icon name="plus" size={14} /> Limite
                </button>
              </div>
              <div className="card card-pad" style={{ marginBottom: 18, paddingTop: 6, paddingBottom: 6 }}>
                {budgets.map((b) => {
                  const pct = b.limit ? b.spent / b.limit : 0;
                  return (
                    <div key={b.id} className="budget-row" onClick={() => setBudget({ category: b.category, amount: b.limit })}>
                      <span>{b.category ?? "Total do mês"}</span>
                      <small>{brl(b.spent)} de {brl(b.limit)} · {Math.round(pct * 100)}%</small>
                      <span className={`budget-bar ${pct >= 1 ? "over" : pct >= 0.8 ? "warn" : ""}`}><i style={{ width: `${Math.min(100, pct * 100)}%` }} /></span>
                    </div>
                  );
                })}
                {!budgets.length && (
                  <p className="muted" style={{ margin: "8px 0" }}>
                    Sem limites. Crie aqui ou diga no WhatsApp "meu limite de mercado é 800". Ele avisa ao chegar em 80% e quando estourar.
                  </p>
                )}
              </div>
            </>
          )}

          <div className="fin-section-head">
            <h3>Por categoria</h3>
            {cat && <button className="btn btn-sm btn-ghost" onClick={() => setCat(null)}><Icon name="x" size={14} /> {cat}</button>}
          </div>
          {cats.length ? (
            <div className="fin-cats">
              {cats.map((c: any, i: number) => {
                const prev = prevCat.get(c.label);
                const d = prev != null ? c.value - prev : null;
                return (
                  <button key={c.label} style={{ ["--c" as any]: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} className={`card fin-cat ${cat === c.label ? "active" : ""} ${cat && cat !== c.label ? "dim" : ""}`} onClick={() => { haptic(5); setCat(cat === c.label ? null : c.label); }}>
                    <span className="fin-cat-ico"><Icon name={CAT_ICON[c.label] ?? "hash"} size={18} /></span>
                    <span className="fin-cat-name">{c.label}</span>
                    <strong className="fin-cat-value">{brl(c.value)}</strong>
                    <span className="fin-cat-bar"><i style={{ width: `${expenses ? (c.value / expenses) * 100 : 0}%` }} /></span>
                    {budgetOf.get(c.label) && (
                      <span className={`fin-cat-limit ${c.value >= budgetOf.get(c.label)!.limit ? "over" : ""}`}>
                        {Math.round((c.value / budgetOf.get(c.label)!.limit) * 100)}% do limite de {brl(budgetOf.get(c.label)!.limit)}
                      </span>
                    )}
                    <small className="muted">
                      {expenses ? Math.round((c.value / expenses) * 100) : 0}% · {c.count} {c.count === 1 ? "gasto" : "gastos"}
                      {d != null && Math.abs(d) >= 1 && <span className={d > 0 ? "trend-up" : "trend-down"}> · {d > 0 ? "+" : "−"}{brl(Math.abs(d))}</span>}
                    </small>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="card"><Empty>Sem gastos em {monthName(month)}. No WhatsApp é só dizer "gastei 32 no almoço" ou mandar a foto do comprovante.</Empty></div>
          )}

          <div className="fin-grid">
            <div>
              <div className="fin-section-head"><h3>{cat ? `Lançamentos em ${cat}` : "Lançamentos"}</h3></div>
              <div className="card fin-list">
                {groups.map(([k, items]) => {
                  const total = items.filter((t) => t.kind === "expense").reduce((a, t) => a + Number(t.amount), 0);
                  return (
                    <div key={k}>
                      <div className="fin-day"><span>{dayLabel(items[0].occurred_at)}</span>{total > 0 && <span>{brl(total)}</span>}</div>
                      {items.map((t: any) => (
                        <button key={t.id} className="fin-tx" onClick={() => setDetail(t)}>
                          <span className="fin-tx-ico"><Icon name={t.kind === "income" ? "arrow-down" : CAT_ICON[t.category] ?? "hash"} size={16} /></span>
                          <span className="fin-tx-text">
                            <span className="ellipsis">{t.description ?? t.merchant ?? t.category}</span>
                            <small className="muted ellipsis">{t.category}{t.merchant && t.description ? ` · ${t.merchant}` : ""}{isSuper ? ` · ${t.user_name ?? `+${t.phone}`}` : ""}</small>
                          </span>
                          <strong className={t.kind === "income" ? "amount-in" : ""}>{t.kind === "income" ? "+" : "−"}{brl(t.amount)}</strong>
                        </button>
                      ))}
                    </div>
                  );
                })}
                {!list.length && <Empty>Nada lançado {cat ? `em ${cat} ` : ""}neste mês.</Empty>}
              </div>
            </div>
            <div>
              <div className="fin-section-head"><h3>Últimos meses</h3></div>
              <div className="card card-pad">
                <div className="fin-months">
                  {months.map((m: any) => (
                    <button key={m.month} className={m.month === month ? "active" : ""} onClick={() => { haptic(5); setCat(null); setMonth(m.month); }} title={`${m.month}: ${brl(m.expenses)}`}>
                      <span className="fin-month-bar"><i style={{ height: `${(Number(m.expenses) / maxMonth) * 100}%` }} /></span>
                      <small>{monthName(m.month).slice(0, 3)}</small>
                    </button>
                  ))}
                </div>
                <h3 style={{ marginTop: 18 }}>Dia a dia</h3>
                <div className="bars" style={{ height: 56 }}>
                  {(data.daily ?? []).map((d: any) => <div key={d.day} className="bar" title={`dia ${d.day}: ${brl(d.expenses)}`} style={{ height: `${(Number(d.expenses ?? 0) / maxDay) * 100}%` }} />)}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
      {budget && <BudgetModal user={user} initial={budget} onClose={() => { setBudget(null); void reload(); }} />}
      {adding && <AddTransaction user={user} onClose={() => { setAdding(false); void reload(); }} />}
      {detail && (
        <Modal
          title={detail.kind === "income" ? "Receita" : "Gasto"}
          icon={<Icon name={CAT_ICON[detail.category] ?? "wallet"} />}
          onClose={() => setDetail(null)}
          footer={
            <button className="btn btn-danger" onClick={async () => { if (confirm("Apagar este lançamento?")) { await api(`/api/finance/${detail.id}`, { method: "DELETE" }); setDetail(null); void reload(); } }}>
              <Icon name="trash" size={16} /> Apagar
            </button>
          }
        >
          <div className="fin-total" style={{ marginBottom: 12 }}>{detail.kind === "income" ? "+" : "−"}{brl(detail.amount)}</div>
          <dl className="kv">
            <dt>Descrição</dt><dd>{detail.description ?? "–"}</dd>
            {detail.merchant && (<><dt>Onde</dt><dd>{detail.merchant}</dd></>)}
            <dt>Categoria</dt><dd>{detail.category}</dd>
            <dt>Quando</dt><dd>{day(detail.occurred_at)}</dd>
            <dt>Origem</dt><dd>{SOURCE[detail.source] ?? detail.source}</dd>
            {isSuper && (<><dt>Pessoa</dt><dd>{detail.user_name ?? `+${detail.phone}`}</dd></>)}
          </dl>
        </Modal>
      )}
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
  const [f, setF] = useState({ kind: "expense", amount: "", category: "", description: "", date: new Date().toISOString().slice(0, 10) });
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
        <select className="select" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          <option value="">Automática (pela descrição)</option>
          {(cats.data ?? []).map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>
      <div className="field"><label>Descrição</label><input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
      <div className="field"><label>Data</label><input className="input" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></div>
      <ErrorBox error={error} />
    </Modal>
  );
}

function BudgetModal({ user, initial, onClose }: { user: string; initial: { category: string | null; amount?: number }; onClose: () => void }) {
  const cats = useApi<string[]>("/api/finance/categories");
  const [category, setCategory] = useState(initial.category ?? "");
  const [amount, setAmount] = useState(initial.amount ? String(initial.amount).replace(".", ",") : "");
  const [error, setError] = useState<string | null>(null);
  const save = async (value: string) => {
    try {
      await api("/api/budgets", { method: "PUT", json: { category: category || null, amount: value, user: user || undefined } });
      haptic(8);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal
      title={initial.amount ? "Editar limite" : "Novo limite"}
      icon={<Icon name="target" />}
      onClose={onClose}
      footer={
        <>
          {initial.amount != null && <button className="btn btn-danger" onClick={() => save("0")}><Icon name="trash" size={16} /> Remover</button>}
          <button className="btn btn-primary" onClick={() => save(amount)}>Salvar</button>
        </>
      }
    >
      <div className="field"><label>Para</label>
        <select className="select" value={category} disabled={initial.amount != null} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Total do mês</option>
          {(cats.data ?? []).filter((c) => c !== "Salário" && c !== "Investimentos").map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="field"><label>Limite por mês (R$)</label><input className="input" inputMode="decimal" placeholder="800" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></div>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>O assistente avisa no WhatsApp quando chegar em 80% e quando passar do limite.</p>
      <ErrorBox error={error} />
    </Modal>
  );
}

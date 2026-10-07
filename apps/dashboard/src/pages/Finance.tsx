import { useState } from "react";
import { api, brl, day } from "../api";
import { CATEGORY_COLORS, Donut, Empty, ErrorBox, Loading, Modal } from "../components";
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
  const [budget, setBudget] = useState<{ category: string | null; amount?: number; user?: string } | null>(null);
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
  const daysIn = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  const byDay = new Map<number, number>((data?.daily ?? []).map((d: any) => [Number(d.day), Number(d.expenses ?? 0)]));
  const days = Array.from({ length: daysIn }, (_, i) => ({ day: i + 1, expenses: byDay.get(i + 1) ?? 0 }));
  const maxDay = Math.max(1, ...days.map((d) => d.expenses));
  const list = (data?.transactions ?? []).filter((t: any) => !cat || t.category === cat);
  const groups: [string, any[]][] = [];
  for (const t of list) {
    const k = new Date(t.occurred_at).toDateString();
    const g = groups.find(([gk]) => gk === k);
    if (g) g[1].push(t);
    else groups.push([k, [t]]);
  }
  const isCurrent = month === thisMonth();
  const budgets: { id: string; user_id?: string; user_name?: string; category: string | null; limit: number; spent: number }[] = data?.budgets ?? [];
  const everyone = isSuper && !user;
  const budgetOf = new Map(everyone ? [] : budgets.filter((b) => b.category).map((b) => [b.category!, b]));
  const go = (n: number) => { haptic(6); setCat(null); setMonth(shift(month, n)); };

  const [tab, setTab] = useState<"overview" | "list">("overview");
  const totalBudget = everyone ? undefined : budgets.find((b) => !b.category);
  const today = new Date();
  const elapsed = isCurrent ? today.getDate() : daysIn;
  const reminders = useApi<{ events: any[] }>(
    `/api/calendar?from=${new Date(today.getFullYear(), today.getMonth(), today.getDate()).toISOString()}&to=${new Date(today.getFullYear(), today.getMonth(), today.getDate() + 14).toISOString()}${user ? `&user=${user}` : ""}`,
  );
  const upcoming = (reminders.data?.events ?? []).filter((e) => e.kind === "reminder").slice(0, 4);
  const periodLabel = `1 - ${daysIn} de ${monthName(month).slice(0, 3)}, ${month.slice(0, 4)}`;
  const insight = buildInsight(cats, expenses, prevCat, budgets, monthName(month));

  return (
    <div className="page fin-page">
      <div className="fin-top">
        <div className="fin-tabs">
          <button className={tab === "overview" ? "active" : ""} onClick={() => { haptic(5); setTab("overview"); }}><Icon name="layout" size={16} /> Visão geral</button>
          <button className={tab === "list" ? "active" : ""} onClick={() => { haptic(5); setTab("list"); }}><Icon name="receipt" size={16} /> Lançamentos</button>
        </div>
        <span className="muted hide-phone fin-month-label">{cap(monthName(month))} de {month.slice(0, 4)}</span>
        <span className="spacer" />
        <div className="fin-period">
          <button className="icon-btn round" aria-label="Mês anterior" onClick={() => go(-1)}><Icon name="chevron-left" size={16} /></button>
          <span className="fin-range"><Icon name="calendar" size={15} /> {periodLabel}</span>
          <button className="icon-btn round" aria-label="Próximo mês" disabled={isCurrent} onClick={() => go(1)}><Icon name="chevron-right" size={16} /></button>
        </div>
        {isSuper && (
          <div className="fin-people">
            <button className={!user ? "active" : ""} onClick={() => setUser("")}>Todos</button>
            {(people.data ?? []).map((p) => (
              <button key={p.id} className={user === p.id ? "active" : ""} onClick={() => { haptic(5); setUser(p.id); }}>{(p.name ?? `+${p.phone}`).split(" ")[0]}</button>
            ))}
          </div>
        )}
        <button className="btn btn-brand fin-add" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> <span className="hide-phone">Lançamento</span>
        </button>
      </div>
      <ErrorBox error={error} />
      {!data ? <Loading /> : tab === "overview" ? (
        <>
          <div className="card fin-kpis">
            <div><small>Entradas</small><strong className="pos">{brl(income)}</strong><span>no período</span></div>
            <div><small>Saídas</small><strong className="neg">{brl(expenses)}</strong><span>{income ? `${Math.round((expenses / income) * 100)}% das entradas` : diff != null ? `${diff > 0 ? "+" : "−"}${brl(Math.abs(diff))} vs ${monthName(shift(month, -1)).slice(0, 3)}` : "no período"}</span></div>
            <div><small>Saldo</small><strong className={income - expenses < 0 ? "neg" : ""}>{brl(income - expenses)}</strong><span>{income - expenses < 0 ? "negativo" : "positivo"}</span></div>
            {totalBudget ? (
              <div><small>Limite do mês</small><strong className={totalBudget.spent > totalBudget.limit ? "neg" : ""}>{brl(Math.max(0, totalBudget.limit - totalBudget.spent))}</strong><span>restante de {brl(totalBudget.limit)}</span></div>
            ) : (
              <div><small>Média por dia</small><strong>{brl(expenses / Math.max(1, elapsed))}</strong><span>{data.totals.count} lançamentos</span></div>
            )}
          </div>

          <div className="fin-overview">
            <div className="fin-col">
              <div className="card fin-insight">
                <div className="fin-card-head">
                  <h3>Insight do mês</h3>
                  <span className="chip-mini">automático</span>
                  <span className="spacer" />
                  <button className="icon-btn" aria-label="Atualizar" onClick={() => void reload()}><Icon name="refresh" size={15} /></button>
                </div>
                <small className="muted">{cap(today.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" }))}</small>
                <p className="fin-insight-text">{insight}</p>
                {cats[0] && (
                  <>
                    <div className="fin-insight-meta">
                      <span className="fin-pill" style={{ ["--c" as any]: CATEGORY_COLORS[0] }}><Icon name={CAT_ICON[cats[0].label] ?? "hash"} size={13} /> {cats[0].label}</span>
                      <strong>{brl(cats[0].value)}</strong> <span className="muted">gasto</span>
                      <strong>{expenses ? ((cats[0].value / expenses) * 100).toFixed(1).replace(".", ",") : 0}%</strong> <span className="muted">do total</span>
                    </div>
                    <div className="fin-insight-bar"><i style={{ width: `${expenses ? (cats[0].value / expenses) * 100 : 0}%` }} /></div>
                  </>
                )}
              </div>

              <div className="card fin-donut-card">
                <div className="fin-card-head">
                  <span className="tone-ico" style={{ ["--c" as any]: "var(--brand-3)" }}><Icon name="target" size={15} /></span>
                  <div>
                    <h3>Gastos por categoria</h3>
                    <small className="muted">Toque numa categoria para ver os lançamentos</small>
                  </div>
                </div>
                {cats.length ? (
                  <div className="fin-donut">
                    <Donut items={cats} size={150} center={<div><small className="muted">Total</small><div style={{ fontWeight: 700, fontSize: 13 }}>{brl(expenses)}</div></div>} />
                    <div className="fin-legend">
                      {cats.map((c: any, i: number) => {
                        const b = budgetOf.get(c.label);
                        return (
                          <button key={c.label} style={{ ["--c" as any]: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} onClick={() => { haptic(5); setCat(c.label); setTab("list"); }}>
                            <span className="dot" />
                            <span className="name">{c.label}</span>
                            <span className="muted val">{brl(c.value)}</span>
                            <strong>{expenses ? Math.round((c.value / expenses) * 100) : 0}%</strong>
                            <span className="bar"><i style={{ width: `${expenses ? (c.value / expenses) * 100 : 0}%` }} /></span>
                            {b && <small className={`lim ${c.value >= b.limit ? "over" : ""}`}>{Math.round((c.value / b.limit) * 100)}% do limite de {brl(b.limit)}</small>}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <Empty>Sem gastos em {monthName(month)}. No WhatsApp é só dizer "gastei 32 no almoço" ou mandar a foto do comprovante.</Empty>
                )}
              </div>

              <div className="card card-pad">
                <div className="fin-card-head"><h3>Últimos meses</h3></div>
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
                  {days.map((d) => <div key={d.day} className={`bar ${d.expenses ? "spent" : ""}`} title={`dia ${d.day}: ${brl(d.expenses)}`} style={{ height: `${(d.expenses / maxDay) * 100}%` }} />)}
                </div>
              </div>
            </div>

            <div className="fin-col">
              <div className="card fin-side-card">
                <div className="fin-card-head">
                  <span className="tone-ico" style={{ ["--c" as any]: "var(--brand-2)" }}><Icon name="target" size={15} /></span>
                  <h3>Limites do mês</h3>
                  <span className="spacer" />
                  <button className="link-btn" onClick={() => setBudget({ category: !everyone && budgets.some((b) => !b.category) ? (cats[0]?.label ?? "Alimentação") : null, user: user || undefined })}>Novo limite <Icon name="chevron-right" size={13} /></button>
                </div>
                {budgets.map((b) => {
                  const pct = b.limit ? b.spent / b.limit : 0;
                  return (
                    <div key={b.id} className="budget-row" onClick={() => setBudget({ category: b.category, amount: b.limit, user: b.user_id ?? (user || undefined) })}>
                      <span>{b.category ?? "Total do mês"}{everyone && b.user_name ? <span className="muted"> · {b.user_name}</span> : null}</span>
                      <small>{brl(b.spent)} de {brl(b.limit)} · {Math.round(pct * 100)}%</small>
                      <span className={`budget-bar ${pct >= 1 ? "over" : pct >= 0.8 ? "warn" : ""}`}><i style={{ width: `${Math.min(100, pct * 100)}%` }} /></span>
                    </div>
                  );
                })}
                {!budgets.length && (
                  <div className="fin-empty-side">
                    <p className="muted">Nenhum limite ainda. Ele avisa no WhatsApp ao chegar em 80% e quando estourar.</p>
                    <button className="btn btn-brand btn-sm" onClick={() => setBudget({ category: null, user: user || undefined })}><Icon name="plus" size={14} /> Criar limite</button>
                  </div>
                )}
              </div>

              <div className="card fin-side-card">
                <div className="fin-card-head">
                  <span className="tone-ico" style={{ ["--c" as any]: "var(--brand-4)" }}><Icon name="bell" size={15} /></span>
                  <h3>Próximos lembretes</h3>
                </div>
                {upcoming.map((e) => (
                  <div key={e.id} className="fin-rem">
                    <span className="fin-rem-date"><strong>{new Date(e.start).getDate()}</strong><small>{monthName(new Date(e.start).toISOString().slice(0, 7)).slice(0, 3)}</small></span>
                    <span className="ellipsis" style={{ flex: 1 }}>{e.title}</span>
                    <small className="muted">{new Date(e.start).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}</small>
                  </div>
                ))}
                {reminders.data && !upcoming.length && <p className="muted fin-empty-side">Nenhum lembrete nos próximos 14 dias.</p>}
              </div>
            </div>
          </div>
        </>
      ) : (
        <>
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
                    <small className="muted">
                      {expenses ? Math.round((c.value / expenses) * 100) : 0}% · {c.count} {c.count === 1 ? "gasto" : "gastos"}
                      {d != null && Math.abs(d) >= 1 && <span className={d > 0 ? "trend-up" : "trend-down"}> · {d > 0 ? "+" : "−"}{brl(Math.abs(d))}</span>}
                    </small>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="card"><Empty>Sem gastos em {monthName(month)}.</Empty></div>
          )}
          <div className="fin-section-head"><h3>{cat ? `Lançamentos em ${cat}` : "Lançamentos"}</h3></div>
          <div className="card fin-list">
            {groups.map(([k, items]) => {
              const total = items.filter((t) => t.kind === "expense").reduce((a, t) => a + Number(t.amount), 0);
              return (
                <div key={k}>
                  <div className="fin-day"><span>{dayLabel(items[0].occurred_at)}</span>{total > 0 && <span>{brl(total)}</span>}</div>
                  {items.map((t: any) => (
                    <button key={t.id} className="fin-tx" onClick={() => setDetail(t)}>
                      <span className="fin-tx-ico" style={{ ["--c" as any]: CATEGORY_COLORS[Math.max(0, cats.findIndex((c: any) => c.label === t.category)) % CATEGORY_COLORS.length] }}><Icon name={t.kind === "income" ? "arrow-down" : CAT_ICON[t.category] ?? "hash"} size={16} /></span>
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
        </>
      )}
      {budget && <BudgetModal user={budget.user ?? user} people={isSuper ? people.data ?? [] : null} initial={budget} onClose={() => { setBudget(null); void reload(); }} />}
      {adding && <AddTransaction user={user} people={isSuper ? people.data ?? [] : null} onClose={() => { setAdding(false); void reload(); }} />}
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

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Insight sem IA (não gasta token): maior categoria, comparação com o mês anterior e limites perto do fim. */
function buildInsight(cats: { label: string; value: number }[], total: number, prev: Map<string, number>, budgets: { category: string | null; limit: number; spent: number; user_name?: string }[], month: string) {
  if (!cats.length) return `Nenhum gasto em ${month} ainda. Mande no WhatsApp o que gastou e eu organizo por categoria.`;
  const top = cats[0]!;
  const pct = Math.round((top.value / Math.max(total, 1)) * 100);
  const parts = [pct >= 99 ? `Todo o gasto de ${month} foi com ${top.label}.` : `${top.label} é ${pct}% dos seus gastos em ${month}.`];
  const before = prev.get(top.label);
  if (before != null && Math.abs(top.value - before) >= 1)
    parts.push(top.value > before ? `São ${brl(top.value - before)} a mais que no mês passado.` : `São ${brl(before - top.value)} a menos que no mês passado.`);
  const hot = budgets.filter((b) => b.limit && b.spent / b.limit >= 0.8).sort((a, b) => b.spent / b.limit - a.spent / a.limit)[0];
  if (hot) parts.push(`${hot.category ?? "O total do mês"} já está em ${Math.round((hot.spent / hot.limit) * 100)}% do limite${hot.user_name ? ` (${hot.user_name})` : ""}.`);
  else if (cats.length > 1) parts.push(`Depois vem ${cats[1]!.label}, com ${brl(cats[1]!.value)}.`);
  return parts.join(" ");
}

function shift(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function AddTransaction({ user: preset, people, onClose }: { user: string; people: any[] | null; onClose: () => void }) {
  const [user, setUser] = useState(preset);
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
      {people && !preset && (
        <div className="field"><label>Pessoa</label>
          <select className="select" value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">Escolha</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name ?? p.name ?? `+${p.phone}`}</option>)}
          </select>
        </div>
      )}
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

function BudgetModal({ user: preset, people, initial, onClose }: { user: string; people: any[] | null; initial: { category: string | null; amount?: number }; onClose: () => void }) {
  const cats = useApi<string[]>("/api/finance/categories");
  const [user, setUser] = useState(preset);
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
          <button className="btn btn-primary" disabled={!!people && !user} onClick={() => save(amount)}>Salvar</button>
        </>
      }
    >
      {people && !preset && (
        <div className="field"><label>Pessoa</label>
          <select className="select" value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">Escolha</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name ?? p.name ?? `+${p.phone}`}</option>)}
          </select>
        </div>
      )}
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

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, brl, day } from "../api";
import { Donut, Empty, ErrorBox, Loading, Modal, PageHead, alertDialog, confirmDialog } from "../components";
import { useApi, useMedia } from "../hooks";
import { Vazio } from "../Vazio";
import { Icon } from "../icons";
import { DateField, isoDate, SelectField } from "../pickers";
import { useLongPress } from "../ios";
import { haptic } from "../touch";
import { ReportModal } from "./FinanceReport";
import { GoalsCard } from "./FinanceGoals";
import { CategoriesModal, useCategories } from "./FinanceCategories";
import { CardsTab, InvoicesCard, invoiceMonthFor, invoiceMonthLabel, useCards, type CreditCard } from "./FinanceCards";
import { MonthJump } from "./CalendarPhone";
import { FinanceCalendar } from "./FinanceCalendar";
import "../styles/financas-celular.css";

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
/** Valor curto para onde o espaço é fixo (miolo da rosca): R$ 1,2 mi em vez de R$ 1.234.567,89. */
const brlShort = (v: number) => (Math.abs(v) < 100000 ? brl(v) : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 }).format(v));
/** Valor que nunca é cortado: acima de R$ 99.999,99 ganha a classe "long" (fonte menor). */
const longMoney = (v: number) => (brl(v).length > 12 ? " long" : "");
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

export function FinancePage() {
  const [month, setMonth] = useState(thisMonth());
  const [user, setUser] = useState(() => {
    try {
      return sessionStorage.getItem("pj-origin-finance") ?? "";
    } catch {
      return "";
    }
  });

  const changeUser = (u: string) => {
    setUser(u);
    try {
      sessionStorage.setItem("pj-origin-finance", u);
    } catch {
      /* sem storage */
    }
  };
  const [adding, setAdding] = useState(false);
  const [report, setReport] = useState(false);
  const [cat, setCat] = useState<string | null>(null);
  const [detail, setDetail] = useState<any | null>(null);
  const [editing, setEditing] = useState<any | null>(null);
  const [budget, setBudget] = useState<{ category: string | null; amount?: number } | null>(null);
  // particular: cada um vê as suas; as de um contato só se ele compartilhou (só leitura)
  const shared = useApi<{ withMe: { id: string; name: string; scopes: string[] }[] }>("/api/shares");
  const owners = (shared.data?.withMe ?? []).filter((p) => p.scopes.includes("finance"));
  const { data, error, reload } = useApi<any>(`/api/finance?month=${month}${user ? `&user=${user}` : ""}`, { poll: 20000, live: ["transactions", "budgets", "finance_categories", "finance_goals", "bills", "cards"] });
  const categories = useCategories(user);
  const colorOf = categories.colorOf;
  const [managing, setManaging] = useState(false);

  const months = data?.months ?? [];
  const expenses = Number(data?.totals?.expenses ?? 0);
  const income = Number(data?.totals?.income ?? 0);
  const prevCat = new Map<string, number>((data?.prevByCategory ?? []).map((c: any) => [c.category, Number(c.total)]));
  const cats = (data?.byCategory ?? []).map((c: any, i: number) => ({ label: c.category as string, value: Number(c.total), count: Number(c.count), color: colorOf(c.category, i) }));
  const daysIn = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
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
  const readonly = Boolean(data?.readonly);
  // primeiro acesso: nada lançado nos últimos meses e nenhum limite (as Finanças de um contato nunca contam)
  const novo = Boolean(data && !readonly && !user && !months.length && !budgets.length);
  // finanças de um contato: só para ver
  const openBudget = (b: { category: string | null; amount?: number }) => { if (!readonly) setBudget(b); };
  const remove = async (t: any) => {
    const what = `${t.kind === "income" ? "+" : "−"}${brl(t.amount)}${t.description ? ` · ${t.description}` : ""}`;
    if (!(await confirmDialog({ title: "Apagar este lançamento?", body: `${what}. Ele sai dos totais do mês e não dá para recuperar.`, confirmLabel: "Apagar", danger: true }))) return;
    try {
      await api(`/api/finance/${t.id}`, { method: "DELETE" });
      setDetail(null);
      void reload();
    } catch (e) {
      void alertDialog("Não deu para apagar", (e as Error).message);
    }
  };
  // segurar o lançamento: Editar ou Apagar sem abrir o detalhe
  const find = (el: HTMLElement) => list.find((t: any) => String(t.id) === el.dataset.id);
  const press = useLongPress(
    (el) => {
      const t = find(el);
      if (!t || readonly) return [];
      return [
        { label: "Editar", icon: "edit", onSelect: () => setEditing(t) },
        { label: "Apagar", icon: "trash", danger: true, onSelect: () => void remove(t) },
      ];
    },
    (el) => { const t = find(el); return t ? `${t.kind === "income" ? "+" : "−"}${brl(t.amount)} · ${t.description ?? t.merchant ?? t.category}` : undefined; },
  );
  const budgetOf = new Map(budgets.filter((b) => b.category).map((b) => [b.category!, b]));
  const go = (n: number) => { haptic(6); setCat(null); setMonth(shift(month, n)); };

  const [tab, setTab] = useState<"overview" | "list" | "cards">("overview");
  const [focusCard, setFocusCard] = useState<string | null>(null);
  const openCards = (id?: string) => { haptic(5); setFocusCard(id ?? null); setTab("cards"); };

  // celular: no jeito da Agenda (abas com sublinhado, mês grande, conteúdo que desliza para o lado certo)
  const phone = useMedia("(max-width: 767px)");
  const [jump, setJump] = useState(false);
  const tabsEl = useRef<HTMLDivElement>(null);
  const bodyEl = useRef<HTMLDivElement>(null);
  const lastTab = useRef(tab);
  const tabDir = useRef("");
  if (lastTab.current !== tab) {
    tabDir.current = TAB_ORDER.indexOf(tab) > TAB_ORDER.indexOf(lastTab.current) ? "right" : "left";
    lastTab.current = tab;
  }
  const lastMonth = useRef(month);
  const monthDir = useRef("");
  if (lastMonth.current !== month) {
    monthDir.current = month < lastMonth.current ? "down" : "";
    lastMonth.current = month;
  }
  useEffect(() => {
    if (!phone) return;
    document.documentElement.classList.add("pj-fin");
    return () => document.documentElement.classList.remove("pj-fin");
  }, [phone]);
  useLayoutEffect(() => {
    const on = tabsEl.current?.querySelector<HTMLElement>("button.on");
    if (!on || !tabsEl.current) return;
    tabsEl.current.style.setProperty("--x", `${on.offsetLeft + on.offsetWidth * 0.22}px`);
    tabsEl.current.style.setProperty("--w", `${on.offsetWidth * 0.56}px`);
  }, [tab, phone]);
  // trocou o mês: quando os números novos chegam, entram do lado de onde o mês veio
  const shownMonth = useRef(month);
  useEffect(() => {
    if (!data || shownMonth.current === month) return;
    const dir = month > shownMonth.current ? 1 : -1;
    shownMonth.current = month;
    if (!phone || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    bodyEl.current?.animate([{ opacity: 0, transform: `translateX(${dir * 26}px)` }, { opacity: 1, transform: "none" }], { duration: 400, easing: "cubic-bezier(.32,.72,0,1)" });
  }, [data, month, phone]);
  const pickTab = (t: typeof tab) => { if (t === tab) return; haptic(5); setTab(t); };
  const now = new Date();
  const monthTitle = `${monthName(month)}${month.slice(0, 4) !== String(now.getFullYear()) ? ` ${month.slice(0, 4)}` : ""}`;
  const totalBudget = budgets.find((b) => !b.category);
  const today = new Date();
  const periodLabel = `1 - ${daysIn} de ${monthName(month).slice(0, 3)}, ${month.slice(0, 4)}`;
  // atalho grande para as categorias: no celular logo abaixo dos totais, no notebook no pé do card da rosca
  const CategoriesBar = ({ className }: { className: string }) => (
    <button className={`fin-cats-bar ${className}`} onClick={() => { haptic(5); setManaging(true); }}>
      <span className="fin-cats-dots" aria-hidden>{categories.list.slice(0, 5).map((c) => <i key={c.id} style={{ background: c.color }} />)}</span>
      <span className="fin-cats-bar-text"><strong>Suas categorias</strong><small className="muted">Criar, renomear, trocar a cor e ensinar palavras</small></span>
      <Icon name="chevron-right" size={16} />
    </button>
  );
  const txRow = (t: any) => (
    <button key={t.id} className="fin-tx" data-id={t.id} onClick={() => setDetail(t)} {...press}>
      <span className="fin-tx-ico" style={{ ["--c" as any]: colorOf(t.category, Math.max(0, cats.findIndex((c: any) => c.label === t.category))) }}><Icon name={t.kind === "income" ? "arrow-down" : CAT_ICON[t.category] ?? "hash"} size={16} /></span>
      <span className="fin-tx-text">
        <span className="ellipsis">{t.description ?? t.merchant ?? t.category}</span>
        <small className="muted ellipsis">
          {user === "all" && t.user_name && <span className="chip-mini" style={{ marginRight: 4 }}>{t.user_name.trim().split(" ")[0]}</span>}
          {t.card_name && <span className="fin-tx-card"><span className={`cc-mini c-${t.card_color ?? "preto"}`} aria-hidden />{t.card_name}{t.installments ? ` ${t.installment}/${t.installments}` : ""} · </span>}
          {t.category}{t.merchant && t.description ? ` · ${t.merchant}` : ""}
        </small>
      </span>
      <strong className={t.kind === "income" ? "amount-in" : ""}>{t.kind === "income" ? "+" : "−"}{brl(t.amount)}</strong>
    </button>
  );

  return (
    <div className="page fin-page fit">
      <div className="hide-phone">
        <PageHead
          title="Finanças"
          subtitle={`${cap(monthName(month))} de ${month.slice(0, 4)}${user ? `, de ${owners.find((p) => p.id === user)?.name ?? ""} (só para ver)` : ""}`}
          actions={<><button className="btn" onClick={() => setReport(true)}><Icon name="file" size={16} /> Relatório PDF</button>{!readonly && <button className="btn btn-brand" onClick={() => setAdding(true)}><Icon name="plus" size={16} /> Lançamento</button>}</>}
        />
      </div>
      <div className="fin-top">
        <div className="fin-tabs">
          <button className={tab === "overview" ? "active" : ""} onClick={() => { haptic(5); setTab("overview"); }}><Icon name="layout" size={16} /> Visão geral</button>
          <button className={tab === "list" ? "active" : ""} onClick={() => { haptic(5); setTab("list"); }}><Icon name="receipt" size={16} /> Lançamentos</button>
          <button className={tab === "cards" ? "active" : ""} onClick={() => { haptic(5); setTab("cards"); }}><Icon name="card" size={16} /> Cartões</button>
        </div>
        <span className="spacer" />
        {tab !== "cards" && (
        <div className="fin-period">
          <button className="icon-btn round" aria-label="Mês anterior" onClick={() => go(-1)}><Icon name="chevron-left" size={16} /></button>
          <span className="fin-range"><Icon name="calendar" size={15} /> <span className="fin-range-t">{periodLabel}</span></span>
          <button className="icon-btn round" aria-label="Próximo mês" disabled={isCurrent} onClick={() => go(1)}><Icon name="chevron-right" size={16} /></button>
        </div>
        )}
        {owners.length > 0 && (
          <div className="fin-people">
            <button className={!user ? "active" : ""} onClick={() => { haptic(5); changeUser(""); }}>Minhas</button>
            <button className={user === "all" ? "active" : ""} onClick={() => { haptic(5); changeUser("all"); }}>{owners.length === 1 ? "Os dois" : "Todos"}</button>
            {owners.map((p) => (
              <button key={p.id} className={user === p.id ? "active" : ""} title={p.name} onClick={() => { haptic(5); changeUser(p.id); }}>{p.name.trim().split(" ")[0]}</button>
            ))}
          </div>
        )}
        {tab !== "cards" && (
          <button className="icon-btn fin-report-btn phone-only" aria-label="Relatório em PDF" onClick={() => { haptic(8); setReport(true); }}>
            <Icon name="file" size={18} />
          </button>
        )}
        {!readonly && tab !== "cards" && (
          <button className="btn btn-brand fin-add phone-only" aria-label="Novo lançamento" onClick={() => setAdding(true)}>
            <Icon name="plus" size={18} />
          </button>
        )}
      </div>
      {phone && (
        <header className="fp-head">
          <div className="pc-row">
            <div ref={tabsEl} className="pc-tabs fp-tabs" role="tablist" aria-label="Finanças">
              {TAB_ORDER.map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => pickTab(t)}>{TAB_LABEL[t]}</button>
              ))}
              <i className="pc-tab-line" aria-hidden="true" />
            </div>
            <span className="spacer" />
            {tab !== "cards" && (
              <button className="pc-ico" aria-label="Relatório em PDF" onClick={() => { haptic(8); setReport(true); }}>
                <Icon name="file" size={21} />
              </button>
            )}
          </div>
          {tab !== "cards" && (
            <div className="pc-row pc-row-2">
              <button className="pc-title" aria-label={`${monthTitle}: escolher outro mês`} onClick={() => { haptic(5); setJump(true); }}>
                <span key={month} className={`pc-title-txt ${monthDir.current}`}>{monthTitle}</span>
                <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9l7 7 7-7z" fill="currentColor" /></svg>
              </button>
              <span className="spacer" />
              <button className="pc-ico sm fp-arrow" aria-label="Mês anterior" onClick={() => go(-1)}><Icon name="chevron-left" size={18} /></button>
              {isCurrent ? (
                <button className="pc-ico sm fp-arrow" aria-label="Próximo mês" disabled><Icon name="chevron-right" size={18} /></button>
              ) : (
                <button className="pc-today fp-now" onClick={() => { haptic(5); setCat(null); setMonth(thisMonth()); }}>Este mês</button>
              )}
            </div>
          )}
          {owners.length > 0 && (
            <div className="fp-people">
              <button className={!user ? "on" : ""} onClick={() => { haptic(5); changeUser(""); }}>Minhas</button>
              <button className={user === "all" ? "on" : ""} onClick={() => { haptic(5); changeUser("all"); }}>{owners.length === 1 ? "Os dois" : "Todos"}</button>
              {owners.map((p) => (
                <button key={p.id} className={user === p.id ? "on" : ""} title={p.name} onClick={() => { haptic(5); changeUser(p.id); }}>{p.name.trim().split(" ")[0]}</button>
              ))}
            </div>
          )}
        </header>
      )}
      <ErrorBox error={error} />
      <div ref={bodyEl} key={phone ? tab : "body"} className={`fp-body ${tabDir.current}`}>
      {tab === "cards" ? (
        <CardsTab user={user} readonly={readonly} focus={focusCard} onChanged={() => void reload()} />
      ) : !data ? <Loading /> : novo ? (
        <Vazio
          img="financas"
          title="Seu dinheiro, sem planilha"
          text="Anote gastos e entradas e veja para onde vai cada real, com limite por categoria e as faturas dos cartões. Dá para mandar a foto do comprovante no WhatsApp que ele lança sozinho."
          actions={[
            { label: "Anotar um gasto", icon: "plus", onClick: () => setAdding(true) },
            { label: "Cadastrar um cartão", icon: "card", onClick: () => setTab("cards") },
          ]}
          tip="Ou diga: “gastei 32 no almoço”"
        />
      ) : tab === "overview" ? (
        <>
          <div className="fin-overview">
            <div className="fin-col fin-col-cal">
              <FinanceCalendar
                key={`${month}-${user}`}
                month={month}
                daily={data?.daily ?? []}
                income={income}
                expenses={expenses}
                limit={totalBudget}
                transactions={data?.transactions ?? []}
                renderTx={txRow}
              />
              {!readonly && <CategoriesBar className="phone-only" />}
            </div>

            <div className="fin-col fin-col-donut">
              <div className="card fin-donut-card">
                <div className="fin-card-head">
                  <span className="tone-ico" style={{ ["--c" as any]: "var(--brand-3)" }}><Icon name="target" size={15} /></span>
                  <div>
                    <h3>Gastos por categoria</h3>
                    <small className="muted">Toque numa categoria para ver os lançamentos</small>
                  </div>
                  {!readonly && <button className="btn btn-sm fin-cats-edit" onClick={() => { haptic(5); setManaging(true); }}><Icon name="edit" size={14} /> Categorias</button>}
                </div>
                {cats.length ? (
                  <div className="fin-donut">
                    <Donut items={cats} size={150} center={<div><small className="muted">Total</small><div style={{ fontWeight: 700, fontSize: 13 }} title={brl(expenses)}>{brlShort(expenses)}</div></div>} />
                    <div className="fin-legend">
                      {cats.map((c: any) => {
                        const b = budgetOf.get(c.label);
                        return (
                          <button key={c.label} style={{ ["--c" as any]: c.color }} onClick={() => { haptic(5); setCat(c.label); setTab("list"); }}>
                            <span className="dot" />
                            <span className="name" title={c.label}>{c.label}</span>
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
                {!readonly && <CategoriesBar className="hide-phone" />}
              </div>
            </div>

            <div className="fin-col">
              <GoalsCard user={user} readonly={readonly} />
              <InvoicesCard user={user} readonly={readonly} onOpen={openCards} />
              <BillsCard user={user} readonly={readonly} onPaid={() => void reload()} />
              <div className="card fin-side-card">
                <div className="fin-card-head">
                  <span className="tone-ico" style={{ ["--c" as any]: "var(--brand-2)" }}><Icon name="target" size={15} /></span>
                  <h3>Limites do mês</h3>
                  <span className="spacer" />
                  {!readonly && <button className="link-btn" onClick={() => openBudget({ category: budgets.some((b) => !b.category) ? (cats[0]?.label ?? "Alimentação") : null })}>Novo limite <Icon name="chevron-right" size={13} /></button>}
                </div>
                {budgets.map((b) => {
                  const pct = b.limit ? b.spent / b.limit : 0;
                  return (
                    <div
                      key={b.id}
                      className="budget-row"
                      role="button"
                      tabIndex={0}
                      onClick={() => openBudget({ category: b.category, amount: b.limit })}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        openBudget({ category: b.category, amount: b.limit });
                      }}
                    >
                      <span className="budget-name" title={b.category ?? undefined}>{b.category ?? "Total do mês"}</span>
                      <strong className={pct >= 1 ? "over" : ""}>{Math.round(pct * 100)}%</strong>
                      <span className={`budget-bar ${pct >= 1 ? "over" : pct >= 0.8 ? "warn" : ""}`}><i style={{ width: `${Math.min(100, pct * 100)}%` }} /></span>
                      <small className="budget-meta">{brl(b.spent)} de {brl(b.limit)}</small>
                    </div>
                  );
                })}
                {!budgets.length && (
                  <div className="fin-empty-side">
                    <p className="muted">Nenhum limite ainda. Ele avisa no WhatsApp ao chegar em 80% e quando estourar.</p>
                    {!readonly && <button className="btn btn-brand btn-sm" onClick={() => openBudget({ category: null })}><Icon name="plus" size={14} /> Criar limite</button>}
                  </div>
                )}
              </div>

            </div>
          </div>
        </>
      ) : (
        <>
          <div className="fin-list-page">
          <div className="fin-section-head">
            <h3>Por categoria</h3>
            {cat && <button className="btn btn-sm btn-ghost" aria-label={`Tirar o filtro ${cat}`} onClick={() => setCat(null)}><Icon name="x" size={14} /> <span>{cat}</span></button>}
            {!readonly && <button className="btn btn-sm fin-cats-edit" onClick={() => { haptic(5); setManaging(true); }}><Icon name="edit" size={14} /> Editar categorias</button>}
          </div>
          {cats.length ? (
            <div className="fin-cats">
              {cats.map((c: any) => {
                const prev = prevCat.get(c.label);
                const d = prev != null ? c.value - prev : null;
                return (
                  <button key={c.label} style={{ ["--c" as any]: c.color }} className={`card fin-cat ${cat === c.label ? "active" : ""} ${cat && cat !== c.label ? "dim" : ""}`} onClick={() => { haptic(5); setCat(cat === c.label ? null : c.label); }}>
                    <span className="fin-cat-ico"><Icon name={CAT_ICON[c.label] ?? "hash"} size={18} /></span>
                    <span className="fin-cat-name" title={c.label}>{c.label}</span>
                    <strong className={`fin-cat-value${longMoney(c.value)}`}>{brl(c.value)}</strong>
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
          <div className={phone ? "fp-days" : "card fin-list"}>
            {groups.map(([k, items], gi) => {
              const total = items.filter((t) => t.kind === "expense").reduce((a, t) => a + Number(t.amount), 0);
              const d = new Date(items[0].occurred_at);
              // celular: como os Lembretes da Agenda, o dia grande à esquerda e os lançamentos num cartão
              if (phone) return (
                <div key={k} className="cal-list-day fp-day" style={{ ["--n" as any]: Math.min(gi, 8) }}>
                  <span className={`cal-list-date ${d.toDateString() === today.toDateString() ? "today" : ""}`}>
                    <strong>{d.getDate()}</strong>
                    <small>{d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "")}</small>
                  </span>
                  <div className="card fp-day-card">
                    {items.map((t: any) => txRow(t))}
                    {total > 0 && items.length > 1 && <div className="fp-day-total"><span>Gasto no dia</span><span>{brl(total)}</span></div>}
                  </div>
                </div>
              );
              return (
                <div key={k}>
                  <div className="fin-day"><span>{dayLabel(items[0].occurred_at)}</span>{total > 0 && <span>{brl(total)}</span>}</div>
                  {items.map((t: any) => txRow(t))}
                </div>
              );
            })}
            {!list.length && <Empty>Nada lançado {cat ? `em ${cat} ` : ""}neste mês.</Empty>}
          </div>
          </div>
        </>
      )}
      </div>
      {phone && !readonly && tab !== "cards" && createPortal(
        <button className="cal-fab fp-fab" aria-label="Novo lançamento" onClick={() => { haptic(8); setAdding(true); }}><Icon name="plus" size={24} /></button>,
        document.body,
      )}
      {jump && (
        <MonthJump
          current={new Date(Number(month.slice(0, 4)), Number(month.slice(5)) - 1, 1)}
          max={new Date(now.getFullYear(), now.getMonth(), 1)}
          onPick={(d) => { setJump(false); setCat(null); setMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`); }}
          onClose={() => setJump(false)}
        />
      )}
      {managing && <CategoriesModal onClose={(changed) => { setManaging(false); if (changed) { void reload(); void categories.reload(); } }} />}
      {budget && <BudgetModal initial={budget} onClose={() => { setBudget(null); void reload(); }} />}
      {report && <ReportModal month={month} user={user} readonly={readonly} onClose={() => setReport(false)} />}
      {adding && <TransactionForm onClose={() => { setAdding(false); void reload(); }} />}
      {editing && <TransactionForm initial={editing} onClose={() => { setEditing(null); setDetail(null); void reload(); }} />}
      {detail && (
        <Modal
          title={detail.kind === "income" ? "Receita" : "Gasto"}
          icon={<Icon name={CAT_ICON[detail.category] ?? "wallet"} />}
          onClose={() => setDetail(null)}
          footer={readonly ? undefined : (
            <>
            <button className="btn" onClick={() => setEditing(detail)}><Icon name="edit" size={16} /> Editar</button>
            <span className="spacer" />
            <button
              className="btn btn-danger"
              onClick={() => void remove(detail)}
            >
              <Icon name="trash" size={16} /> Apagar
            </button>
            </>
          )}
        >
          <div className="fin-total" style={{ marginBottom: 12 }}>{detail.kind === "income" ? "+" : "−"}{brl(detail.amount)}</div>
          <dl className="kv">
            <dt>Descrição</dt><dd>{detail.description ?? "–"}</dd>
            {detail.merchant && (<><dt>Onde</dt><dd>{detail.merchant}</dd></>)}
            <dt>Categoria</dt><dd>{detail.category}</dd>
            <dt>Quando</dt><dd>{day(detail.occurred_at)}</dd>
            {detail.card_name && (<><dt>Cartão</dt><dd>{detail.card_name}{detail.installments ? ` · parcela ${detail.installment} de ${detail.installments}` : ""}</dd></>)}
            {detail.invoice_month && (<><dt>Fatura</dt><dd>{cap(invoiceMonthLabel(detail.invoice_month))} de {detail.invoice_month.slice(0, 4)}</dd></>)}
            <dt>Origem</dt><dd>{SOURCE[detail.source] ?? detail.source}</dd>
          </dl>
        </Modal>
      )}
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const TAB_ORDER = ["overview", "list", "cards"] as const;
const TAB_LABEL: Record<(typeof TAB_ORDER)[number], string> = { overview: "Visão geral", list: "Lançamentos", cards: "Cartões" };

function shift(month: string, delta: number) {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Novo lançamento ou edição de um existente (valor, tipo, categoria, descrição e data). */
function TransactionForm({ initial, onClose }: { initial?: any; onClose: () => void }) {
  const cats = useCategories().list;
  const cards: CreditCard[] = useCards("").data?.cards ?? [];
  const [f, setF] = useState({
    kind: initial?.kind ?? "expense",
    amount: initial ? String(initial.amount).replace(".", ",") : "",
    category: initial?.category ?? "",
    description: initial?.description ?? "",
    date: isoDate(initial ? new Date(initial.occurred_at) : new Date()),
    card_id: (initial?.card_id as string | null) ?? "",
    installments: 1,
  });
  const [error, setError] = useState<string | null>(null);
  const card = cards.find((c) => c.id === f.card_id);
  const total = Number(f.amount.replace(/\./g, "").replace(",", ".")) || 0;
  // parcela e fatura em que cai: só para mostrar (o servidor faz a conta exata, em centavos)
  const firstInvoice = card ? invoiceMonthFor(card, f.date) : null;
  return (
    <Modal
      bare
      title={initial ? "Editar lançamento" : "Novo lançamento"}
      onClose={onClose}
      footer={
        <button className="btn btn-primary" onClick={async () => {
          try {
            const { installments, card_id, ...rest } = f;
            const json = initial ? { ...rest, card_id: card_id || null } : { ...rest, card_id: card_id || null, installments: card_id ? installments : 1 };
            await api(initial ? `/api/finance/${initial.id}` : "/api/finance", { method: initial ? "PATCH" : "POST", json });
            haptic(8);
            onClose();
          } catch (e) {
            setError((e as Error).message);
          }
        }}>Salvar</button>
      }
    >
      <div className="tabs">
        <button className={f.kind === "expense" ? "active" : ""} aria-pressed={f.kind === "expense"} onClick={() => setF({ ...f, kind: "expense" })}>Gasto</button>
        <button className={f.kind === "income" ? "active" : ""} aria-pressed={f.kind === "income"} onClick={() => setF({ ...f, kind: "income" })}>Receita</button>
      </div>
      <div className="field"><label htmlFor="tx-amount">Valor (R$)</label><input id="tx-amount" name="amount" className="input" inputMode="decimal" autoComplete="off" placeholder="89,90" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} autoFocus /></div>
      <div className="field"><label htmlFor="tx-cat">Categoria</label>
        <SelectField
          id="tx-cat"
          title="Categoria"
          value={f.category}
          onChange={(category) => setF({ ...f, category })}
          options={[
            ...(!initial ? [{ value: "", label: "Automática (pela descrição)" }] : []),
            ...cats.filter((c) => c.kind === "both" || c.kind === f.kind || c.name === f.category).map((c) => ({ value: c.name, label: c.name, dot: c.color })),
            ...(f.category && !cats.some((c) => c.name === f.category) ? [{ value: f.category, label: f.category }] : []),
          ]}
        />
      </div>
      <div className="field"><label htmlFor="tx-desc">Descrição</label><input id="tx-desc" name="description" className="input" autoComplete="off" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></div>
      {cards.length > 0 && !(initial?.installments > 1) && (
        <div className="grid grid-2" style={{ gap: 10 }}>
          <div className="field"><label htmlFor="tx-card">{f.kind === "income" ? "Estorno no cartão" : "Como pagou"}</label>
            <SelectField
              id="tx-card"
              title={f.kind === "income" ? "Estorno no cartão" : "Como pagou"}
              value={f.card_id}
              onChange={(card_id) => setF({ ...f, card_id, installments: card_id ? f.installments : 1 })}
              options={[
                { value: "", label: f.kind === "income" ? "Não" : "Pix, dinheiro ou débito" },
                ...cards.map((c) => ({ value: c.id, label: `Cartão ${c.name}${c.last4 ? ` ·${c.last4}` : ""}` })),
              ]}
            />
          </div>
          {card && !initial && f.kind === "expense" && (
            <div className="field"><label htmlFor="tx-inst">Parcelas</label>
              <SelectField
                id="tx-inst"
                title="Parcelas"
                value={String(f.installments)}
                onChange={(v) => setF({ ...f, installments: Number(v) })}
                options={[{ value: "1", label: "À vista" }, ...Array.from({ length: 23 }, (_, i) => ({ value: String(i + 2), label: `${i + 2}x` }))]}
              />
            </div>
          )}
        </div>
      )}
      {card && firstInvoice && (
        <p className="muted pay-hint">
          <Icon name="card" size={13} />
          {f.installments > 1 && total ? `${f.installments}x de ${brl(Math.floor((total * 100) / f.installments) / 100)} · ` : ""}
          {f.installments > 1 ? "1ª parcela na" : "Cai na"} fatura de {invoiceMonthLabel(firstInvoice)}
        </p>
      )}
      <div className="field"><label htmlFor="tx-date">Data</label><DateField id="tx-date" title="Data do lançamento" presets="passado" value={f.date} onChange={(date) => setF({ ...f, date })} /></div>
      <ErrorBox error={error} />
    </Modal>
  );
}

function BudgetModal({ initial, onClose }: { initial: { category: string | null; amount?: number }; onClose: () => void }) {
  const cats = useCategories().list;
  const [category, setCategory] = useState(initial.category ?? "");
  const [amount, setAmount] = useState(initial.amount ? String(initial.amount).replace(".", ",") : "");
  const [error, setError] = useState<string | null>(null);
  const save = async (value: string) => {
    try {
      await api("/api/budgets", { method: "PUT", json: { category: category || null, amount: value } });
      haptic(8);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Modal
      bare
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
      <div className="field"><label htmlFor="bd-cat">Para</label>
        <SelectField
          id="bd-cat"
          title="Limite para"
          value={category}
          disabled={initial.amount != null}
          onChange={setCategory}
          options={[{ value: "", label: "Total do mês" }, ...cats.filter((c) => c.kind !== "income" || c.name === category).map((c) => ({ value: c.name, label: c.name, dot: c.color }))]}
        />
      </div>
      <div className="field"><label htmlFor="bd-amount">Limite por mês (R$)</label><input id="bd-amount" name="limit" className="input" inputMode="decimal" autoComplete="off" placeholder="800" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus /></div>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>O assistente avisa no WhatsApp quando chegar em 80% e quando passar do limite.</p>
      <ErrorBox error={error} />
    </Modal>
  );
}

type Bill = {
  id: string;
  kind: "expense" | "income";
  description: string;
  amount: number | null;
  category: string;
  due_day: number;
  remind_days_before: number;
  installments_left: number | null;
  status: { paid: boolean; due: string; days: number; late: boolean };
};

const billWhen = (b: Bill) =>
  b.status.paid ? (b.kind === "income" ? "recebida este mês" : "paga este mês") : b.status.late ? (b.kind === "income" ? `dia ${b.due_day}, ainda não caiu` : `atrasada ${-b.status.days} dia(s)`) : b.status.days === 0 ? "vence hoje" : b.status.days === 1 ? "vence amanhã" : `vence dia ${b.due_day}`;

/** Contas fixas: aluguel, internet, parcelas, salário. Lembra no WhatsApp antes do vencimento; "Paguei" lança no mês. */
function BillsCard({ user, readonly, onPaid }: { user: string; readonly: boolean; onPaid: () => void }) {
  const { data, reload } = useApi<Bill[]>(`/api/bills${user ? `?user=${user}` : ""}`);
  const [editing, setEditing] = useState<Bill | "new" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // conta de valor variável: pergunta quanto foi antes de lançar
  const [asking, setAsking] = useState<{ bill: Bill; amount: string } | null>(null);
  const pay = async (b: Bill, amount: string | null = null) => {
    if (b.amount == null && !amount) return setAsking({ bill: b, amount: "" });
    setAsking(null);
    setBusy(b.id);
    try {
      await api(`/api/bills/${b.id}/pay`, { method: "POST", json: { amount } });
      haptic(10);
      onPaid();
    } catch (e) {
      void alertDialog("Não deu certo", (e as Error).message);
    } finally {
      setBusy(null);
      reload();
    }
  };
  const bills = data ?? [];
  return (
    <div className="card fin-side-card fin-bills">
      <div className="fin-card-head">
        <span className="tone-ico" style={{ ["--c" as any]: "var(--violet)" }}><Icon name="repeat" size={15} /></span>
        <h3>Contas fixas</h3>
        <span className="spacer" />
        {!readonly && <button className="link-btn" onClick={() => setEditing("new")}>Nova conta <Icon name="chevron-right" size={13} /></button>}
      </div>
      {bills.map((b) => (
        <div key={b.id} className={`bill-row${b.status.paid ? " paid" : b.status.late && b.kind === "expense" ? " late" : ""}`}>
          <span className="fin-rem-date"><strong>{b.due_day}</strong><small>dia</small></span>
          <button className="bill-main" disabled={readonly} onClick={() => setEditing(b)}>
            <span className="ellipsis">{b.description}</span>
            <small>{b.amount != null ? brl(b.amount) : "valor varia"} · {billWhen(b)}{b.installments_left ? ` · faltam ${b.installments_left}` : ""}</small>
          </button>
          {!readonly && !b.status.paid && (
            <button className="btn btn-sm bill-pay" disabled={busy === b.id} onClick={() => pay(b)}>
              <Icon name="check" size={14} /> {b.kind === "income" ? "Caiu" : "Paguei"}
            </button>
          )}
          {b.status.paid && <span className="bill-ok"><Icon name="check" size={15} /></span>}
        </div>
      ))}
      {data && !bills.length && (
        <div className="fin-empty-side">
          <p className="muted">Aluguel, internet, parcelas, salário. Eu lembro no WhatsApp antes de vencer e lanço quando você disser "paguei".</p>
          {!readonly && <button className="btn btn-brand btn-sm" onClick={() => setEditing("new")}><Icon name="plus" size={14} /> Criar conta fixa</button>}
        </div>
      )}
      {editing && <BillForm initial={editing === "new" ? null : editing} onClose={() => { setEditing(null); reload(); }} />}
      {asking && (
        <Modal
          title={`Quanto foi ${asking.bill.description}?`}
          icon={<Icon name="receipt" />}
          onClose={() => setAsking(null)}
          footer={<button className="btn btn-primary" disabled={!asking.amount.trim()} onClick={() => pay(asking.bill, asking.amount)}>Lançar</button>}
        >
          <div className="field">
            <label htmlFor="bl-paid">Valor deste mês (R$)</label>
            <input id="bl-paid" className="input" inputMode="decimal" autoComplete="off" autoFocus value={asking.amount} onChange={(e) => setAsking({ ...asking, amount: e.target.value })} placeholder="230,50" />
          </div>
        </Modal>
      )}
    </div>
  );
}

function BillForm({ initial, onClose }: { initial: Bill | null; onClose: () => void }) {
  const [f, setF] = useState({
    description: initial?.description ?? "",
    kind: initial?.kind ?? "expense",
    amount: initial?.amount != null ? String(initial.amount).replace(".", ",") : "",
    due_day: initial?.due_day ?? 10,
    remind_days_before: initial?.remind_days_before ?? 1,
    installments_left: initial?.installments_left != null ? String(initial.installments_left) : "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { ...f, amount: f.amount.trim() || null, installments_left: f.installments_left.trim() ? Number(f.installments_left) : null };
    try {
      if (initial) await api(`/api/bills/${initial.id}`, { method: "PATCH", json: body });
      else await api("/api/bills", { method: "POST", json: body });
      haptic(10);
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!initial || !(await confirmDialog({ title: "Parar de lembrar?", body: initial.description, confirmLabel: "Remover", danger: true }))) return;
    await api(`/api/bills/${initial.id}`, { method: "DELETE" }).catch(() => {});
    onClose();
  };
  return (
    <Modal
      bare
      title={initial ? "Ajustar conta fixa" : "Nova conta fixa"}
      icon={<Icon name="repeat" />}
      onClose={onClose}
      footer={
        <>
          {initial && <button className="btn btn-ghost" onClick={remove}><Icon name="trash" size={15} /> Remover</button>}
          <span className="spacer" />
          <button className="btn btn-primary" disabled={busy || !f.description.trim()} onClick={save}>{busy ? "Salvando…" : "Salvar"}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="tabs">
        <button className={f.kind === "expense" ? "active" : ""} aria-pressed={f.kind === "expense"} onClick={() => setF({ ...f, kind: "expense" })}>Conta a pagar</button>
        <button className={f.kind === "income" ? "active" : ""} aria-pressed={f.kind === "income"} onClick={() => setF({ ...f, kind: "income" })}>Dinheiro que entra</button>
      </div>
      <div className="field">
        <label htmlFor="bl-desc">Nome</label>
        <input id="bl-desc" className="input" autoComplete="off" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={f.kind === "income" ? "Salário" : "Aluguel"} />
      </div>
      <div className="grid grid-2" style={{ gap: 10 }}>
        <div className="field">
          <label htmlFor="bl-amount">Valor (vazio se varia)</label>
          <input id="bl-amount" className="input" inputMode="decimal" autoComplete="off" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="1.500,00" />
        </div>
        <div className="field">
          <label htmlFor="bl-day">Dia do vencimento</label>
          <select id="bl-day" className="select" value={f.due_day} onChange={(e) => setF({ ...f, due_day: Number(e.target.value) })}>
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>Dia {d}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bl-remind">Lembrar</label>
          <select id="bl-remind" className="select" value={f.remind_days_before} onChange={(e) => setF({ ...f, remind_days_before: Number(e.target.value) })}>
            <option value={0}>Só no dia</option>
            {[1, 2, 3, 5, 7].map((d) => <option key={d} value={d}>{d === 1 ? "1 dia antes" : `${d} dias antes`}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="bl-inst">Parcelas que faltam</label>
          <input id="bl-inst" className="input" inputMode="numeric" autoComplete="off" value={f.installments_left} onChange={(e) => setF({ ...f, installments_left: e.target.value.replace(/\D/g, "") })} placeholder="sem fim" />
        </div>
      </div>
    </Modal>
  );
}

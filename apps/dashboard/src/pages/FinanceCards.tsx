import { useEffect, useState } from "react";
import { api, brl } from "../api";
import { CATEGORY_COLORS, Empty, ErrorBox, Loading, Modal, alertDialog, confirmDialog } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";
import "../styles/finance-cartoes.css";

/** Cartões de crédito em Finanças: carteira, faturas mês a mês, compras da fatura e parcelamentos em andamento. */

export type InvoiceStatus = "aberta" | "futura" | "fechada" | "atrasada" | "paga" | "zerada";
export type Invoice = { month: string; total: number; count: number; closing: string; due: string; status: InvoiceStatus; paid_amount: number | null };
export type CreditCard = {
  id: string;
  name: string;
  brand: string | null;
  last4: string | null;
  limit: number | null;
  closing_day: number;
  due_day: number;
  color: string;
  remind_days_before: number;
  used: number;
  available: number | null;
  open: Invoice;
  next: Invoice;
  invoices: Invoice[];
  installments: { purchase_id: string; description: string; installments: number; part: number; paid: number; left: number; left_amount: number; last_month: string | null }[];
};

export const CARD_COLORS: [string, string][] = [
  ["preto", "Preto"],
  ["grafite", "Grafite"],
  ["prata", "Prata"],
  ["roxo", "Roxo"],
  ["azul", "Azul"],
  ["verde", "Verde"],
  ["laranja", "Laranja"],
  ["vinho", "Vinho"],
];

const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const monthName = (m: string) => MONTHS[Number(m.slice(5)) - 1] ?? m;
const short = (m: string) => monthName(m).slice(0, 3);
const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const brlShort = (v: number) => (Math.abs(v) < 10000 ? brl(v) : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", notation: "compact", maximumFractionDigits: 1 }).format(v));

export const STATUS_LABEL: Record<InvoiceStatus, string> = { aberta: "Aberta", futura: "Futura", fechada: "Fechada", atrasada: "Vencida", paga: "Paga", zerada: "Sem gastos" };

/** Fatura em que cai uma compra feita hoje (mesma regra do servidor), para mostrar no formulário. */
export function invoiceMonthFor(card: { closing_day: number; due_day: number }, date: string) {
  const add = (m: string, n: number) => {
    const [y, mm] = m.split("-").map(Number) as [number, number];
    const d = new Date(Date.UTC(y, mm - 1 + n, 1));
    return d.toISOString().slice(0, 7);
  };
  const last = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).getUTCDate();
  const m = date.slice(0, 7);
  const closing = `${m}-${String(Math.min(card.closing_day, last(m))).padStart(2, "0")}`;
  const closeMonth = date < closing ? m : add(m, 1);
  return card.due_day > card.closing_day ? closeMonth : add(closeMonth, 1);
}
export { monthName as invoiceMonthLabel };

export function StatusPill({ status }: { status: InvoiceStatus }) {
  return <span className={`cc-status s-${status}`}>{STATUS_LABEL[status]}</span>;
}

/** Desenho do cartão (sem número: só apelido, banco e final). */
export function CardArt({ card, selected, onClick, compact }: { card: CreditCard; selected?: boolean; onClick?: () => void; compact?: boolean }) {
  const pct = card.limit ? Math.min(1, card.used / card.limit) : 0;
  return (
    <button type="button" className={`cc-art c-${card.color}${selected ? " sel" : ""}${compact ? " compact" : ""}`} onClick={onClick} aria-pressed={selected} aria-label={`Cartão ${card.name}`}>
      <span className="cc-art-top">
        <strong className="ellipsis">{card.name}</strong>
        {card.brand && <small className="ellipsis">{card.brand}</small>}
      </span>
      <span className="cc-chip" aria-hidden />
      <span className="cc-art-bottom">
        <span className="cc-digits">•••• {card.last4 ?? "····"}</span>
        {card.limit != null ? (
          <span className="cc-art-limit">
            <small>disponível</small>
            <b>{brlShort(card.available ?? 0)}</b>
          </span>
        ) : (
          <span className="cc-art-limit"><small>fatura</small><b>{brlShort(card.open.total)}</b></span>
        )}
      </span>
      {card.limit != null && <span className="cc-art-bar"><i style={{ width: `${pct * 100}%` }} /></span>}
    </button>
  );
}

export function useCards(user: string) {
  return useApi<{ cards: CreditCard[]; readonly: boolean }>(`/api/cards${user ? `?user=${user}` : ""}`, { poll: 30000 });
}

async function markPaid(card: CreditCard, inv: Invoice, paid: boolean) {
  try {
    await api(`/api/cards/${card.id}/invoices/${inv.month}/pay`, { method: paid ? "POST" : "DELETE", json: paid ? {} : undefined });
    haptic(10);
    return true;
  } catch (e) {
    void alertDialog("Não deu certo", (e as Error).message);
    return false;
  }
}

/** Card da Visão geral: a próxima fatura de cada cartão, com "Paguei". */
export function InvoicesCard({ user, readonly, onOpen }: { user: string; readonly: boolean; onOpen: (cardId?: string) => void }) {
  const { data, reload } = useCards(user);
  const [editing, setEditing] = useState(false);
  const cards = data?.cards ?? [];
  return (
    <div className="card fin-side-card cc-side">
      <div className="fin-card-head">
        <span className="tone-ico" style={{ ["--c" as any]: "var(--violet)" }}><Icon name="card" size={15} /></span>
        <h3>Faturas</h3>
        <span className="spacer" />
        {cards.length > 0 && <button className="link-btn" onClick={() => onOpen()}>Cartões <Icon name="chevron-right" size={13} /></button>}
      </div>
      {cards.map((c) => {
        const inv = c.next.total > 0 || c.next.status === "paga" ? c.next : c.open;
        const due = inv.status === "fechada" || inv.status === "atrasada";
        return (
          <div key={c.id} className={`cc-side-row${inv.status === "atrasada" ? " late" : ""}`}>
            <button className="cc-side-main" onClick={() => onOpen(c.id)}>
              <span className={`cc-mini c-${c.color}`} aria-hidden>{c.last4 ?? ""}</span>
              <span className="cc-side-text">
                <span className="ellipsis">{c.name}</span>
                <small>{STATUS_LABEL[inv.status]} · vence {ddmm(inv.due)}</small>
              </span>
              <strong>{brl(inv.total)}</strong>
            </button>
            {!readonly && due && inv.total > 0 && (
              <button className="icon-btn round cc-side-pay" aria-label={`Marcar a fatura do ${c.name} como paga`} title="Paguei" onClick={async () => { if (await markPaid(c, inv, true)) void reload(); }}>
                <Icon name="check" size={15} />
              </button>
            )}
            {inv.status === "paga" && <span className="bill-ok"><Icon name="check" size={15} /></span>}
          </div>
        );
      })}
      {data && !cards.length && (
        <div className="fin-empty-side">
          <p className="muted">Cadastre seus cartões e eu separo as compras por fatura, lembro do vencimento e mostro o limite que sobra.</p>
          {!readonly && <button className="btn btn-brand btn-sm" onClick={() => setEditing(true)}><Icon name="plus" size={14} /> Adicionar cartão</button>}
        </div>
      )}
      {editing && <CardForm initial={null} onClose={() => { setEditing(false); void reload(); }} />}
    </div>
  );
}

/** Aba Cartões. */
export function CardsTab({ user, readonly, focus, onChanged }: { user: string; readonly: boolean; focus?: string | null; onChanged: () => void }) {
  const { data, error, reload } = useCards(user);
  const cards = data?.cards ?? [];
  const [sel, setSel] = useState<string | null>(focus ?? null);
  const [month, setMonth] = useState<string | null>(null);
  const [editing, setEditing] = useState<CreditCard | "new" | null>(null);
  useEffect(() => { if (focus) setSel(focus); }, [focus]);
  const card = cards.find((c) => c.id === sel) ?? cards[0];
  // fatura escolhida: a próxima a pagar, até a pessoa tocar outra
  const current = card ? (month && card.invoices.some((i) => i.month === month) ? month : card.next.month) : null;
  const detail = useApi<{ invoice: Invoice; items: any[] }>(card && current ? `/api/cards/${card.id}/invoice?month=${current}${user ? `&user=${user}` : ""}` : null);
  const refresh = () => { void reload(); void detail.reload(); onChanged(); };

  if (!data) return error ? <ErrorBox error={error} /> : <Loading />;
  if (!cards.length)
    return (
      <div className="card cc-empty">
        <div className="cc-empty-art" aria-hidden><span className="cc-art c-preto"><span className="cc-art-top"><strong>Seu cartão</strong></span><span className="cc-chip" /><span className="cc-art-bottom"><span className="cc-digits">•••• 0000</span></span></span></div>
        <h3>Acompanhe suas faturas</h3>
        <p className="muted">Cadastre o cartão com o apelido, o dia em que a fatura fecha e o dia em que vence. Eu separo cada compra (à vista ou parcelada) na fatura certa e te lembro no WhatsApp antes de vencer.</p>
        <p className="muted cc-hint">No WhatsApp também dá: <em>"cadastra meu Nubank, fecha dia 3 e vence dia 10"</em> e depois <em>"parcelei 1.200 em 10x no Nubank"</em>.</p>
        {!readonly && <button className="btn btn-brand" onClick={() => setEditing("new")}><Icon name="plus" size={16} /> Adicionar cartão</button>}
        <p className="muted cc-safe"><Icon name="shield" size={13} /> Nunca peço o número inteiro, o código de segurança nem a validade.</p>
        {editing && <CardForm initial={null} onClose={() => { setEditing(null); refresh(); }} />}
      </div>
    );

  const c = card!;
  const inv = detail.data?.invoice ?? c.invoices.find((i) => i.month === current) ?? c.next;
  const max = Math.max(1, ...c.invoices.map((i) => i.total));
  const usedPct = c.limit ? Math.min(100, (c.used / c.limit) * 100) : 0;
  const items = detail.data?.items ?? [];
  const pay = async (paid: boolean) => {
    if (!paid && !(await confirmDialog({ title: "Desfazer o pagamento?", body: `A fatura de ${monthName(inv.month)} volta a contar como não paga.`, confirmLabel: "Desfazer" }))) return;
    if (await markPaid(c, inv, paid)) refresh();
  };

  return (
    <div className="cc-layout">
      <aside className="cc-wallet">
        {cards.map((x) => (
          <CardArt key={x.id} card={x} selected={x.id === c.id} onClick={() => { haptic(5); setSel(x.id); setMonth(null); }} />
        ))}
        {!readonly && (
          <button className="cc-add" onClick={() => setEditing("new")}><Icon name="plus" size={18} /> <span>Novo cartão</span></button>
        )}
      </aside>

      <div className="cc-main">
        <div className="card cc-summary">
          <div>
            <small>Próxima a pagar</small>
            <strong>{brl(c.next.total)}</strong>
            <span>{monthName(c.next.month)} · vence {ddmm(c.next.due)} <StatusPill status={c.next.status} /></span>
          </div>
          <div>
            <small>Fatura aberta</small>
            <strong>{brl(c.open.total)}</strong>
            <span>fecha {ddmm(c.open.closing)}</span>
          </div>
          <div className="cc-limit">
            <small>Limite disponível</small>
            <strong className={c.available != null && c.available < 0 ? "neg" : ""}>{c.available != null ? brl(c.available) : "—"}</strong>
            {c.limit != null ? (
              <>
                <span className="cc-limit-bar"><i className={usedPct >= 90 ? "hot" : ""} style={{ width: `${usedPct}%` }} /></span>
                <span>{brl(c.used)} usados de {brl(c.limit)}</span>
              </>
            ) : <span>limite não informado</span>}
          </div>
          <div className="cc-cycle">
            <small>Ciclo</small>
            <span className="cc-cycle-days"><b>{c.closing_day}</b><em>fecha</em><i /><b>{c.due_day}</b><em>vence</em></span>
            {!readonly && <button className="link-btn" onClick={() => setEditing(c)}><Icon name="edit" size={13} /> Ajustar cartão</button>}
          </div>
        </div>

        <div className="card cc-timeline">
          <div className="fin-card-head">
            <h3>Faturas mês a mês</h3>
            <span className="spacer" />
            <small className="muted">toque num mês</small>
          </div>
          <div className="cc-months" role="tablist">
            {c.invoices.map((i) => (
              <button
                key={i.month}
                role="tab"
                aria-selected={i.month === current}
                className={`cc-month s-${i.status}${i.month === current ? " active" : ""}`}
                onClick={() => { haptic(5); setMonth(i.month); }}
                title={`${monthName(i.month)}: ${brl(i.total)} (${STATUS_LABEL[i.status]})`}
              >
                <small className="cc-month-val">{i.total ? brlShort(i.total) : "–"}</small>
                <span className="cc-month-bar"><i style={{ height: `${Math.max(i.total ? 6 : 0, (i.total / max) * 100)}%` }} /></span>
                <span className="cc-month-name">{short(i.month)}{i.month.endsWith("-01") ? ` ${i.month.slice(2, 4)}` : ""}</span>
                <span className="cc-month-dot" aria-hidden />
              </button>
            ))}
          </div>
        </div>

        <div className="cc-cols">
          <div className="card cc-invoice">
            <div className="cc-invoice-head">
              <div>
                <h3>Fatura de {monthName(inv.month)} <StatusPill status={inv.status} /></h3>
                <small className="muted">Fecha {ddmm(inv.closing)} · vence {ddmm(inv.due)} · {inv.count} {inv.count === 1 ? "compra" : "compras"}</small>
              </div>
              <strong className="cc-invoice-total">{brl(inv.total)}</strong>
            </div>
            {!readonly && inv.total > 0 && inv.status !== "paga" && (
              <button className="btn btn-primary cc-pay" onClick={() => void pay(true)}><Icon name="check" size={16} /> Marcar como paga</button>
            )}
            {!readonly && inv.status === "paga" && (
              <div className="cc-paid"><Icon name="check" size={15} /> Paga{inv.paid_amount != null ? ` (${brl(inv.paid_amount)})` : ""}<span className="spacer" /><button className="link-btn" onClick={() => void pay(false)}>Desfazer</button></div>
            )}
            <div className="cc-items">
              {items.map((t: any, idx: number) => (
                <div key={t.id} className="cc-item">
                  <span className="cc-item-date"><b>{new Date(t.occurred_at).getDate()}</b><small>{short(new Date(t.occurred_at).toISOString().slice(0, 7))}</small></span>
                  <span className="cc-item-text">
                    <span className="ellipsis">{(t.description ?? t.merchant ?? t.category).replace(/\s*\(\d+\/\d+\)$/, "")}</span>
                    <small className="muted ellipsis">
                      <span className="cc-cat-dot" style={{ background: CATEGORY_COLORS[idx % CATEGORY_COLORS.length] }} />
                      {t.category}{t.installments ? ` · parcela ${t.installment} de ${t.installments}` : ""}
                    </small>
                  </span>
                  <strong className={t.kind === "income" ? "amount-in" : ""}>{t.kind === "income" ? "+" : ""}{brl(t.amount)}</strong>
                </div>
              ))}
              {detail.data && !items.length && <Empty>Nenhuma compra nesta fatura.</Empty>}
              {!detail.data && <Loading />}
            </div>
          </div>

          <div className="card cc-plans">
            <div className="fin-card-head"><h3>Parcelamentos</h3><span className="spacer" /><small className="muted">{c.installments.length ? `${c.installments.length} em andamento` : ""}</small></div>
            {c.installments.map((p) => (
              <div key={p.purchase_id} className="cc-plan">
                <div className="cc-plan-top">
                  <span className="ellipsis">{p.description}</span>
                  <strong>{brl(p.part)}<small>/mês</small></strong>
                </div>
                <span className="cc-plan-bar"><i style={{ width: `${(p.paid / p.installments) * 100}%` }} /></span>
                <small className="muted">{p.paid} de {p.installments} pagas · faltam {brl(p.left_amount)}{p.last_month ? ` · até ${short(p.last_month)}/${p.last_month.slice(2, 4)}` : ""}</small>
              </div>
            ))}
            {!c.installments.length && <p className="muted fin-empty-side">Nenhuma compra parcelada neste cartão. No WhatsApp: "parcelei 600 em 6x no {c.name}".</p>}
          </div>
        </div>
      </div>
      {editing && <CardForm initial={editing === "new" ? null : editing} onClose={(id) => { setEditing(null); if (id) setSel(id); refresh(); }} />}
    </div>
  );
}

/** Cadastro e ajuste do cartão: só apelido, banco, final, limite, fechamento e vencimento. */
export function CardForm({ initial, onClose }: { initial: CreditCard | null; onClose: (id?: string) => void }) {
  const [f, setF] = useState({
    name: initial?.name ?? "",
    brand: initial?.brand ?? "",
    last4: initial?.last4 ?? "",
    limit: initial?.limit != null ? String(initial.limit).replace(".", ",") : "",
    closing_day: initial?.closing_day ?? 3,
    due_day: initial?.due_day ?? 10,
    remind_days_before: initial?.remind_days_before ?? 3,
    color: initial?.color ?? "preto",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const preview: CreditCard = {
    id: "preview", name: f.name || "Apelido", brand: f.brand || null, last4: f.last4.length === 4 ? f.last4 : null, limit: null, closing_day: f.closing_day, due_day: f.due_day,
    color: f.color, remind_days_before: f.remind_days_before, used: 0, available: null, open: { month: "", total: 0, count: 0, closing: "", due: "", status: "aberta", paid_amount: null }, next: { month: "", total: 0, count: 0, closing: "", due: "", status: "aberta", paid_amount: null }, invoices: [], installments: [],
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    const body = { ...f, brand: f.brand.trim() || null, last4: f.last4 || null, limit: f.limit.trim() || null };
    try {
      const r = initial ? await api<any>(`/api/cards/${initial.id}`, { method: "PATCH", json: body }) : await api<any>("/api/cards", { method: "POST", json: body });
      haptic(10);
      onClose(r?.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!initial || !(await confirmDialog({ title: `Remover o ${initial.name}?`, body: "As compras continuam nos seus lançamentos, só param de aparecer por fatura.", confirmLabel: "Remover", danger: true }))) return;
    await api(`/api/cards/${initial.id}`, { method: "DELETE" }).catch(() => {});
    onClose();
  };
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  return (
    <Modal
      title={initial ? "Ajustar cartão" : "Novo cartão"}
      icon={<Icon name="card" />}
      onClose={() => onClose()}
      footer={
        <>
          {initial && <button className="btn btn-ghost" onClick={remove}><Icon name="trash" size={15} /> Remover</button>}
          <span className="spacer" />
          <button className="btn btn-primary" disabled={busy || !f.name.trim()} onClick={save}>{busy ? "Salvando…" : "Salvar"}</button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="cc-form-preview"><CardArt card={preview} compact /></div>
      <div className="grid grid-2" style={{ gap: 10 }}>
        <div className="field">
          <label htmlFor="cc-name">Apelido</label>
          <input id="cc-name" className="input" autoComplete="off" maxLength={40} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Nubank" autoFocus={!initial} />
        </div>
        <div className="field">
          <label htmlFor="cc-brand">Banco ou bandeira</label>
          <input id="cc-brand" className="input" autoComplete="off" maxLength={30} value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value })} placeholder="Mastercard" />
        </div>
        <div className="field">
          <label htmlFor="cc-last4">Final (4 dígitos)</label>
          <input id="cc-last4" className="input" inputMode="numeric" autoComplete="off" maxLength={4} value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value.replace(/\D/g, "").slice(0, 4) })} placeholder="1234" />
        </div>
        <div className="field">
          <label htmlFor="cc-limit">Limite (R$)</label>
          <input id="cc-limit" className="input" inputMode="decimal" autoComplete="off" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} placeholder="5.000,00" />
        </div>
        <div className="field">
          <label htmlFor="cc-close">Fatura fecha</label>
          <select id="cc-close" className="select" value={f.closing_day} onChange={(e) => setF({ ...f, closing_day: Number(e.target.value) })}>
            {days.map((d) => <option key={d} value={d}>Dia {d}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cc-due">Fatura vence</label>
          <select id="cc-due" className="select" value={f.due_day} onChange={(e) => setF({ ...f, due_day: Number(e.target.value) })}>
            {days.map((d) => <option key={d} value={d}>Dia {d}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="cc-remind">Me lembrar</label>
          <select id="cc-remind" className="select" value={f.remind_days_before} onChange={(e) => setF({ ...f, remind_days_before: Number(e.target.value) })}>
            <option value={0}>Só no dia</option>
            {[1, 2, 3, 5, 7].map((d) => <option key={d} value={d}>{d === 1 ? "1 dia antes" : `${d} dias antes`}</option>)}
          </select>
        </div>
        <div className="field">
          <label id="cc-color-l">Cor</label>
          <div className="cc-colors" role="radiogroup" aria-labelledby="cc-color-l">
            {CARD_COLORS.map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={f.color === k} aria-label={label} title={label} className={`cc-swatch c-${k}${f.color === k ? " on" : ""}`} onClick={() => setF({ ...f, color: k })} />
            ))}
          </div>
        </div>
      </div>
      <p className="muted cc-safe"><Icon name="shield" size={13} /> Guardo só o final. Nunca o número inteiro, o código de segurança ou a validade.</p>
    </Modal>
  );
}

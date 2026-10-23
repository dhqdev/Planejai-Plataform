import { Link } from "react-router-dom";
import { brl } from "../api";
import { Empty, ErrorBox, Loading, PageHead } from "../components";
import { useApi } from "../hooks";
import "../styles/pagamentos.css";

interface Payment {
  id: string;
  description: string;
  value: number;
  dueDate: string | null;
  paidAt: string | null;
  status: string;
  paid: boolean;
  open: boolean;
  method: string | null;
  invoiceUrl: string | null;
  receiptUrl: string | null;
}
interface BillingInfo {
  subscription?: {
    status: string;
    plan: { name: string; grains: number; price: number } | null;
    nextPlan: { name: string } | null;
    value: number;
    discount: number;
    method: string | null;
    card: { brand: string | null; last4: string } | null;
    nextDueDate: string | null;
  } | null;
}

/** Dia de calendário (AAAA-MM-DD) como 07/10/2026, sem mexer com fuso. */
const dmy = (iso?: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "–");

/**
 * Pagamentos (só para quem já pagou alguma vez): a assinatura, a forma de pagamento e as cobranças no Asaas, com o link
 * para pagar o que está em aberto e o comprovante do que foi pago. Trocar de plano e comprar grãos ficam em Meu plano.
 * O nome evita confusão com Finanças, que são os gastos da própria pessoa.
 */
export function PaymentsPage() {
  const info = useApi<BillingInfo>("/api/billing");
  const list = useApi<{ payments: Payment[] }>("/api/billing/payments");
  if (info.error) return <div className="page"><ErrorBox error={info.error} /></div>;
  if (!info.data) return <Loading />;
  const sub = info.data.subscription;
  const payments = list.data?.payments ?? [];
  const open = payments.filter((p) => p.open);
  const paidTotal = payments.filter((p) => p.paid).reduce((acc, p) => acc + Math.round(p.value * 100), 0) / 100;

  return (
    <div className="page pay-page">
      <PageHead title="Pagamentos" subtitle="Sua assinatura, a forma de pagamento e todas as cobranças." />
      <div className="pay-cards">
        <section className="pay-card">
          <small>Assinatura</small>
          <b>{sub?.plan ? `Plano ${sub.plan.name}` : "Sem plano agora"}</b>
          <span>
            {sub?.plan
              ? `${brl(sub.value)} por mês${sub.discount > 0 ? ` (com ${sub.discount}% de desconto)` : ""}`
              : "Você compra grãos avulsos quando precisa."}
          </span>
          {sub?.nextPlan && <span>Muda para o {sub.nextPlan.name} na próxima mensalidade.</span>}
        </section>
        <section className="pay-card">
          <small>Próxima cobrança</small>
          <b>{sub?.nextDueDate ? dmy(sub.nextDueDate) : "–"}</b>
          <span>{sub?.nextDueDate ? brl(sub.value) : "Nada agendado"}</span>
        </section>
        <section className="pay-card">
          <small>Forma de pagamento</small>
          <b>{sub?.card ? `${sub.card.brand ?? "Cartão"} final ${sub.card.last4}` : sub?.method === "card" ? "Cartão de crédito" : sub ? "Pix ou boleto" : "Na hora da compra"}</b>
          <span>{sub?.card || sub?.method === "card" ? "Renova sozinho todo mês. O cartão fica com o Asaas." : "Você paga cada cobrança pelo link."}</span>
        </section>
        <section className="pay-card">
          <small>Já pago</small>
          <b>{brl(paidTotal)}</b>
          <span>{payments.filter((p) => p.paid).length} cobranças pagas</span>
        </section>
      </div>

      {open.length > 0 && (
        <div className="pay-alert">
          <span>{open.length === 1 ? "Uma cobrança está em aberto." : `${open.length} cobranças estão em aberto.`}</span>
          {open[0]!.invoiceUrl && (
            <a className="btn btn-primary btn-sm" href={open[0]!.invoiceUrl}>Pagar agora</a>
          )}
        </div>
      )}

      <div className="pay-head">
        <h2>Cobranças</h2>
        <Link className="pay-link" to="/plano">Trocar de plano ou comprar grãos</Link>
      </div>
      {list.error ? (
        <ErrorBox error={list.error} />
      ) : !list.data ? (
        <Loading />
      ) : payments.length === 0 ? (
        <Empty>Nenhuma cobrança ainda.</Empty>
      ) : (
        <ul className="pay-list">
          {payments.map((p) => (
            <li key={p.id}>
              <div className="pay-what">
                <b>{p.description}</b>
                <small>
                  {p.paid ? `Pago em ${dmy(p.paidAt ?? p.dueDate)}` : `Vence em ${dmy(p.dueDate)}`}
                  {p.method ? ` · ${p.method}` : ""}
                </small>
              </div>
              <span className={`pay-status ${p.paid ? "ok" : p.open ? "open" : ""}`}>{p.status}</span>
              <b className="pay-value">{brl(p.value)}</b>
              <span className="pay-act">
                {p.open && p.invoiceUrl ? (
                  <a href={p.invoiceUrl}>Pagar</a>
                ) : p.receiptUrl ? (
                  <a href={p.receiptUrl} target="_blank" rel="noopener noreferrer">Comprovante</a>
                ) : p.invoiceUrl ? (
                  <a href={p.invoiceUrl} target="_blank" rel="noopener noreferrer">Ver</a>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

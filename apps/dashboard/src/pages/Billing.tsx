import { useState } from "react";
import { api, brl } from "../api";
import { ErrorBox, Loading, PageHead, confirmDialog } from "../components";
import { useApi } from "../hooks";

interface Billing {
  plan: { enabled: boolean; name: string; price: number; trialDays: number };
  linked: boolean;
  ready?: boolean;
  name?: string;
  email?: string;
  trialEndsAt?: string;
  access?: { allowed: boolean; state: string; until: string | null };
  subscription?: { status: "trial" | "active" | "overdue" | "canceled"; value: number; nextDueDate: string | null; paidUntil: string | null; lastPaymentAt: string | null; invoiceUrl: string | null } | null;
}

/** 000.000.000-00 ou 00.000.000/0000-00 enquanto digita. */
function maskDoc(v: string) {
  const d = v.replace(/\D/g, "").slice(0, 14);
  if (d.length <= 11) return d.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  return d.replace(/^(\d{2})(\d)/, "$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d)/, ".$1/$2").replace(/(\d{4})(\d{1,2})$/, "$1-$2");
}

/** Dia de calendário (AAAA-MM-DD) como 07/10/2026, sem mexer com fuso. */
const day = (iso?: string | null) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "–");
const daysLeft = (iso?: string | null) => (iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000)) : 0);

/** Assinatura do cliente: um plano, um preço por mês. O pagamento acontece na página do Asaas (Pix, cartão ou boleto). */
export function BillingPage() {
  const { data, error, reload } = useApi<Billing>("/api/billing");
  const [name, setName] = useState<string | null>(null);
  const [doc, setDoc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;

  const { plan, subscription: sub, access } = data;
  const fullName = name ?? data.name ?? "";
  const subscribed = sub && sub.status !== "canceled";
  const inTrial = access?.state === "trial";

  const subscribe = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ invoiceUrl: string | null }>("/api/billing/subscribe", { method: "POST", json: { name: fullName, cpfCnpj: doc } });
      await reload();
      // quem já passou dos dias grátis vai direto pagar
      if (r.invoiceUrl && !inTrial) window.open(r.invoiceUrl, "_blank", "noopener");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    const ok = await confirmDialog({
      title: "Cancelar a assinatura?",
      body: sub?.paidUntil ? `Você continua usando até ${day(sub.paidUntil)}. Depois disso o assistente para de responder.` : "O assistente para de responder quando os dias grátis acabarem.",
      confirmLabel: "Cancelar assinatura",
      cancelLabel: "Manter",
      danger: true,
    });
    if (!ok) return;
    setErr(null);
    try {
      await api("/api/billing/cancel", { method: "POST" });
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const status = !plan.enabled
    ? "Por enquanto o Planejai é gratuito para você."
    : access?.state === "exempt"
      ? "Seu acesso é liberado, sem cobrança."
      : sub?.status === "active"
        ? `Em dia. Próxima cobrança em ${day(sub.nextDueDate)}.`
        : sub?.status === "overdue"
          ? "Pagamento pendente. O assistente volta assim que o pagamento cair."
          : sub?.status === "trial"
            ? `Assinatura feita. A primeira cobrança vence em ${day(sub.nextDueDate)}.`
            : sub?.status === "canceled" && access?.allowed
              ? `Cancelada. Você usa até ${day(access.until)}.`
              : inTrial
                ? `Você está nos dias grátis: ${daysLeft(data.trialEndsAt) === 1 ? "falta 1 dia" : `faltam ${daysLeft(data.trialEndsAt)} dias`}.`
                : "Seus dias grátis acabaram. Assine para o assistente voltar a responder.";

  return (
    <div className="page bill-page">
      <PageHead title="Assinatura" />
      <div className="bill">
        <p className="bill-plan">{plan.name}</p>
        <p className="bill-price">
          {brl(plan.price)} <span>por mês</span>
        </p>
        <p className="bill-status">{status}</p>

        {plan.enabled && access?.state !== "exempt" && (
          <>
            {sub?.invoiceUrl && subscribed && (
              <a className="btn btn-primary bill-cta" href={sub.invoiceUrl} target="_blank" rel="noopener noreferrer">
                {sub.status === "overdue" ? "Pagar agora" : "Ver cobrança e pagar"}
              </a>
            )}

            {!subscribed && data.linked && data.ready && (
              <form
                className="bill-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void subscribe();
                }}
              >
                <div className="field">
                  <label htmlFor="bill-name">Nome completo</label>
                  <input id="bill-name" className="input" autoComplete="name" value={fullName} onChange={(e) => setName(e.target.value)} required />
                </div>
                <div className="field">
                  <label htmlFor="bill-doc">CPF ou CNPJ</label>
                  <input id="bill-doc" className="input" inputMode="numeric" autoComplete="off" placeholder="000.000.000-00" value={doc} onChange={(e) => setDoc(maskDoc(e.target.value))} required />
                  <div className="help">Exigido pelo Asaas para emitir a cobrança. Não fica guardado no Planejai.</div>
                </div>
                <button className="btn btn-primary bill-cta" disabled={busy}>
                  {busy ? "Criando assinatura…" : inTrial ? "Assinar e continuar depois dos dias grátis" : "Assinar"}
                </button>
              </form>
            )}
            {!subscribed && data.linked && !data.ready && <p className="help">A assinatura ainda está sendo configurada. Tente de novo mais tarde.</p>}
            {!data.linked && <p className="help">Ligue seu WhatsApp em Minha conta para poder assinar.</p>}

            <ul className="bill-facts">
              <li>{plan.trialDays > 0 ? `${plan.trialDays} dias grátis; a primeira cobrança só vem depois.` : "A primeira cobrança vem na hora."}</li>
              <li>Cobrança todo mês, no mesmo dia. Sem fidelidade.</li>
              <li>Pix, cartão ou boleto, na página de pagamento do Asaas.</li>
            </ul>

            {subscribed && (
              <button className="btn btn-ghost btn-danger bill-cancel" onClick={cancel}>
                Cancelar assinatura
              </button>
            )}
          </>
        )}
        {err && <ErrorBox error={err} />}
      </div>
    </div>
  );
}

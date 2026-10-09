import { useState } from "react";
import { api, brl } from "../api";
import { ErrorBox, Loading, Modal, PageHead, confirmDialog } from "../components";
import { useApi } from "../hooks";

interface Plan {
  id: string;
  name: string;
  price: number;
  grains: number;
  blurb: string;
  highlight?: boolean;
}
interface Pack {
  id: string;
  grains: number;
  price: number;
}
interface Pricing {
  enabled: boolean;
  plans: Plan[];
  packs: Pack[];
  welcome: number;
  grainsPerUsd: number;
  referral: { step: number; max: number };
}
interface Billing {
  pricing: Pricing;
  linked: boolean;
  ready?: boolean;
  exempt?: boolean;
  hasCustomer?: boolean;
  name?: string;
  email?: string;
  wallet?: { plan: number; extra: number; total: number };
  burnPerDay?: number;
  access?: { allowed: boolean; state: string };
  ledger?: { delta: number; reason: string; label: string; note: string | null; day: string | null; at: string }[];
  pending?: { kind: "pack" | "upgrade"; itemId: string; grains: number; value: number; invoiceUrl: string | null }[];
  subscription?: {
    status: "trial" | "active" | "overdue" | "canceled";
    plan: { id: string; name: string; grains: number; price: number } | null;
    nextPlan: { id: string; name: string } | null;
    value: number;
    discount: number;
    method: string | null;
    card: { brand: string | null; last4: string } | null;
    nextDueDate: string | null;
    lastPaymentAt: string | null;
    invoiceUrl: string | null;
  } | null;
  referral?: {
    friends: { name: string; paying: boolean }[];
    percent: number;
    step: number;
    max: number;
    next: number | null;
    prices: { id: string; price: number; withDiscount: number }[];
  };
}

/** 000.000.000-00 ou 00.000.000/0000-00 enquanto digita. */
function maskDoc(v: string) {
  const d = v.replace(/\D/g, "").slice(0, 14);
  if (d.length <= 11) return d.replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d)/, "$1.$2").replace(/(\d{3})(\d{1,2})$/, "$1-$2");
  return d.replace(/^(\d{2})(\d)/, "$1.$2").replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3").replace(/\.(\d{3})(\d)/, ".$1/$2").replace(/(\d{4})(\d{1,2})$/, "$1-$2");
}

const nf = new Intl.NumberFormat("pt-BR");
const grainsText = (n: number) => `${nf.format(Math.max(0, Math.round(n)))} ${Math.round(n) === 1 ? "grão" : "grãos"}`;
/** Dia de calendário (AAAA-MM-DD) como 07/10, sem mexer com fuso. */
const ddmm = (iso?: string | null) => (iso ? iso.slice(0, 10).split("-").slice(1).reverse().join("/") : "–");
const shortDate = (iso: string) => new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });

/** O Asaas não aceita cobrança abaixo disto: subir de plano com diferença menor vale da próxima mensalidade. */
const ASAAS_MIN_CHARGE = 5;
const NO_LINK = "O pedido foi registrado, mas o link de pagamento ainda não chegou. Atualize a página em instantes para pagar.";

/**
 * Abre a página de pagamento numa aba nova. A aba é aberta no clique (senão o navegador bloqueia) e recebe o link depois.
 * Devolve false quando o link não veio (a aba é fechada e quem chamou avisa a pessoa).
 */
async function payIn(run: () => Promise<string | null | undefined>) {
  const tab = window.open("", "_blank");
  // a página de pagamento não ganha acesso a esta aba
  if (tab) tab.opener = null;
  try {
    const url = await run();
    if (url && tab) tab.location.href = url;
    else tab?.close();
    return Boolean(url);
  } catch (e) {
    tab?.close();
    throw e;
  }
}

type Checkout = { kind: "plan"; plan: Plan } | { kind: "pack"; pack: Pack };

/** Plano e grãos: saldo, planos, pacotes avulsos, desconto por indicação e extrato. O pagamento acontece na página do Asaas. */
export function BillingPage() {
  const { data, error, reload } = useApi<Billing>("/api/billing");
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [ledger, setLedger] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;

  const { pricing, wallet, subscription: sub, referral } = data;
  const current = sub?.plan?.id ?? null;
  const currentPrice = sub?.plan?.price ?? 0;
  const live = pricing.enabled && !data.exempt;
  const discount = referral?.percent ?? 0;
  const priceOf = (p: Plan) => referral?.prices.find((x) => x.id === p.id)?.withDiscount ?? p.price;

  const changePlan = async (plan: Plan) => {
    // primeira mensalidade ainda não paga: só troca o plano dela, sem cobrança de diferença
    const firstUnpaid = !sub?.lastPaymentAt;
    const difference = Math.round((plan.price - currentPrice) * (1 - discount / 100) * 100) / 100;
    const up = !firstUnpaid && plan.price > currentPrice && difference >= ASAAS_MIN_CHARGE;
    const ok = await confirmDialog({
      title: plan.price > currentPrice ? `Subir para o ${plan.name}?` : plan.id === current ? `Continuar no ${plan.name}?` : `Mudar para o ${plan.name}?`,
      body: firstUnpaid
        ? `Sua primeira mensalidade ainda não foi paga, então só troco o plano dela: passa a ser ${brl(priceOf(plan))}, com ${grainsText(plan.grains)} quando o pagamento cair.`
        : up
          ? `Você paga hoje só a diferença deste mês (${brl(difference)}) e ganha ${grainsText(plan.grains - (sub?.plan?.grains ?? 0))} assim que o pagamento cair. Depois a mensalidade passa a ser ${brl(priceOf(plan))}.`
          : plan.id === current
            ? "A troca agendada é desfeita e a mensalidade continua a mesma."
            : `Vale a partir da próxima mensalidade (${ddmm(sub?.nextDueDate)}), que passa a ser ${brl(priceOf(plan))}. Os grãos deste mês continuam com você.`,
      confirmLabel: up ? "Ir para o pagamento" : "Confirmar",
    });
    if (!ok) return;
    setErr(null);
    try {
      if (up) {
        const opened = await payIn(async () => (await api<{ invoiceUrl: string | null }>("/api/billing/change-plan", { method: "POST", json: { planId: plan.id } })).invoiceUrl);
        if (!opened) setErr(NO_LINK);
      } else await api("/api/billing/change-plan", { method: "POST", json: { planId: plan.id } });
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const cancel = async () => {
    const ok = await confirmDialog({
      title: "Cancelar o plano?",
      body: "Os grãos que já estão na sua conta continuam valendo até acabar. Dá para voltar quando quiser.",
      confirmLabel: "Cancelar plano",
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

  const total = wallet?.total ?? 0;
  const planShare = sub?.plan && wallet ? Math.min(1, wallet.plan / Math.max(1, sub.plan.grains)) : null;
  const days = data.burnPerDay && data.burnPerDay > 0 ? Math.floor(total / data.burnPerDay) : null;
  const status = !pricing.enabled
    ? "Por enquanto o Planejai é gratuito para você."
    : data.exempt
      ? "Seu acesso é liberado, sem gastar grãos."
      : !data.linked
        ? "Ligue seu WhatsApp em Minha conta para ver seus grãos."
        : sub?.status === "overdue"
          ? "A mensalidade está pendente, então os grãos do plano não foram recarregados."
          : total <= 0
            ? "Seus grãos acabaram. Compre um pacote ou escolha um plano para o assistente voltar."
            : days != null
              ? `No seu ritmo, dá para ${days > 60 ? "mais de 2 meses" : days <= 1 ? "cerca de 1 dia" : `uns ${days} dias`}.`
              : "Cada resposta gasta alguns grãos, conforme o trabalho que deu.";

  return (
    <div className="page grain-page">
      <PageHead title="Plano e grãos" />
      <div className="grain-layout">
        <section className="bill grain-wallet" aria-label="Seus grãos">
          <div className="bill-head">
            <p className="bill-plan">{sub?.plan ? `Plano ${sub.plan.name}` : "Sem plano"}</p>
            <p className="bill-price">
              {nf.format(Math.max(0, total))} <span>{total === 1 ? "grão" : "grãos"}</span>
            </p>
            {live && wallet && sub?.plan && (
              <div className="grain-bar" role="img" aria-label={`${grainsText(wallet.plan)} de ${grainsText(sub.plan.grains)} do plano`}>
                <i style={{ width: `${Math.round((planShare ?? 0) * 100)}%` }} />
              </div>
            )}
            {live && wallet && (wallet.plan > 0 || wallet.extra > 0) && (
              <p className="grain-split">
                {grainsText(wallet.plan)} do plano · {grainsText(wallet.extra)} extras
              </p>
            )}
            <p className="bill-status">{status}</p>
          </div>
          <div className="bill-body">
            {live && sub && (
              <ul className="grain-facts">
                {sub.status === "overdue" && sub.invoiceUrl ? (
                  <li>
                    <a className="btn btn-primary bill-cta" href={sub.invoiceUrl} target="_blank" rel="noopener noreferrer">Pagar a mensalidade</a>
                  </li>
                ) : (
                  <li>
                    <span>Próxima mensalidade</span>
                    <b>{brl(sub.value)} em {ddmm(sub.nextDueDate)}</b>
                  </li>
                )}
                <li>
                  <span>Pagamento</span>
                  <b>{sub.card ? `${sub.card.brand ?? "Cartão"} final ${sub.card.last4}` : sub.method === "card" ? "Cartão de crédito" : "Pix ou boleto"}</b>
                </li>
                {sub.discount > 0 && (
                  <li>
                    <span>Desconto por indicação</span>
                    <b>{sub.discount}%</b>
                  </li>
                )}
                {sub.nextPlan && (
                  <li>
                    <span>A partir de {ddmm(sub.nextDueDate)}</span>
                    <b>{sub.nextPlan.name}</b>
                  </li>
                )}
                {sub.status === "trial" && sub.invoiceUrl && (
                  <li>
                    <a className="btn btn-primary bill-cta" href={sub.invoiceUrl} target="_blank" rel="noopener noreferrer">Pagar a primeira mensalidade</a>
                  </li>
                )}
              </ul>
            )}
            {live &&
              data.pending?.filter((p) => p.invoiceUrl).map((p) => (
                <a key={p.invoiceUrl} className="grain-pending" href={p.invoiceUrl!} target="_blank" rel="noopener noreferrer">
                  {p.kind === "pack" ? `Pacote de ${grainsText(p.grains)}` : "Troca de plano"} esperando pagamento ({brl(p.value)})
                </a>
              ))}
            <div className="grain-actions">
              {data.ledger && data.ledger.length > 0 && <button className="btn btn-ghost" onClick={() => setLedger(true)}>Ver extrato</button>}
              {live && sub && <button className="btn btn-ghost btn-danger" onClick={cancel}>Cancelar plano</button>}
            </div>
            {live && !data.ready && data.linked && <p className="help">A cobrança ainda está sendo configurada. Tente de novo mais tarde.</p>}
            {err && <ErrorBox error={err} />}
          </div>
          {live && referral && referral.step > 0 && (
            <div className="grain-ref">
              <h3>Indique e economize</h3>
              <p>
                Cada amigo que você convida e assina um plano tira {referral.step}% da sua mensalidade, até {referral.max}%.
                {referral.percent > 0 ? ` Hoje você tem ${referral.percent}% de desconto.` : ""}
              </p>
              <div className="grain-steps" role="img" aria-label={`${referral.percent}% de ${referral.max}% de desconto`}>
                {Array.from({ length: Math.max(1, Math.ceil(referral.max / referral.step)) }, (_, i) => (
                  <i key={i} className={(i + 1) * referral.step <= referral.percent ? "on" : ""} />
                ))}
              </div>
              {referral.friends.length > 0 && (
                <p className="grain-friends">
                  {referral.friends.slice(0, 8).map((f, i) => (
                    <span key={i} className={f.paying ? "on" : ""}>{f.name}</span>
                  ))}
                </p>
              )}
              <p className="help">Para convidar, peça no WhatsApp: "convida a Ana, 11 99999-9999".</p>
            </div>
          )}
        </section>

        {live && data.linked && (
          <section className="grain-shop" aria-label="Planos e pacotes">
            <h2>Planos</h2>
            <p className="muted grain-lead">Todo mês o plano recarrega seus grãos. O que sobra não acumula; os extras não vencem.</p>
            <div className="grain-plans">
              {pricing.plans.map((p) => {
                const mine = p.id === current;
                const price = priceOf(p);
                return (
                  <article key={p.id} className={`grain-plan${p.highlight ? " hl" : ""}${mine ? " mine" : ""}`}>
                    <header>
                      <h3>{p.name}</h3>
                      {mine ? <span className="badge">Seu plano</span> : p.highlight ? <span className="badge">Mais escolhido</span> : null}
                    </header>
                    <p className="grain-price">
                      {discount > 0 && price !== p.price && <s>{brl(p.price)}</s>}
                      <b>{brl(price)}</b>
                      <span>por mês</span>
                    </p>
                    <p className="grain-amount">{grainsText(p.grains)} por mês</p>
                    <p className="grain-blurb">{p.blurb}</p>
                    {!data.ready ? null : !sub ? (
                      <button className={`btn ${p.highlight ? "btn-primary" : ""}`} onClick={() => setCheckout({ kind: "plan", plan: p })}>Assinar</button>
                    ) : mine && !sub.nextPlan ? (
                      <button className="btn" disabled>Plano atual</button>
                    ) : (
                      <button className="btn" onClick={() => changePlan(p)}>
                        {mine ? "Manter este" : p.price > currentPrice ? "Subir para este" : "Mudar para este"}
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
            {pricing.packs.length > 0 && (
              <>
                <h2>Precisa de mais agora?</h2>
                <p className="muted grain-lead">Pacotes avulsos entram na hora em que o pagamento cai e não vencem.</p>
                <div className="grain-packs">
                  {pricing.packs.map((p) => (
                    <button key={p.id} className="grain-pack" disabled={!data.ready} onClick={() => setCheckout({ kind: "pack", pack: p })}>
                      <b>{grainsText(p.grains)}</b>
                      <span>{brl(p.price)}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        )}
      </div>

      {checkout && (
        <CheckoutModal
          checkout={checkout}
          needsDoc={!data.hasCustomer}
          defaultName={data.name ?? ""}
          price={checkout.kind === "plan" ? priceOf(checkout.plan) : checkout.pack.price}
          onClose={() => setCheckout(null)}
          onDone={async (message) => {
            setCheckout(null);
            setErr(message ?? null);
            await reload();
          }}
        />
      )}
      {ledger && data.ledger && (
        <Modal title="Extrato de grãos" onClose={() => setLedger(false)}>
          <ul className="grain-ledger">
            {data.ledger.map((l, i) => (
              <li key={i}>
                <span>
                  {l.label}
                  {l.note ? <small> · {l.note}</small> : null}
                </span>
                <small>{l.day ? ddmm(l.day) : shortDate(l.at)}</small>
                <b className={l.delta < 0 ? "neg" : "pos"}>
                  {l.delta > 0 ? "+" : l.delta < 0 ? "−" : ""}
                  {nf.format(Math.abs(l.delta))}
                </b>
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}

/** Assinar um plano ou comprar um pacote: forma de pagamento e, na primeira vez, nome e CPF/CNPJ para o Asaas. */
function CheckoutModal({ checkout, needsDoc, defaultName, price, onClose, onDone }: { checkout: Checkout; needsDoc: boolean; defaultName: string; price: number; onClose: () => void; onDone: (message?: string) => void }) {
  const [method, setMethod] = useState<"card" | "pix">("card");
  const [name, setName] = useState(defaultName);
  const [doc, setDoc] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const plan = checkout.kind === "plan" ? checkout.plan : null;

  const submit = async () => {
    setErr(null);
    setBusy(true);
    try {
      const who = needsDoc ? { name, cpfCnpj: doc } : {};
      const opened = await payIn(async () =>
        plan
          ? (await api<{ invoiceUrl: string | null }>("/api/billing/subscribe", { method: "POST", json: { planId: plan.id, method, ...who } })).invoiceUrl
          : (await api<{ invoiceUrl: string | null }>("/api/billing/pack", { method: "POST", json: { packId: checkout.kind === "pack" ? checkout.pack.id : "", ...who } })).invoiceUrl,
      );
      // a cobrança existe, só o link não veio: a tela avisa em vez de fechar calada
      onDone(opened ? undefined : NO_LINK);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={plan ? `Assinar o ${plan.name}` : `Pacote de ${grainsText(checkout.kind === "pack" ? checkout.pack.grains : 0)}`}
      onClose={onClose}
      footer={(close) => (
        <>
          <button className="btn btn-ghost" onClick={close}>Voltar</button>
          <button className="btn btn-primary" form="grain-checkout" disabled={busy}>{busy ? "Abrindo o pagamento…" : "Ir para o pagamento"}</button>
        </>
      )}
    >
      <form
        id="grain-checkout"
        className="grain-checkout"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="grain-total">
          <b>{brl(price)}</b>
          <span>{plan ? `por mês, com ${grainsText(plan.grains)}` : "uma vez, os grãos não vencem"}</span>
        </p>
        {plan && (
          <fieldset className="grain-methods">
            <legend>Como prefere pagar?</legend>
            <label className={method === "card" ? "on" : ""}>
              <input type="radio" name="method" value="card" checked={method === "card"} onChange={() => setMethod("card")} />
              <b>Cartão de crédito</b>
              <span>Renova sozinho todo mês. O cartão fica com o Asaas, não com a gente.</span>
            </label>
            <label className={method === "pix" ? "on" : ""}>
              <input type="radio" name="method" value="pix" checked={method === "pix"} onChange={() => setMethod("pix")} />
              <b>Pix ou boleto</b>
              <span>Você paga cada mês. Eu lembro antes de vencer.</span>
            </label>
          </fieldset>
        )}
        {!plan && <p className="help">Pix, cartão ou boleto, na página de pagamento do Asaas.</p>}
        {needsDoc && (
          <>
            <div className="field">
              <label htmlFor="grain-name">Nome completo</label>
              <input id="grain-name" className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="grain-doc">CPF ou CNPJ</label>
              <input id="grain-doc" className="input" inputMode="numeric" autoComplete="off" placeholder="000.000.000-00" value={doc} onChange={(e) => setDoc(maskDoc(e.target.value))} required />
              <div className="help">Exigido pelo Asaas para emitir a cobrança. Não fica guardado no Planejai.</div>
            </div>
          </>
        )}
        {err && <ErrorBox error={err} />}
      </form>
    </Modal>
  );
}

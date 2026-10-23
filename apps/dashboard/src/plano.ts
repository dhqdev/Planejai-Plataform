/** Uso dos grãos, do jeito que a conta e a tela Meu plano mostram ("usado 40%"). */
export interface BillingLite {
  pricing: { enabled: boolean; welcome: number; plans: { id: string; name: string; price: number; grains: number }[] };
  linked: boolean;
  exempt?: boolean;
  wallet?: { plan: number; extra: number; total: number };
  subscription?: { plan: { id: string; name: string; grains: number; price: number } | null; nextDueDate: string | null } | null;
}

export interface GrainUse {
  /** nome do plano (ou "Grátis" com os grãos de presente) */
  plan: string;
  /** parte já usada, de 0 a 1 (null = não dá para medir) */
  used: number | null;
  /** grãos que sobram */
  left: number;
  /** existe um plano acima do atual (ou ainda não assina) */
  canUpgrade: boolean;
}

/** null quando a cobrança está desligada, a pessoa é isenta ou não ligou o WhatsApp. */
export function grainUse(b: BillingLite | null | undefined): GrainUse | null {
  if (!b?.pricing?.enabled || !b.linked || b.exempt || !b.wallet) return null;
  const plan = b.subscription?.plan ?? null;
  const left = Math.max(0, b.wallet.total);
  const share = (have: number, of: number) => (of > 0 ? Math.min(1, Math.max(0, 1 - have / of)) : null);
  const canUpgrade = b.pricing.plans.some((p) => p.price > (plan?.price ?? 0));
  if (plan) return { plan: plan.name, used: share(b.wallet.plan, plan.grains), left, canUpgrade };
  return { plan: "Grátis", used: share(Math.min(left, b.pricing.welcome), b.pricing.welcome), left, canUpgrade };
}

/** 40,4% → "40%"; abaixo de 1% mostra uma casa. */
export const pct = (v: number) => `${(v * 100 < 1 && v > 0 ? (v * 100).toFixed(1) : Math.round(v * 100)).toString().replace(".", ",")}%`;

/** Link de pagamento do nosso checkout (/pagar/...): devolve o caminho para abrir aqui mesmo; página do Asaas dá null. */
export function ownPayPath(url: string | null | undefined) {
  if (!url) return null;
  try {
    const u = new URL(url, location.origin);
    return u.pathname.startsWith("/pagar/") ? u.pathname : null;
  } catch {
    return null;
  }
}

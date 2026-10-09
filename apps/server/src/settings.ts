import { config } from "./config.js";
import { many, query } from "./db/pool.js";

export interface AgentSettings {
  assistantName: string;
  /** Instruções extras de personalidade, editáveis no dashboard */
  persona: string;
  timezone: string;
  language: string;
  /** Cadastro no painel: "invite" (só com convite, padrão), "approval" (dono aprova), "open" (libera na hora) ou "closed" */
  signupMode: "invite" | "approval" | "open" | "closed";
  /** Travas de segurança */
  /** tempo máximo de uma resposta (CTO + time), em minutos */
  maxExecutionMinutes: number;
  /** ferramentas/consultas por resposta, somando o time todo */
  maxToolCalls: number;
  /** mensagens por minuto de uma pessoa antes de o agente segurar o ritmo */
  rateLimitPerMinute: number;
  /** mensagens por pessoa em 24h (0 = sem limite) */
  dailyMessageLimit: number;
  /** gasto de IA por pessoa em 24h, em dólares (0 = sem limite) */
  dailyCostLimitUsd: number;
  /** tamanho máximo de uma mensagem de texto lida pelo agente */
  maxMessageChars: number;
  /** Cobrança por grãos (créditos) no Asaas: desligada, ninguém é cobrado nem travado */
  billingEnabled: boolean;
  /** quando a cobrança foi ligada; preenchido sozinho */
  billingStartedAt: string | null;
  /** planos mensais: cada um recarrega uma quantidade de grãos a cada pagamento */
  billingPlans: BillingPlan[];
  /** pacotes avulsos de grãos (não vencem) */
  billingPacks: BillingPack[];
  /** grãos de boas-vindas que cada pessoa ganha uma vez */
  billingWelcomeGrains: number;
  /** quantos grãos custa US$ 1 de IA (custo real do OpenRouter) */
  billingGrainsPerUsd: number;
  /** desconto (%) na mensalidade por amigo convidado que paga um plano */
  billingReferralStep: number;
  /** teto do desconto por indicação (%) */
  billingReferralMax: number;
  /** quantos dias antes do vencimento lembrar quem paga por Pix/boleto (também lembra no dia) */
  billingReminderDays: number;
  /** Compras pelo assistente (o agente vai até o Pix do checkout e a pessoa paga do banco dela). Desligado, ninguém compra. */
  purchasesEnabled: boolean;
  /** teto por compra (valor da loja), em centavos */
  purchaseMaxCents: number;
  /** teto por pessoa em 30 dias, em centavos */
  purchaseMonthMaxCents: number;
  /** Quem responde pelos dados (LGPD art. 9º e 41): aparece em /privacidade */
  legalName: string;
  /** CPF ou CNPJ do responsável */
  legalDocument: string;
  /** canal do encarregado / dúvidas sobre dados */
  privacyEmail: string;
  /** cidade do foro (termos de uso) */
  legalCity: string;
}

export interface BillingPlan {
  id: string;
  name: string;
  /** reais por mês */
  price: number;
  /** grãos que o plano recarrega a cada mês pago */
  grains: number;
  /** uma frase de para quem é */
  blurb: string;
  /** o plano em destaque na vitrine */
  highlight?: boolean;
}

export interface BillingPack {
  id: string;
  grains: number;
  price: number;
}

/** Vitrine padrão: o grão sai mais barato no plano do que no avulso, para valer a pena assinar. */
export const DEFAULT_PLANS: BillingPlan[] = [
  { id: "leve", name: "Leve", price: 19.9, grains: 1500, blurb: "Gastos, lembretes e perguntas do dia a dia." },
  { id: "dia-a-dia", name: "Dia a dia", price: 39.9, grains: 4000, blurb: "Para quem usa todo dia: agenda, pesquisa e áudio.", highlight: true },
  { id: "completo", name: "Completo", price: 79.9, grains: 10000, blurb: "Time inteiro trabalhando: recados, automações e muito mais." },
];
export const DEFAULT_PACKS: BillingPack[] = [
  { id: "p500", grains: 500, price: 9.9 },
  { id: "p2000", grains: 2000, price: 34.9 },
  { id: "p5000", grains: 5000, price: 79.9 },
];

const slug = (v: unknown, i: number) =>
  String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || `item-${i + 1}`;
const money = (v: unknown) => Math.round(Number(v) * 100) / 100;

/** Planos e pacotes vindos do painel: até 4 de cada, valores dentro de faixa, ids únicos. */
export function cleanPlans(raw: unknown): BillingPlan[] {
  if (!Array.isArray(raw) || !raw.length) throw new Error("Cadastre pelo menos um plano.");
  const plans = raw.slice(0, 4).map((p: any, i) => {
    const plan: BillingPlan = {
      id: slug(p?.id || p?.name, i),
      name: String(p?.name ?? "").trim().slice(0, 30),
      price: money(p?.price),
      grains: Math.round(Number(p?.grains)),
      blurb: String(p?.blurb ?? "").trim().slice(0, 120),
      highlight: p?.highlight === true,
    };
    if (!plan.name) throw new Error("Todo plano precisa de nome.");
    if (!(plan.price >= 1 && plan.price <= 100_000)) throw new Error(`Preço do plano ${plan.name} precisa ficar entre R$ 1 e R$ 100.000.`);
    if (!(plan.grains >= 1 && plan.grains <= 10_000_000)) throw new Error(`Grãos do plano ${plan.name} precisam ficar entre 1 e 10 milhões.`);
    return plan;
  });
  if (new Set(plans.map((p) => p.id)).size !== plans.length) throw new Error("Dois planos com o mesmo nome.");
  return plans.sort((a, b) => a.price - b.price);
}

export function cleanPacks(raw: unknown): BillingPack[] {
  if (!Array.isArray(raw)) throw new Error("Pacotes inválidos.");
  const packs = raw.slice(0, 4).map((p: any, i) => {
    const pack: BillingPack = { id: "", grains: Math.round(Number(p?.grains)), price: money(p?.price) };
    pack.id = slug(p?.id || `p${pack.grains}`, i);
    if (!(pack.grains >= 1 && pack.grains <= 10_000_000)) throw new Error("Grãos do pacote precisam ficar entre 1 e 10 milhões.");
    if (!(pack.price >= 1 && pack.price <= 100_000)) throw new Error("Preço do pacote precisa ficar entre R$ 1 e R$ 100.000.");
    return pack;
  });
  if (new Set(packs.map((p) => p.id)).size !== packs.length) throw new Error("Dois pacotes iguais.");
  return packs.sort((a, b) => a.grains - b.grains);
}

/** Faixas aceitas para cada trava (o painel não deixa salvar fora disso) */
export const GUARD_LIMITS: Record<string, [number, number]> = {
  maxExecutionMinutes: [0.5, 30],
  maxToolCalls: [5, 200],
  rateLimitPerMinute: [1, 120],
  dailyMessageLimit: [0, 100_000],
  dailyCostLimitUsd: [0, 1000],
  maxMessageChars: [200, 50_000],
  billingWelcomeGrains: [0, 100_000],
  billingGrainsPerUsd: [10, 1_000_000],
  billingReferralStep: [0, 50],
  billingReferralMax: [0, 90],
  billingReminderDays: [0, 10],
  purchaseMaxCents: [500, 2_000_000],
  purchaseMonthMaxCents: [500, 10_000_000],
};

const defaults = (): AgentSettings => ({
  assistantName: "Planejai",
  persona: "",
  timezone: config.DEFAULT_TIMEZONE,
  language: "pt-BR",
  signupMode: "invite",
  maxExecutionMinutes: 8,
  maxToolCalls: 40,
  rateLimitPerMinute: 10,
  dailyMessageLimit: 300,
  dailyCostLimitUsd: 1,
  maxMessageChars: 4000,
  billingEnabled: false,
  billingStartedAt: null,
  billingPlans: DEFAULT_PLANS,
  billingPacks: DEFAULT_PACKS,
  billingWelcomeGrains: 300,
  billingGrainsPerUsd: 1000,
  billingReferralStep: 5,
  billingReferralMax: 30,
  billingReminderDays: 3,
  purchasesEnabled: false,
  purchaseMaxCents: 30_000,
  purchaseMonthMaxCents: 100_000,
  legalName: "",
  legalDocument: "",
  privacyEmail: "",
  legalCity: "",
});

let cache: { at: number; value: AgentSettings } | null = null;

export async function getSettings(): Promise<AgentSettings> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const rows = await many<{ key: string; value: any }>("SELECT key, value FROM settings");
  const value = { ...defaults() } as any;
  for (const r of rows) if (r.key in value) value[r.key] = r.value;
  cache = { at: Date.now(), value };
  return value;
}

export async function saveSettings(patch: Partial<AgentSettings>, opts: { unchecked?: boolean } = {}) {
  const allowed = Object.keys(defaults());
  // a data em que a cobrança foi ligada não vem do painel: é marcada na primeira vez que alguém liga
  const { billingStartedAt: _ignored, ...rest } = patch;
  if (rest.billingEnabled !== undefined) {
    rest.billingEnabled = rest.billingEnabled === true || (rest.billingEnabled as unknown) === "true";
    if (rest.billingEnabled && !(await getSettings()).billingStartedAt) (rest as Partial<AgentSettings>).billingStartedAt = new Date().toISOString();
  }
  if (rest.purchasesEnabled !== undefined) rest.purchasesEnabled = rest.purchasesEnabled === true || (rest.purchasesEnabled as unknown) === "true";
  if (rest.billingPlans !== undefined) rest.billingPlans = cleanPlans(rest.billingPlans);
  if (rest.billingPacks !== undefined) rest.billingPacks = cleanPacks(rest.billingPacks);
  for (const k of ["legalName", "legalDocument", "privacyEmail", "legalCity"] as const) {
    if (rest[k] !== undefined) rest[k] = String(rest[k] ?? "").trim().slice(0, 120);
  }
  for (let [k, v] of Object.entries(rest)) {
    if (!allowed.includes(k)) continue;
    if (k in GUARD_LIMITS && !opts.unchecked) {
      const [min, max] = GUARD_LIMITS[k]!;
      const n = Number(v);
      if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${k} precisa estar entre ${min} e ${max}`);
      v = n;
    }
    if (k in GUARD_LIMITS) v = Number(v);
    await query(
      "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()",
      [k, JSON.stringify(v)],
    );
  }
  cache = null;
  return getSettings();
}

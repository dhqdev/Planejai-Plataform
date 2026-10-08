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
  /** Assinatura pelo Asaas: desligada, ninguém é cobrado nem travado */
  billingEnabled: boolean;
  billingPlanName: string;
  /** preço por mês, em reais */
  billingPrice: number;
  /** dias grátis antes da primeira cobrança */
  billingTrialDays: number;
  /** quando a cobrança foi ligada (os dias grátis de quem já estava contam daqui); preenchido sozinho */
  billingStartedAt: string | null;
}

/** Faixas aceitas para cada trava (o painel não deixa salvar fora disso) */
export const GUARD_LIMITS: Record<string, [number, number]> = {
  maxExecutionMinutes: [0.5, 30],
  maxToolCalls: [5, 200],
  rateLimitPerMinute: [1, 120],
  dailyMessageLimit: [0, 100_000],
  dailyCostLimitUsd: [0, 1000],
  maxMessageChars: [200, 50_000],
  billingPrice: [1, 100_000],
  billingTrialDays: [0, 60],
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
  billingPlanName: "Planejai",
  billingPrice: 29.9,
  billingTrialDays: 3,
  billingStartedAt: null,
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
  if (rest.billingPlanName !== undefined) rest.billingPlanName = String(rest.billingPlanName).trim().slice(0, 40) || defaults().billingPlanName;
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

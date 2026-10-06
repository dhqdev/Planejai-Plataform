import { config } from "./config.js";
import { many, query } from "./db/pool.js";

export interface AgentSettings {
  assistantName: string;
  /** Instruções extras de personalidade, editáveis no dashboard */
  persona: string;
  timezone: string;
  language: string;
  /** Cadastro no painel: "approval" (dono aprova), "open" (libera na hora) ou "closed" */
  signupMode: "approval" | "open" | "closed";
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
}

/** Faixas aceitas para cada trava (o painel não deixa salvar fora disso) */
export const GUARD_LIMITS: Record<string, [number, number]> = {
  maxExecutionMinutes: [0.5, 30],
  maxToolCalls: [5, 200],
  rateLimitPerMinute: [1, 120],
  dailyMessageLimit: [0, 100_000],
  dailyCostLimitUsd: [0, 1000],
  maxMessageChars: [200, 50_000],
};

const defaults = (): AgentSettings => ({
  assistantName: "Planejai",
  persona: "",
  timezone: config.DEFAULT_TIMEZONE,
  language: "pt-BR",
  signupMode: "approval",
  maxExecutionMinutes: 8,
  maxToolCalls: 40,
  rateLimitPerMinute: 10,
  dailyMessageLimit: 300,
  dailyCostLimitUsd: 1,
  maxMessageChars: 4000,
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
  for (let [k, v] of Object.entries(patch)) {
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

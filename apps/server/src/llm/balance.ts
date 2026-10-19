import { config } from "../config.js";

export interface OpenRouterAccount {
  /** gasto acumulado informado pelo OpenRouter (créditos usados) */
  usedUsd: number | null;
  /** créditos comprados no total */
  totalUsd: number | null;
  /** saldo que ainda resta */
  remainingUsd: number | null;
  /** uso da chave configurada: hoje, no mês e desde sempre (UTC) */
  keyDayUsd: number | null;
  keyMonthUsd: number | null;
  keyTotalUsd: number | null;
  /** quando o saldo vem do limite da chave e não da conta */
  keyLimitUsd: number | null;
  error?: string;
}

const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

async function get(path: string) {
  const res = await fetch(`${config.OPENROUTER_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${config.OPENROUTER_API_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}`);
  return ((await res.json()) as any).data ?? {};
}

let cache: { at: number; value: OpenRouterAccount } | null = null;

/** Gasto e saldo direto do OpenRouter (cache de 60 s). /credits pode exigir chave de gerenciamento; /key funciona com a chave comum. */
export async function openRouterAccount(): Promise<OpenRouterAccount> {
  if (cache && Date.now() - cache.at < 60_000) return cache.value;
  const empty: OpenRouterAccount = { usedUsd: null, totalUsd: null, remainingUsd: null, keyDayUsd: null, keyMonthUsd: null, keyTotalUsd: null, keyLimitUsd: null };
  if (!config.OPENROUTER_API_KEY) return { ...empty, error: "OPENROUTER_API_KEY não configurada" };
  const [credits, key] = await Promise.allSettled([get("/credits"), get("/key")]);
  const out = { ...empty };
  if (credits.status === "fulfilled") {
    out.totalUsd = num(credits.value.total_credits);
    out.usedUsd = num(credits.value.total_usage);
    if (out.totalUsd != null && out.usedUsd != null) out.remainingUsd = out.totalUsd - out.usedUsd;
  }
  if (key.status === "fulfilled") {
    out.keyDayUsd = num(key.value.usage_daily);
    out.keyMonthUsd = num(key.value.usage_monthly);
    out.keyTotalUsd = num(key.value.usage);
    out.keyLimitUsd = num(key.value.limit);
    if (out.remainingUsd == null) out.remainingUsd = num(key.value.limit_remaining);
  }
  if (credits.status === "rejected" && key.status === "rejected") out.error = "Não consegui consultar o OpenRouter";
  else if (out.remainingUsd == null) out.error = "O OpenRouter não informou o saldo (a chave precisa de permissão de créditos)";
  // falha total não fica em cache: a próxima chamada tenta de novo
  if (!(out.error && credits.status === "rejected" && key.status === "rejected")) cache = { at: Date.now(), value: out };
  return out;
}

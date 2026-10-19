import { config } from "./config.js";
import { many, one } from "./db/pool.js";
import { openRouterAccount } from "./llm/balance.js";
import { getBoss, QUEUES } from "./queue/boss.js";

/**
 * Resumo diário do gasto de IA (OpenRouter) no WhatsApp do dono, logo depois da meia-noite: quem usou no dia
 * que acabou, quanto custou e quantos tokens. Sem IA: os números vêm de usage_daily (por pessoa) e cost_daily
 * (plataforma toda); a diferença entre os dois é o que não tem pessoa (blog, status, esteira, sistema).
 */

export interface UsageRow {
  name: string;
  costUsd: number;
  tokens: number;
}

export interface UsageSummary {
  day: string;
  totalUsd: number;
  totalTokens: number;
  calls: number;
  people: UsageRow[];
  /** custo sem pessoa: total da plataforma menos a soma das pessoas */
  systemUsd: number;
  remainingUsd: number | null;
}

const usd = (v: number) => `US$ ${v.toFixed(v >= 1 ? 2 : 4).replace(".", ",")}`;
const int = (v: number) => Math.round(v).toLocaleString("pt-BR");

export function buildUsageMessage(s: UsageSummary): string {
  const [y, m, d] = s.day.split("-");
  const lines = [`*📊 Gasto de IA em ${d}/${m}/${y}*`, ""];
  if (s.totalUsd <= 0 && s.calls === 0) {
    lines.push("Ninguém usou a chave do OpenRouter nesse dia.");
  } else {
    lines.push(`• Total: *${usd(s.totalUsd)}*`);
    lines.push(`• Tokens: ${int(s.totalTokens)} em ${int(s.calls)} chamadas`);
    if (s.people.length) {
      lines.push("", "*👥 Quem usou*");
      for (const p of s.people.slice(0, 15)) lines.push(`• ${p.name}: ${usd(p.costUsd)} (${int(p.tokens)} tokens)`);
      if (s.people.length > 15) {
        const rest = s.people.slice(15);
        lines.push(`• mais ${rest.length} pessoas: ${usd(rest.reduce((a, r) => a + r.costUsd, 0))}`);
      }
    }
    if (s.systemUsd > 0.00005) lines.push("", `*⚙️ Sistema* (blog, status, esteira)`, `• ${usd(s.systemUsd)}`);
  }
  if (s.remainingUsd != null) lines.push("", `*💳 Saldo no OpenRouter*`, `• ${usd(s.remainingUsd)}`);
  return lines.join("\n");
}

export async function usageSummary(): Promise<UsageSummary> {
  const day = (await one<{ d: string }>("SELECT (current_date - 1)::text AS d"))!.d;
  const people = await many<{ name: string | null; phone: string; cost: string; tokens: string }>(
    `SELECT u.name, u.phone, g.cost_usd AS cost, (g.tokens_in + g.tokens_out) AS tokens
       FROM usage_daily g JOIN users u ON u.id = g.user_id
      WHERE g.day = $1::date AND (g.cost_usd > 0 OR g.tokens_in + g.tokens_out > 0)
      ORDER BY g.cost_usd DESC`,
    [day],
  );
  const total = await one<{ cost: string; tin: string; tout: string; calls: number }>(
    "SELECT cost_usd AS cost, tokens_in AS tin, tokens_out AS tout, calls FROM cost_daily WHERE day = $1::date",
    [day],
  );
  const rows: UsageRow[] = people.map((p) => ({
    name: p.name?.trim() || `…${p.phone.slice(-4)}`,
    costUsd: Number(p.cost),
    tokens: Number(p.tokens),
  }));
  const totalUsd = Number(total?.cost ?? 0);
  const peopleUsd = rows.reduce((a, r) => a + r.costUsd, 0);
  const account = config.OPENROUTER_API_KEY ? await openRouterAccount().catch(() => null) : null;
  return {
    day,
    totalUsd,
    totalTokens: Number(total?.tin ?? 0) + Number(total?.tout ?? 0),
    calls: Number(total?.calls ?? 0),
    people: rows,
    systemUsd: Math.max(0, totalUsd - peopleUsd),
    remainingUsd: account?.remainingUsd ?? null,
  };
}

/** Manda o resumo do dia anterior para o primeiro número do dono (pelo mesmo envio das outras mensagens da plataforma). */
export async function sendDailyUsageReport(log?: { info: (...a: any[]) => void }) {
  const phone = config.OWNER_PHONES[0];
  if (!phone) return;
  const text = buildUsageMessage(await usageSummary());
  await (await getBoss()).send(QUEUES.outbound, { type: "send", userId: null, phone, channel: "whatsapp", text }, { retryLimit: 2 });
  log?.info("resumo diário de gasto enviado ao dono");
}

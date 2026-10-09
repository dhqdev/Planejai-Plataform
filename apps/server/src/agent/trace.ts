import { chargeUsage } from "../credits.js";
import { one, query } from "../db/pool.js";

/**
 * O log de execução não guarda dado sensível em claro: CPF, cartão e chaves viram máscara antes de ir para o banco.
 * (O texto inteiro ainda some depois de LOG_CONTENT_HOURS; isto cobre as primeiras horas.)
 */
const PERSONAL: [RegExp, string][] = [
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, "[cpf]"],
  [/\b(cpf\D{0,4})\d{11}\b/gi, "$1[cpf]"],
  [/\b(?:\d{4}[ -]){3}\d{4}(?:\d{3})?\b|\b\d{16}\b/g, "[cartão]"],
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, "[chave]"],
  [/\b(senha|password)\s*[:=]\s*[^\s"\\]+/gi, "$1: [oculta]"],
];

export function maskPersonal(text: string): string {
  let out = text;
  for (const [re, to] of PERSONAL) out = out.replace(re, to);
  return out;
}

function maskDeep(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return value.length > 200_000 ? value : maskPersonal(value);
  try {
    const s = JSON.stringify(value);
    if (s.length > 200_000) return value;
    return JSON.parse(maskPersonal(s));
  } catch {
    return value;
  }
}

export type StepType = "llm" | "tool" | "delegate" | "channel" | "info";

/** Limita o tamanho do que vai para o log (base64 de mídia, páginas enormes etc.) */
export function clip(value: unknown, max = 20_000): unknown {
  if (value == null) return value;
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (s.length <= max) return typeof value === "string" ? value : JSON.parse(s);
  return { truncated: true, preview: s.slice(0, max) };
}

export interface StepHandle {
  id: number;
  ok(output?: unknown, usage?: { model?: string; tokensIn?: number; tokensOut?: number; costUsd?: number }): Promise<void>;
  fail(error: unknown): Promise<void>;
}

/** Registra uma execução (uma "rodada" do agente) e cada passo dela, para o dashboard. */
export class Tracer {
  private constructor(
    readonly executionId: string,
    readonly userId: string | null,
    /** trabalho da própria plataforma (melhoria noturna): conta o custo, mas não tira grãos da pessoa */
    readonly noCharge = false,
  ) {}

  static async start(opts: { trigger: string; userId?: string | null; conversationId?: string | null; input?: string; noCharge?: boolean }) {
    const row = await one<{ id: string }>(
      "INSERT INTO executions (trigger, user_id, conversation_id, input) VALUES ($1, $2, $3, $4) RETURNING id",
      [opts.trigger, opts.userId ?? null, opts.conversationId ?? null, opts.input == null ? null : maskPersonal(opts.input)],
    );
    if (opts.userId) {
      await query(
        "INSERT INTO usage_daily (user_id, day, executions) VALUES ($1, current_date, 1) ON CONFLICT (user_id, day) DO UPDATE SET executions = usage_daily.executions + 1",
        [opts.userId],
      ).catch(() => {});
    }
    return new Tracer(row!.id, opts.userId ?? null, Boolean(opts.noCharge));
  }

  async step(opts: { agent: string; type: StepType; name: string; input?: unknown; parentId?: number | null; model?: string }): Promise<StepHandle> {
    const started = Date.now();
    const row = await one<{ id: number }>(
      `INSERT INTO execution_steps (execution_id, parent_id, agent, type, name, model, input)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [this.executionId, opts.parentId ?? null, opts.agent, opts.type, opts.name, opts.model ?? null, JSON.stringify(clip(maskDeep(opts.input)) ?? null)],
    );
    const id = row!.id;
    const execId = this.executionId;
    const userId = this.userId;
    const charge = !this.noCharge;
    return {
      id,
      async ok(output, usage) {
        await query(
          `UPDATE execution_steps SET status = 'success', output = $2, model = COALESCE($3, model),
             tokens_in = $4, tokens_out = $5, cost_usd = $6, duration_ms = $7 WHERE id = $1`,
          [id, JSON.stringify(clip(maskDeep(output)) ?? null), usage?.model ?? null, usage?.tokensIn ?? 0, usage?.tokensOut ?? 0, usage?.costUsd ?? 0, Date.now() - started],
        );
        if (usage && (usage.tokensIn || usage.tokensOut || usage.costUsd)) {
          await query(
            "UPDATE executions SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3, cost_usd = cost_usd + $4 WHERE id = $1",
            [execId, usage.tokensIn ?? 0, usage.tokensOut ?? 0, usage.costUsd ?? 0],
          );
          // custo por pessoa por dia: fica depois que o log some (gráfico de custo por cliente)
          if (userId) {
            await query(
              `INSERT INTO usage_daily (user_id, day, tokens_in, tokens_out, cost_usd) VALUES ($1, current_date, $2, $3, $4)
               ON CONFLICT (user_id, day) DO UPDATE SET tokens_in = usage_daily.tokens_in + $2, tokens_out = usage_daily.tokens_out + $3, cost_usd = usage_daily.cost_usd + $4`,
              [userId, usage.tokensIn ?? 0, usage.tokensOut ?? 0, usage.costUsd ?? 0],
            ).catch(() => {});
            // grãos: o custo real deste passo sai da carteira da pessoa (cobrança desligada não faz nada)
            if (usage.costUsd && charge) void chargeUsage(userId, usage.costUsd).catch(() => {});
          }
        }
      },
      async fail(error) {
        await query("UPDATE execution_steps SET status = 'error', error = $2, duration_ms = $3 WHERE id = $1", [
          id,
          error instanceof Error ? error.message : String(error),
          Date.now() - started,
        ]);
      },
    };
  }

  /** Fim da execução. `partial` = respondeu, mas parou no meio (o motivo aparece em Execuções como "Parcial"). */
  async finish(output: string | null, partial?: string | null) {
    await query(
      `UPDATE executions SET status = $3, output = $2, error = $4, finished_at = now(),
         duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int WHERE id = $1`,
      [this.executionId, output == null ? null : maskPersonal(output), partial ? "partial" : "success", partial ?? null],
    );
  }

  async error(err: unknown) {
    await query(
      `UPDATE executions SET status = 'error', error = $2, finished_at = now(),
         duration_ms = (EXTRACT(EPOCH FROM (now() - started_at)) * 1000)::int WHERE id = $1`,
      [this.executionId, err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)],
    );
  }
}

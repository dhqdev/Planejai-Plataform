import { getSubscription, hasPlan } from "./billing.js";
import { grainsExempt, grainsLink, hasPaid, planById, plansOf, trialEndsAt } from "./credits.js";
import { type AgentSettings, type PlanLevel, PLAN_LEVELS, getSettings, levelOf } from "./settings.js";

/**
 * O que o plano da pessoa libera (escolha do David em 2026-10-20). Regra única, no servidor: o orquestrador monta o time
 * e as ferramentas por aqui, a loja e o agente sob medida conferem aqui, e o painel mostra o cadeado com o mesmo resultado.
 * Cobrança desligada, dono, pessoa liberada e período livre veem tudo (o período livre mostra o time para ela sentir falta).
 * Sem plano: quem já pagou pacote fica no nível do time; quem nunca pagou fica no básico.
 */
export interface PlanAccess {
  level: PlanLevel;
  /** quantos especialistas da loja valem ao mesmo tempo */
  storeMax: number;
  /** agente sob medida (pedido na conversa ou criado na reunião da noite) */
  customAgents: boolean;
}

const LIMITS: Record<PlanLevel, Omit<PlanAccess, "level">> = {
  basico: { storeMax: 0, customAgents: false },
  time: { storeMax: 2, customAgents: false },
  completo: { storeMax: 6, customAgents: true },
};

/** Especialista fixo que só entra no Completo (Notion, GitHub, n8n). */
export const COMPLETO_SPECIALISTS = new Set(["produtividade"]);
/** Especialista da loja que só entra no Completo (Secretária de reuniões). */
export const COMPLETO_STORE = new Set(["reunioes"]);

export const accessFor = (level: PlanLevel): PlanAccess => ({ level, ...LIMITS[level] });
export const levelAtLeast = (have: PlanLevel, need: PlanLevel) => PLAN_LEVELS.indexOf(have) >= PLAN_LEVELS.indexOf(need);

export async function planAccess(user: any, s?: AgentSettings): Promise<PlanAccess> {
  s ??= await getSettings();
  if (grainsExempt(user, s) || trialEndsAt(user, s)) return accessFor("completo");
  const sub = await getSubscription(user.id);
  const plan = hasPlan(sub) ? planById(s, sub.plan_id) : null;
  if (plan) return accessFor(levelOf(plan));
  return accessFor((await hasPaid(user.id)) ? "time" : "basico");
}

/** Plano mais barato da vitrine que libera esse nível (para o "isso entra no plano X"). */
export function planFor(s: AgentSettings, need: PlanLevel) {
  return plansOf(s)
    .filter((p) => levelAtLeast(levelOf(p), need))
    .sort((a, b) => a.price - b.price)[0] ?? null;
}

/** Linha do prompt do Juvenal no básico: ele atende sozinho e diz com gentileza o que é de outro plano. */
export function basicPlanLine(s: AgentSettings) {
  const next = planFor(s, "time");
  return (
    `- Plano desta pessoa: ${planName(s, "basico")}. Você atende sozinho, sem time (não existe ask_*): gastos, cartões, contas fixas, categorias, lembretes e agenda. ` +
    `Pesquisa na internet, mensagem para outra pessoa, recado, imagem, PDF, áudio, De olho e especialistas não estão no plano dela: ` +
    `diga isso numa frase gentil, sem prometer e sem tentar fazer${next ? `, que isso entra no plano ${next.name}` : ""}, e mande o link ${grainsLink()}. ` +
    "Não repita o convite na mesma conversa se ela já ouviu."
  );
}

function planName(s: AgentSettings, level: PlanLevel) {
  return plansOf(s).find((p) => levelOf(p) === level)?.name ?? "básico";
}

/**
 * Agentes da pessoa que valem neste plano: no básico nenhum; no time, só os da loja (até storeMax, os mais antigos primeiro,
 * sem os exclusivos do Completo); no Completo, todos. Quem passou do limite continua guardado e volta se ela subir de plano.
 */
export function allowedClientRows<T extends { slug: string; origin?: string | null }>(rows: T[], access: PlanAccess): T[] {
  if (access.level === "completo") return rows;
  if (access.level === "basico") return [];
  return rows.filter((r) => r.origin === "loja" && !COMPLETO_STORE.has(r.slug)).slice(0, access.storeMax);
}

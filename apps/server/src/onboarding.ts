import { one, query } from "./db/pool.js";

/**
 * Perguntas de boas-vindas do cadastro. Cada resposta pode abrir outras (`when`), então
 * o painel mostra uma de cada vez e pula as que não se aplicam. O servidor guarda só um
 * resumo de uma linha em users.profile.onboarding, que entra no prompt do CTO (pouco token).
 */
export interface OnboardingOption {
  id: string;
  label: string;
}
export interface OnboardingQuestion {
  id: string;
  text: string;
  hint?: string;
  kind: "one" | "many" | "text";
  /** rótulo curto que entra no resumo para o agente */
  about: string;
  options?: OnboardingOption[];
  /** só aparece se a pergunta `q` tiver alguma das respostas em `any` */
  when?: { q: string; any: string[] };
}

const o = (id: string, label: string): OnboardingOption => ({ id, label });

export const ONBOARDING: OnboardingQuestion[] = [
  {
    id: "goal",
    text: "No que você quer que eu te ajude primeiro?",
    hint: "Pode escolher mais de um.",
    kind: "many",
    about: "Quer ajuda com",
    options: [o("money", "Organizar meu dinheiro"), o("agenda", "Agenda e lembretes"), o("work", "Trabalho ou negócio"), o("habits", "Hábitos e rotina"), o("study", "Estudos")],
  },
  {
    id: "money_now",
    text: "Como está o dinheiro no fim do mês hoje?",
    kind: "one",
    about: "Fim do mês",
    when: { q: "goal", any: ["money"] },
    options: [o("left", "Sobra um pouco"), o("even", "Fica no zero a zero"), o("short", "Falta, ou tenho dívidas"), o("unknown", "Não faço ideia")],
  },
  {
    id: "debt_plan",
    text: "Quer que eu monte com você um plano pra sair das dívidas?",
    kind: "one",
    about: "Plano de dívidas",
    when: { q: "money_now", any: ["short"] },
    options: [o("yes", "Quero"), o("later", "Mais pra frente")],
  },
  {
    id: "money_goal",
    text: "E tem algum objetivo com o dinheiro?",
    kind: "many",
    about: "Objetivo financeiro",
    when: { q: "money_now", any: ["left", "even", "unknown"] },
    options: [o("reserve", "Reserva de emergência"), o("trip", "Viagem"), o("house", "Casa ou carro"), o("invest", "Começar a investir"), o("control", "Só saber pra onde vai")],
  },
  {
    id: "income",
    text: "Como você ganha dinheiro?",
    kind: "one",
    about: "Renda",
    when: { q: "goal", any: ["money", "work"] },
    options: [o("salary", "Salário fixo"), o("freela", "Autônomo ou freela"), o("business", "Tenho empresa"), o("mixed", "Um pouco de cada"), o("none", "Ainda não tenho renda")],
  },
  {
    id: "split",
    text: "Quer separar as contas da empresa das suas?",
    kind: "one",
    about: "Separar empresa e pessoal",
    when: { q: "income", any: ["business", "mixed"] },
    options: [o("yes", "Sim, misturo tudo hoje"), o("already", "Já são separadas")],
  },
  {
    id: "forget",
    text: "O que mais costuma escapar da sua cabeça?",
    hint: "Pode escolher mais de um.",
    kind: "many",
    about: "Costuma esquecer",
    when: { q: "goal", any: ["agenda", "work", "study"] },
    options: [o("bills", "Contas pra pagar"), o("meetings", "Compromissos"), o("birthdays", "Aniversários"), o("meds", "Remédios"), o("tasks", "Tarefas do dia")],
  },
  {
    id: "habit",
    text: "Que hábito você quer criar?",
    kind: "many",
    about: "Hábito que quer criar",
    when: { q: "goal", any: ["habits"] },
    options: [o("exercise", "Exercício"), o("water", "Beber água"), o("reading", "Leitura"), o("sleep", "Dormir mais cedo"), o("meditate", "Meditar")],
  },
  {
    id: "home",
    text: "Com quem você mora?",
    kind: "one",
    about: "Mora",
    options: [o("alone", "Sozinho(a)"), o("partner", "Com companheiro(a)"), o("kids", "Com filhos"), o("parents", "Com a família"), o("friends", "Dividindo com amigos")],
  },
  {
    id: "shared",
    text: "As contas da casa são divididas?",
    kind: "one",
    about: "Contas da casa",
    when: { q: "home", any: ["partner", "kids", "friends"] },
    options: [o("split", "Sim, a gente divide"), o("me", "Eu pago tudo"), o("other", "Outra pessoa paga")],
  },
  {
    id: "tone",
    text: "Como você prefere que eu fale com você?",
    kind: "one",
    about: "Prefere conversa",
    options: [o("short", "Direto e curto"), o("detail", "Com explicação"), o("fun", "Descontraído, com emoji")],
  },
  {
    id: "more",
    text: "Quer me contar mais alguma coisa?",
    hint: "Opcional. Ex.: trabalho de noite, tenho um cachorro, recebo dia 5.",
    kind: "text",
    about: "Contou",
  },
];

export type OnboardingAnswers = Record<string, string | string[]>;

/** Perguntas que valem para estas respostas, na ordem (as condicionais só depois do pai). */
export function activeQuestions(answers: OnboardingAnswers) {
  return ONBOARDING.filter((q) => {
    if (!q.when) return true;
    const a = answers[q.when.q];
    const picked = Array.isArray(a) ? a : a ? [a] : [];
    return picked.some((p) => q.when!.any.includes(p));
  });
}

/** Limpa o que veio do painel: só pergunta e opção que existem, e só as que valem para o caminho escolhido. */
export function cleanAnswers(raw: unknown): OnboardingAnswers {
  const input = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: OnboardingAnswers = {};
  for (const q of ONBOARDING) {
    if (!activeQuestions(out).includes(q)) continue;
    const v = input[q.id];
    if (q.kind === "text") {
      const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 300) : "";
      if (t) out[q.id] = t;
      continue;
    }
    const ids = new Set(q.options!.map((x) => x.id));
    const picked = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string" && ids.has(x));
    if (!picked.length) continue;
    out[q.id] = q.kind === "one" ? picked[0] : [...new Set(picked)];
  }
  return out;
}

/** Uma linha para o agente: "Quer ajuda com: Organizar meu dinheiro, Agenda e lembretes. Fim do mês: Falta, ou tenho dívidas. ..." */
export function onboardingSummary(answers: OnboardingAnswers) {
  const parts: string[] = [];
  for (const q of activeQuestions(answers)) {
    const v = answers[q.id];
    if (!v) continue;
    const text = q.kind === "text" ? String(v) : (Array.isArray(v) ? v : [v]).map((id) => q.options!.find((x) => x.id === id)?.label ?? id).join(", ");
    parts.push(`${q.about}: ${text}`);
  }
  return parts.join(". ");
}

export async function getOnboarding(userId: string) {
  const row = await one("SELECT profile->'onboarding' AS ob FROM users WHERE id = $1", [userId]);
  return (row?.ob ?? null) as { answers?: OnboardingAnswers; summary?: string; skipped?: boolean; at?: string } | null;
}

export async function saveOnboarding(userId: string, raw: unknown, skipped = false) {
  const answers = skipped ? {} : cleanAnswers(raw);
  const value = { answers, summary: onboardingSummary(answers), skipped: skipped || !Object.keys(answers).length, at: new Date().toISOString() };
  await query("UPDATE users SET profile = profile || jsonb_build_object('onboarding', $2::jsonb) WHERE id = $1", [userId, JSON.stringify(value)]);
  return value;
}

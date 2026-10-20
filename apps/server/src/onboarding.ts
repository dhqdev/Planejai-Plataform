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

/**
 * Poucas perguntas (pedido do David em 2026-10-20: "faça menos perguntas, está muito demorado"): o que quer primeiro,
 * no máximo uma pergunta a mais por assunto escolhido e o jeito de falar. Quem marca tudo responde 5; o normal é 3.
 */
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
    id: "money_goal",
    text: "E o que você quer com o dinheiro?",
    kind: "one",
    about: "Objetivo financeiro",
    when: { q: "goal", any: ["money"] },
    options: [o("debt", "Sair das dívidas"), o("reserve", "Ter uma reserva"), o("trip", "Juntar pra algo"), o("invest", "Começar a investir"), o("control", "Saber pra onde vai")],
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
    id: "tone",
    text: "Como você prefere que eu fale com você?",
    kind: "one",
    about: "Prefere conversa",
    options: [o("short", "Direto e curto"), o("detail", "Com explicação"), o("fun", "Descontraído, com emoji")],
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

/** Exemplos para a primeira mensagem, pelo que a pessoa quer primeiro (o primeiro de cada assunto escolhido). */
const TRY: Record<string, string> = {
  money: "gastei 42 no mercado",
  agenda: "me lembra amanhã às 9h do dentista",
  work: "anota reunião com o cliente quinta às 15h",
  habits: "me lembra de beber água às 10h todo dia",
  study: "me explica juros compostos de um jeito simples",
};

/** Boas-vindas no WhatsApp ao terminar a primeira conversa no painel. Texto fixo, sem IA (pouco token). */
export function welcomeText(name: string | null | undefined, answers: OnboardingAnswers = {}, assistant = "Bolinho") {
  const first = (name ?? "").trim().split(/\s+/)[0];
  const goals = (Array.isArray(answers.goal) ? answers.goal : []).filter((g) => TRY[g]);
  const tries = [...new Set([...goals.map((g) => TRY[g]!), TRY.money!, TRY.agenda!])].slice(0, 3);
  const fun = answers.tone === "fun";
  return [
    `Oi${first ? `, ${first}` : ""}! ${fun ? "🎉 " : ""}Aqui é o ${assistant}, do Planejai. Seu cadastro ficou pronto!`,
    "",
    "A partir de agora é só falar comigo por aqui, do jeito que você mandaria pra um amigo: texto, áudio ou foto.",
    "",
    "*Pra começar, tenta mandar:*",
    ...tries.map((t) => `• "${t}"`),
    "",
    "Salva este número nos seus contatos pra não perder nenhum aviso.",
  ].join("\n");
}

/** Marca e devolve true só na primeira vez (duas abas ou dois cliques não mandam duas mensagens). */
export async function claimWelcome(userId: string) {
  const row = await one(
    "UPDATE users SET profile = profile || jsonb_build_object('welcome_sent_at', now()) WHERE id = $1 AND NOT (profile ? 'welcome_sent_at') RETURNING id",
    [userId],
  );
  return Boolean(row);
}

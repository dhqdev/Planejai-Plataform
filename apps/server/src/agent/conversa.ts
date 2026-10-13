import { STORE } from "./store.js";

/**
 * Quem pode conversar com uma pessoa a pedido do dono (conversa delegada, errands.kind = 'conversa').
 * Os modelos da loja (saúde, pet, estudos...) emprestam nome e foco mesmo sem estarem ligados no time da pessoa;
 * "geral" é o Juvenal, para conversa sem assunto de especialista.
 */
export interface ConversaAgent {
  slug: string;
  persona: string;
  name: string;
  focus: string;
}

const GENERAL: ConversaAgent = {
  slug: "geral",
  // o mesmo nome do CTO (team.ts); escrito aqui porque team.ts importa as ferramentas que importam este arquivo
  persona: "Juvenal",
  name: "Geral",
  focus: "conversar com acolhimento e ajudar no que a pessoa precisar",
};

export const CONVERSA_AGENTS: ConversaAgent[] = [GENERAL, ...STORE.map((s) => ({ slug: s.slug, persona: s.persona, name: s.name, focus: s.focus }))];

export const conversaAgent = (slug?: string | null) => CONVERSA_AGENTS.find((a) => a.slug === slug) ?? GENERAL;

/** Regras extras por assunto. Saúde: orientação geral, nunca diagnóstico nem remédio, e urgência vai para o SAMU. */
const EXTRA: Record<string, string> = {
  saude:
    "- Você NÃO é médico: dê só orientação geral e acolhimento (repouso, água, observar sintomas, procurar atendimento). Nunca diagnostique, nunca indique remédio nem dose.\n" +
    "- Pergunte com calma o que a pessoa sente, desde quando e se está sozinha. Uma pergunta por vez.\n" +
    "- Sinal de gravidade (dor no peito, falta de ar, desmaio, convulsão, sangramento forte, rosto torto ou fala enrolada, febre muito alta com confusão, gestante com sangramento): " +
    "diga para ligar AGORA para o SAMU (192) ou ir ao pronto-socorro, e chame conversa_alert.\n" +
    "- Sofrimento emocional ou fala de se machucar: acolha sem julgar, sugira o CVV (188, 24h, ligação gratuita) e chame conversa_alert.",
};

const BASE_SAFETY =
  "- Emergência de qualquer tipo (saúde, violência, risco de vida): oriente ligar para o SAMU (192), a Polícia (190) ou os Bombeiros (193), e chame conversa_alert. " +
  "Fala de se machucar: acolha e sugira o CVV (188), e chame conversa_alert.";

export function conversaRules(a: ConversaAgent) {
  // as instructions da loja são para atender o próprio dono (com lembretes e ferramentas); aqui vale só o foco
  return [EXTRA[a.slug] ?? "", BASE_SAFETY].filter(Boolean).join("\n");
}

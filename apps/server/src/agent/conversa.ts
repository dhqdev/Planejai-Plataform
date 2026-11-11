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
  /** personalidade: jeito de falar e o que costuma mandar (áudio, foto, PDF, figurinha) */
  style: string;
}

/**
 * Personalidade de cada um na conversa delegada: curta, porque vai em toda vez do agente (pouco token).
 * Nome e foco vêm da loja (store.ts); quem não tem linha aqui fica com o jeito do Juvenal.
 */
const STYLE: Record<string, string> = {
  geral: "animado e acolhedor, fala como um amigo prestativo, de bom humor na medida certa; manda figurinha quando o clima é leve",
  saude:
    "calma, carinhosa e firme como uma enfermeira experiente de posto de saúde; chama de 'querida/querido' só se a pessoa der abertura; " +
    "manda um passo a passo em imagem (ex.: como se hidratar, sinais de alerta) quando ajuda",
  treino: "energia lá em cima, motivadora, comemora cada passo ('isso aí!'); manda o treino em imagem ou PDF e GIF de incentivo",
  estudos: "professor paciente e didático, explica com exemplo do dia a dia e faz uma pergunta para conferir; manda resumo ou mapa mental em imagem e PDF",
  pet: "senhora carinhosa que ama bicho, fala do pet pelo nome; manda passo a passo em imagem e figurinha fofa",
  viagens: "viajante experiente e contador de história, dá dica prática; manda roteiro em PDF e foto do lugar",
  cozinha: "tia acolhedora de cozinha, fala de comida com gosto; manda receita em imagem ou PDF e foto do prato",
  casa: "senhor prático e cuidadoso, resolve sem enrolar; manda passo a passo em imagem",
  carro: "mecânico de confiança, direto e honesto, explica sem termo difícil; manda checklist em imagem",
};

const GENERAL: ConversaAgent = {
  slug: "geral",
  // o mesmo nome do CTO (team.ts); escrito aqui porque team.ts importa as ferramentas que importam este arquivo
  persona: "Juvenal",
  name: "Geral",
  focus: "conversar com acolhimento e ajudar no que a pessoa precisar",
  style: STYLE.geral!,
};

export const CONVERSA_AGENTS: ConversaAgent[] = [GENERAL, ...STORE.map((s) => ({ slug: s.slug, persona: s.persona, name: s.name, focus: s.focus, style: STYLE[s.slug] ?? STYLE.geral! }))];

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

/**
 * O que cada plano dá, em palavras para o cliente (landing, página de preços, Meu plano e a tela de assinar).
 * É a mesma verdade que `planAccess` (plan-access.ts) aplica: mudou um, mude o outro. `values` segue a ordem basico, time, completo;
 * texto vira "até 2" e `false`, "não tem". `short` é o rótulo curto dos cartões.
 */
export interface PlanFeature {
  label: string;
  short: string;
  values: [boolean | string, boolean | string, boolean | string];
}
export const PLAN_FEATURES: PlanFeature[] = [
  { label: "Gastos, cartões e contas fixas pelo WhatsApp", short: "Gastos e cartões", values: [true, true, true] },
  { label: "Lembretes, agenda e Google Agenda", short: "Lembretes e agenda", values: [true, true, true] },
  { label: "Painel com agenda, finanças e documentos", short: "Painel completo", values: [true, true, true] },
  { label: "Foto, áudio e comprovante viram anotação", short: "Foto e comprovante", values: [true, true, true] },
  { label: "Limites, metas e gráficos pelo WhatsApp", short: "Limites, metas e gráficos", values: [false, true, true] },
  { label: "Time de agentes trabalhando junto", short: "Time de agentes", values: [false, true, true] },
  { label: "Pesquisa na internet, menor preço e De olho", short: "Pesquisa e menor preço", values: [false, true, true] },
  { label: "Mensagens e recados para outras pessoas", short: "Mensagens e recados", values: [false, true, true] },
  { label: "Criar PDF, imagem e áudio", short: "PDF, imagem e áudio", values: [false, true, true] },
  { label: "Especialistas da loja (treino, estudos, pet...)", short: "Especialistas da loja", values: [false, "até 2", "até 6"] },
  { label: "Secretária de reuniões do Meet", short: "Secretária de reuniões", values: [false, false, true] },
  { label: "Notion, GitHub e n8n", short: "Notion, GitHub e n8n", values: [false, false, true] },
  { label: "Agentes criados sob medida para você", short: "Agentes sob medida", values: [false, false, true] },
  { label: "Voz caprichada nos áudios", short: "Voz caprichada", values: [false, false, true] },
];

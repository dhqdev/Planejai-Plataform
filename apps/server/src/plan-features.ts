/**
 * O que todo plano inclui, em palavras para o cliente (landing, página de preços e Meu plano). Desde 2026-10-23 os planos
 * mudam só no preço e nos grãos: tudo aqui vale para todos, inclusive no período grátis. `short` é o rótulo curto dos cartões.
 */
export interface PlanFeature {
  label: string;
  short: string;
}
export const PLAN_FEATURES: PlanFeature[] = [
  { label: "Gastos, cartões, contas fixas, limites e metas pelo WhatsApp", short: "Finanças completas" },
  { label: "Lembretes, agenda e Google Agenda", short: "Lembretes e agenda" },
  { label: "Time de agentes trabalhando junto", short: "Time de agentes" },
  { label: "Pesquisa na internet, menor preço e De olho", short: "Pesquisa e menor preço" },
  { label: "Mensagens e recados para outras pessoas", short: "Mensagens e recados" },
  { label: "Criar PDF, imagem e áudio, com voz caprichada", short: "PDF, imagem e áudio" },
  { label: "Especialistas da loja e agentes sob medida", short: "Especialistas e agentes sob medida" },
  { label: "Secretária de reuniões do Meet", short: "Secretária de reuniões" },
  { label: "Notion, GitHub e n8n", short: "Notion, GitHub e n8n" },
  { label: "Painel com agenda, finanças e documentos", short: "Painel completo" },
];

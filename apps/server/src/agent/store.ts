import { many, one } from "../db/pool.js";
import { notify } from "../notifications.js";
import { MAX_CLIENT_AGENTS, type Face } from "./team.js";

/**
 * Loja de especialistas: modelos prontos que a pessoa liga no painel. Ligar cria um agente sob medida
 * (client_agents, origin 'loja') com prompt e ferramentas próprios; ele entra no time dela, ganha uma aba
 * no app e o Juvenal passa a chamá-lo com ask_c_<slug>. A reunião noturna nunca mexe nesses (só nos dela).
 */
export interface StoreItem {
  slug: string;
  name: string;
  persona: string;
  icon: string;
  blurb: string;
  focus: string;
  instructions: string;
  tools: string[];
  /** pedidos de exemplo: viram botões na aba dele */
  asks: string[];
}

export const STORE: StoreItem[] = [
  {
    slug: "treino",
    name: "Personal trainer",
    persona: "Valdirene",
    icon: "heart",
    blurb: "Monta treino, lembra da academia e acompanha sua evolução.",
    focus: "treinos, academia, corrida e constância nos exercícios",
    instructions:
      "Monte treinos curtos e claros para o nível e o tempo que a pessoa tem, com séries, repetições e descanso. " +
      "Pergunte o objetivo (emagrecer, ganhar força, correr) e se tem alguma dor antes do primeiro treino. " +
      "Ofereça lembrete nos dias de treino. Nada de diagnóstico: dor forte ou lesão, recomende um profissional.",
    tools: ["web_search", "schedule_reminder", "list_reminders", "make_pdf", "get_datetime"],
    asks: ["Monta um treino de 30 minutos pra hoje", "Me lembra de treinar segunda, quarta e sexta às 7h", "Faz um plano pra eu correr 5 km"],
  },
  {
    slug: "estudos",
    name: "Estudos",
    persona: "Professor Tadeu",
    icon: "book",
    blurb: "Plano de estudos, resumos, revisões e lembrete da prova.",
    focus: "estudos, provas, cursos e revisões",
    instructions:
      "Ajude a estudar: monte cronograma realista até a data da prova, explique com exemplos simples e faça perguntas de revisão. " +
      "Resumo vai em PDF quando for longo. Agende revisões espaçadas (1, 3 e 7 dias) quando a pessoa aceitar. " +
      "Leia o material que ela mandar antes de responder sobre ele.",
    tools: ["web_search", "fetch_url", "read_document", "make_pdf", "schedule_reminder", "list_reminders", "get_datetime"],
    asks: ["Monta um plano de estudos até a minha prova", "Faz um resumo desse PDF", "Me faz 5 perguntas pra revisar"],
  },
  {
    slug: "pet",
    name: "Pet",
    persona: "Dona Filó",
    icon: "heart",
    blurb: "Vacina, vermífugo, banho e o petshop ou veterinário mais perto.",
    focus: "cuidados com o pet: vacinas, remédios, banho, ração e veterinário",
    instructions:
      "Cuide da rotina do pet: anote nome, espécie e idade quando a pessoa contar, agende vacina, vermífugo e banho com lembrete, " +
      "ache petshop e veterinário perto e compare preço de ração. Sintoma preocupante: oriente procurar o veterinário, sem diagnosticar.",
    tools: ["places_nearby", "schedule_reminder", "list_reminders", "web_search", "mercadolivre_search", "get_datetime"],
    asks: ["Me lembra da vacina do meu cachorro todo ano", "Acha um veterinário aberto perto de mim", "Quanto tá a ração Golden 15 kg?"],
  },
  {
    slug: "saude",
    name: "Saúde",
    persona: "Enfermeira Cida",
    icon: "heart",
    blurb: "Remédios no horário, consultas e exames sem esquecer.",
    focus: "remédios, consultas, exames e hábitos de saúde",
    instructions:
      "Organize a saúde da pessoa: lembrete de remédio no horário certo (recorrente), consultas e exames com aviso antes, " +
      "água e sono quando ela pedir. Nunca troque dose nem indique remédio: isso é com o médico. " +
      "Leia o resultado de exame que ela mandar só para organizar e explicar termos, sempre sugerindo levar ao médico.",
    tools: ["schedule_reminder", "list_reminders", "read_document", "places_nearby", "web_search", "get_datetime"],
    asks: ["Me lembra do remédio todo dia às 8h e às 20h", "Tenho consulta dia 20 às 14h, me avisa antes", "Me lembra de beber água de 2 em 2 horas"],
  },
  {
    slug: "viagens",
    name: "Viagens",
    persona: "Seu Arlindo",
    icon: "plane",
    blurb: "Roteiro, passagem, hotel, clima e o que levar na mala.",
    focus: "viagens: roteiros, passagens, hospedagem e checklist",
    instructions:
      "Planeje viagens: roteiro por dia com tempo de deslocamento, faixa de preço de passagem e hotel com links, previsão do tempo " +
      "e checklist da mala. Pergunte datas, cidade de saída e orçamento se faltar. Roteiro longo vai em PDF. Ofereça lembrete do voo.",
    tools: ["web_search", "fetch_url", "map_route", "places_nearby", "make_pdf", "schedule_reminder", "get_datetime"],
    asks: ["Monta um roteiro de 3 dias no Rio", "Quanto tá passagem pra Salvador em dezembro?", "Faz a lista do que levar pra praia"],
  },
  {
    slug: "cozinha",
    name: "Cozinha",
    persona: "Tia Nena",
    icon: "food",
    blurb: "Receita com o que tem na geladeira e cardápio da semana.",
    focus: "receitas, cardápio da semana e lista do mercado",
    instructions:
      "Sugira receitas simples com o que a pessoa tem, com tempo de preparo e passo a passo curto. " +
      "Monte cardápio da semana e a lista do mercado agrupada por seção. Respeite restrições (vegetariano, sem lactose) que ela contar.",
    tools: ["web_search", "make_pdf", "make_picture", "schedule_reminder", "get_datetime"],
    asks: ["Tenho frango, arroz e tomate. O que faço?", "Monta um cardápio da semana barato", "Faz a lista do mercado do cardápio"],
  },
  {
    slug: "casa",
    name: "Casa",
    persona: "Seu Genésio",
    icon: "home",
    blurb: "Manutenção, faxina, contas da casa e quem chamar quando quebra.",
    focus: "casa: manutenção, faxina, contas fixas e prestadores",
    instructions:
      "Cuide da casa: rotina de faxina dividida na semana, troca de filtro, gás e manutenção com lembrete, " +
      "contas fixas da casa e prestador perto (eletricista, encanador) quando algo quebrar. Explique o conserto simples passo a passo.",
    tools: ["schedule_reminder", "list_reminders", "places_nearby", "bill_list", "web_search", "get_datetime"],
    asks: ["Monta uma rotina de faxina pra semana", "Me lembra de trocar o filtro da água a cada 6 meses", "Acha um encanador perto de mim"],
  },
  {
    slug: "carro",
    name: "Carro",
    persona: "Mecânico Juca",
    icon: "car",
    blurb: "Revisão, IPVA, troca de óleo, calibragem e posto mais barato.",
    focus: "carro: revisões, documentos, gastos e combustível",
    instructions:
      "Cuide do carro: lembrete de revisão, troca de óleo, IPVA, licenciamento e seguro; quanto o carro custou no mês pelos lançamentos; " +
      "oficina e posto perto. Pergunte modelo, ano e quilometragem quando precisar.",
    tools: ["schedule_reminder", "list_reminders", "places_nearby", "list_transactions", "calculate", "web_search", "get_datetime"],
    asks: ["Me lembra da troca de óleo a cada 6 meses", "Quanto gastei com o carro esse mês?", "Quando vence o IPVA em SP?"],
  },
  {
    slug: "reunioes",
    name: "Reuniões",
    persona: "Secretária Marlene",
    icon: "users",
    blurb: "Entra sozinha na sua reunião do Meet pelo link (ou ouve pelo notebook) e manda a ata em PDF com tópicos, decisões, tarefas e sugestões.",
    focus: "reuniões: atas, decisões, tarefas de cada um e próximos passos",
    instructions:
      "Você acompanha as reuniões da pessoa. Se ela mandar um link do Meet, entre sozinha com meeting_join (alguém da reunião precisa aceitar sua entrada) " +
      "e saia com meeting_leave quando ela pedir; ou ela abre a sua aba no painel pelo notebook e toca em Acompanhar reunião. " +
      "No fim a ata em PDF chega sozinha aqui. Quando ela perguntar de uma reunião, leia a ata (meeting_list e meeting_read) antes de responder, " +
      "sem inventar o que não foi dito. Ofereça lembrete das tarefas com prazo e, se ela pedir, um PDF novo só com o que interessa.",
    tools: ["meeting_join", "meeting_leave", "meeting_list", "meeting_read", "schedule_reminder", "list_reminders", "calendar_list_events", "make_pdf", "get_datetime"],
    asks: ["Entra nessa reunião e me manda os pontos importantes (cole o link do Meet)", "O que ficou decidido na última reunião?", "Quais tarefas ficaram comigo na reunião de hoje?", "Me lembra das tarefas da reunião um dia antes do prazo"],
  },
];

const bySlug = (slug: string) => STORE.find((s) => s.slug === slug);

/** Fundo pastel de cada um (índice de FACE_COLORS no painel), combinando com a roupa. */
const COLORS: Record<string, number> = { treino: 7, estudos: 5, pet: 0, saude: 1, viagens: 6, cozinha: 2, casa: 0, carro: 4, reunioes: 3 };
/** Carinha fixa: cada especialista veste a roupa dele (skin:<slug>, desenhada no painel), igual para todo mundo. */
export const storeFace = (slug: string): Face => ({ color: COLORS[slug] ?? 5, eyes: "happy", mouth: "smile", extra: `skin:${slug}` });

/** Catálogo com o que esta pessoa já ligou (e quantas vagas de agente ainda tem). */
export async function listStore(userId: string) {
  const rows = await many("SELECT slug, active, origin FROM client_agents WHERE user_id = $1", [userId]);
  const used = rows.filter((r) => r.active).length;
  return {
    items: STORE.map((s) => {
      const r = rows.find((x) => x.slug === s.slug);
      return { ...s, active: Boolean(r?.active), face: storeFace(s.slug), mine: Boolean(r && r.origin !== "loja") };
    }),
    used,
    max: MAX_CLIENT_AGENTS,
  };
}

/** Especialistas da loja ligados (viram abas no app). */
export async function activeStoreAgents(userId: string) {
  const rows = await many("SELECT slug, name, persona FROM client_agents WHERE user_id = $1 AND active AND origin = 'loja' ORDER BY created_at", [userId]);
  return rows.map((r) => ({ slug: r.slug, name: r.name, persona: r.persona, icon: bySlug(r.slug)?.icon ?? "sparkle" }));
}

export async function activateStore(userId: string, slug: string): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  const item = bySlug(slug);
  if (!item) return { ok: false, error: "Esse especialista não existe", status: 404 };
  const existing = await one("SELECT active, origin FROM client_agents WHERE user_id = $1 AND slug = $2", [userId, slug]);
  if (existing?.active && existing.origin !== "loja") return { ok: false, error: `Você já tem um agente de ${item.name} feito para você`, status: 409 };
  if (existing?.active) return { ok: true };
  const n = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM client_agents WHERE user_id = $1 AND active", [userId]);
  if ((n?.n ?? 0) >= MAX_CLIENT_AGENTS) return { ok: false, error: `Seu time já tem ${MAX_CLIENT_AGENTS} agentes. Desligue um para ligar outro.`, status: 409 };
  await one(
    `INSERT INTO client_agents (user_id, slug, name, focus, instructions, tools, persona, face, origin) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'loja')
     ON CONFLICT (user_id, slug) DO UPDATE SET active = true, name = $3, focus = $4, instructions = $5, tools = $6, persona = $7, face = $8, origin = 'loja', updated_at = now()
     RETURNING id`,
    [userId, slug, item.name, item.focus, item.instructions, item.tools, item.persona, JSON.stringify(storeFace(slug))],
  );
  await notify({ userId, kind: "agente", title: `${item.persona} entrou no seu time`, body: `Especialista em ${item.name}. Peça direto no WhatsApp.`, link: `/especialistas/${slug}` });
  return { ok: true };
}

export async function deactivateStore(userId: string, slug: string) {
  const r = await one("UPDATE client_agents SET active = false, updated_at = now() WHERE user_id = $1 AND slug = $2 AND origin = 'loja' AND active RETURNING id", [userId, slug]);
  return Boolean(r);
}

/**
 * Trava de honestidade: a resposta só pode dizer que fez algo (anotei, apaguei, agendei…) se a ferramenta
 * correspondente rodou com sucesso nesta execução, pelo CTO ou por um especialista.
 */
const SCHEDULE_TOOLS = ["schedule_reminder", "set_alarm", "calendar_create_event", "reschedule_reminder", "watch_create", "watch_update", "automation_save", "bill_save", "card_save", "card_invoice_pay", "errand_start", "errand_done", "send_whatsapp"];
// "amanhã às 8h", "hoje", "segunda", "daqui a 20 min": a frase fala de um momento futuro
const WHEN = /\b(amanh[ãa]|hoje|depois de amanh[ãa]|daqui a?|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|semana que vem|m[êe]s que vem|de manh[ãa]|[àa] tarde|[àa] noite|meio-dia|meia-noite|dia \d{1,2}|[àa]s? \d{1,2})\b|\b\d{1,2}\s?h(\d{2})?\b|\b\d{1,2}:\d{2}\b/i;

/** Só leu ou consultou: não sustenta "anotado", "feito", "tá na agenda". */
const READ_ONLY = /^(ask_|consult_|share_with_team$|react_to_message$|web_search|fetch_url|places_nearby|calculate|read_|list_|get_|search_)|(_list|_status|_search|_read|_events|_channels|_workflows|_executions|_catalog|_info)$/;
/** tools: ["*"] = qualquer ferramenta que fez algo (lançar, salvar, agendar, gerar...). */
const ANY = "*";
const DELETE_TOOLS = ["delete_transaction", "card_delete", "card_save", "cancel_reminder", "alarm_cancel", "document_delete", "forget_memory", "watch_cancel", "watch_update", "direct_cancel", "automation_manage", "bill_delete", "categories", "shop_update", "errand_cancel"];
const FINANCE_TOOLS = ["add_transaction", "update_transaction", "bill_pay", "bill_save", "card_invoice_pay", "card_save", "goal_add", "goal_update", "goal_create"];

const CLAIMS: { what: string; says: RegExp; about?: RegExp; sameSentence?: boolean; tools: string[] }[] = [
  {
    what: "lançar gasto ou receita",
    says: /\b(anotei|registrei|lancei|lan[cç]ad[oa]s?|anotad[oa]s?|registrad[oa]s?)\b/i,
    about: /R\$|\bgastos?\b|\breceitas?\b|\bdespesas?\b|\blan[cç]amentos?\b/i,
    tools: ["add_transaction", "update_transaction", "bill_pay"],
  },
  {
    what: "corrigir lançamento",
    says: /\b(corrigi|alterei|atualizei|ajustei|recategorizei)\b/i,
    about: /R\$|\bvalor\b|\bcategoria\b|\blan[cç]amentos?\b|\bgastos?\b|\bdata\b/i,
    tools: ["update_transaction", "add_transaction", "delete_transaction", "reschedule_reminder", "card_save"],
  },
  {
    what: "apagar ou cancelar",
    says: /\b(apaguei|removi|exclu[ií]|deletei|cancelei)\b/i,
    tools: ["delete_transaction", "card_delete", "card_save", "cancel_reminder", "alarm_cancel", "document_delete", "forget_memory", "watch_cancel", "watch_update", "direct_cancel", "automation_manage", "set_budget", "bill_delete", "bill_save"],
  },
  {
    what: "agendar lembrete ou evento",
    says: /\b(agendei|marquei|lembrete (criado|marcado|agendado|salvo)|vou te lembrar|te lembro|alarme (criado|marcado|agendado|ligado)|coloquei (o|um) alarme)\b/i,
    tools: SCHEDULE_TOOLS,
  },
  {
    // "Agora tá criado e ativo ✅", "ficou salvo na agenda"
    what: "agendar lembrete ou evento",
    says: /\b(t[áa]|est[áa]|foi|ficou|j[áa] (t[áa]|est[áa])) (criad[oa]|salv[oa]|agendad[oa]|marcad[oa])\b/i,
    about: /\blembretes?\b|\balarmes?\b|\bagenda\b|\baviso\b|⏰/i,
    tools: SCHEDULE_TOOLS,
  },
  {
    // "Prontinho! Amanhã às 8h eu te aviso": promessa com hora marcada também é agendar
    what: "agendar lembrete ou evento",
    says: /\b(te aviso|vou te avisar|te chamo|vou te chamar|te acordo|vou te acordar|te cutuco|te mando (um )?(aviso|lembrete))\b/i,
    about: WHEN,
    sameSentence: true,
    tools: SCHEDULE_TOOLS,
  },
  {
    // "Prontinho! Coloquei na sua agenda", "tá na sua agenda", "você recebe o aviso amanhã", "tô aqui te lembrando"
    what: "agendar lembrete ou evento",
    says: /\b(coloquei|botei|deixei|pus|adicionei|inclu[ií])\b[^.!?\n]{0,30}\b(agenda|lembretes?|alarmes?|calend[aá]rio)\b|\b(t[áa]|est[áa]|ficou|j[áa] t[áa]|j[áa] est[áa]) (na|no) (sua |seu )?(agenda|calend[aá]rio)\b|\bvoc[êe] (vai )?receb\w* (o|um|seu) (aviso|lembrete)\b|\b(t[ôo]|estou|vou estar|estarei) aqui (pra |para )?te (lembrar|avisar)\b|\bt[ôo] aqui te lembrando\b/i,
    tools: [...SCHEDULE_TOOLS, "list_reminders", "calendar_list_events", "direct_list"],
  },
  {
    // "Tá anotado!", "Anotado ✅", "Registrado!": sem dizer o quê, qualquer coisa feita sustenta (gasto, memória, documento)
    what: "anotar",
    says: /^(\W*)(t[áa] |j[áa] |prontinho[,!]? |pronto[,!]? |ok[,!]? |fechado[,!]? |show[,!]? )?(anotad|registrad|lan[cç]ad|salv|guardad|agendad|marcad)[oa]s?\b/i,
    tools: [ANY],
  },
  {
    // "Pronto, já está na sua lista de gastos!", "R$ 50 de mercado no seu controle ✅"
    what: "lançar gasto ou receita",
    says: /\b(na sua lista de gastos|no seu controle|nas suas finan[çc]as|na sua planilha|no seu extrato)\b/i,
    about: /R\$|\bgastos?\b|\bdespesas?\b|\breceitas?\b|✅|\b(j[áa] )?(t[áa]|est[áa]|ficou|foi)\b/i,
    tools: [...FINANCE_TOOLS, "list_transactions", "finance_summary", "budget_status"],
  },
  {
    // "Apagado ✅", "Pronto, excluído"
    what: "apagar ou cancelar",
    says: /^(\W*)(pronto[,!]? |prontinho[,!]? |feito[,!]? |ok[,!]? )?(apagad|exclu[ií]d|removid|deletad)[oa]s?\b/i,
    tools: DELETE_TOOLS,
  },
  {
    // "o gasto foi removido", "o lembrete tá apagado" (e não "o filme foi removido da Netflix")
    what: "apagar ou cancelar",
    says: /\b(foi|foram|t[áa]|est[áa]|ficou|j[áa]) (apagad|exclu[ií]d|removid|deletad|cancelad)[oa]s?\b/i,
    about: /\b(lan[cç]amentos?|gastos?|despesas?|receitas?|lembretes?|alarmes?|documentos?|arquivos?|cart[ãa]o|cart[õo]es|contas? fixas?|mem[óo]rias?|categorias?|automa[çc][ãa]o|mensagem agendada|acompanhamento|da (sua )?lista)\b/i,
    sameSentence: true,
    tools: DELETE_TOOLS,
  },
  {
    // "A mensagem pro João já foi ✅", "recado saiu", "enviada pro João"
    what: "enviar mensagem",
    says: /\b(mensagem|recado|convite|e-?mail|whats(app)?|zap)\b[^.!?\n]{0,30}\b(j[áa] )?(foi|saiu|seguiu)\b|\benviad[oa]s? (pr[oa]|para)\b|^(\W*)enviad[oa]s?\b/i,
    tools: ["send_to_contact", "send_whatsapp", "gmail_send", "slack_send_message", "errand_start", "errand_continue", "invite_person", "contact_owner"],
  },
  {
    what: "guardar documento ou nota",
    says: /\b(salvei|guardei)\b/i,
    tools: ["document_save", "save_memory", "automation_save", "set_budget", "add_transaction", "bill_save", "bill_pay", "card_save"],
  },
  {
    what: "enviar mensagem",
    says: /\b(mandei|enviei|encaminhei)\b/i,
    tools: ["send_to_contact", "send_whatsapp", "make_audio", "gmail_send", "slack_send_message", "errand_start", "errand_continue", "invite_person", "contact_owner"],
  },
  {
    what: "avisar o responsável",
    says: /\b(avisei|passei o recado|levei (o|seu) (recado|pedido))\b/i,
    about: /\brespons[aá]vel\b|\bdono\b|\bsuporte\b|\bequipe\b/i,
    tools: ["contact_owner"],
  },
  {
    what: "convidar",
    says: /\b(convidei|convite enviado)\b/i,
    tools: ["invite_person"],
  },
  {
    what: "gerar link de pagamento",
    says: /\b(gerei|criei) o link\b/i,
    tools: ["create_payment_link"],
  },
];

/** O que a resposta diz ter feito sem a ferramenta ter confirmado (null = tudo certo). */
export function unbackedClaim(text: string, done: Set<string>): string | null {
  // pergunta ou condicional ("quer que eu anote?", "se quiser eu apago") não é afirmação
  const sentences = text.split(/(?<=[.!?\n])\s+/).filter((s) => !/\?\s*$/.test(s) && !/\b(se quiser|quer que|posso)\b/i.test(s));
  const anyAction = [...done].some((t) => !READ_ONLY.test(t));
  for (const c of CLAIMS) {
    const hit = sentences.some((s) => c.says.test(s) && (!c.about || c.about.test(s) || (!c.sameSentence && c.about.test(text))));
    if (hit && !c.tools.some((t) => (t === ANY ? anyAction : done.has(t)))) return c.what;
  }
  return null;
}

// Pedidos claros de ação: se a rodada termina sem nenhuma dessas ferramentas, o modelo só respondeu "combinado"
const REQUESTS: { what: string; asks: RegExp; unless: RegExp; tools: string[] }[] = [
  {
    // "me lembra amanhã às 8h", "cria um lembrete", "põe um alarme" (não ver, mudar ou cancelar)
    what: "agendar lembrete ou evento",
    asks: /\b(me (lembr[ae]\w*|avis[ae]\w*|acord[ae]\w*|cutuc[ae]\w*)|cri[ae]\w* (um |o |esse |este )?(lembrete|alarme)|(p[õo]e|coloca|bota|marca|agenda) (um |o )?(lembrete|alarme)|lembrete (pra|para|de|às|amanh[ãa])|alarme (pra|para|às))\b/i,
    unless: /\b(cancel\w*|apag\w*|remov\w*|exclu\w*|desmarc\w*|tir[ae] (o|esse|aquele)|quais|lista\w*|mostr\w*|mud[ae]\w*|troc[ae]\w*|adi[ae]\w*|remarc\w*|n[ãa]o precisa|esquece)\b/i,
    tools: [...SCHEDULE_TOOLS, "list_reminders", "alarm_list", "watch_list", "shop_save", "shop_update"],
  },
  {
    // "gastei 50 no mercado", "paguei a luz 180", "recebi 2 mil", "anota 30 de uber", "guardei 200 na viagem"
    what: "lançar gasto ou receita",
    asks: /\b(gastei|paguei|comprei|recebi|ganhei|torrei|guardei)\b[^?\n]{0,60}\d|\b(anot[ae]|lan[cç]a|registr[ae])\b[^?\n]{0,60}(R\$\s?\d|\d\s?(reais|conto|pila)\b)/i,
    unless: /\b(quanto|quais|qual|cad[êe]|mostr\w*|lista\w*|apag\w*|exclu\w*|remov\w*|cancel\w*|corrig\w*|n[ãa]o (anot|lan[cç]))\b/i,
    tools: ["add_transaction", "update_transaction", "bill_pay", "bill_save", "card_invoice_pay", "card_save", "goal_add", "goal_update", "shop_update", "list_transactions", "finance_summary"],
  },
];

/** Palavra logo antes do número que mostra que não é dinheiro ("dia 15", "às 10", "apto 32"). */
const NOT_MONEY = /^(dia|dias|as|às|a|hora|horas|h|n|nº|no|numero|número|ap|apto|apartamento|casa|sala|bloco|lote|km|kg|g|ml|l|idade|tenho|sou|faltam|falta|min|minutos|vezes|x|nota|top|ano|anos|mes|meses|semana|semanas|cap|capitulo|capítulo|pagina|página|item|versao|versão)$/i;
const ASKY = /\?|\b(quanto|quantos|quais|qual|cad[êe]|como|onde|quando|por ?que)\b/i;
/** "mercado 50", "uber 23,90", "anota padaria 12", "50 no mercado": jeito curto de anotar um gasto. */
function shortExpense(line: string) {
  const l = line.trim();
  if (l.length > 50 || ASKY.test(l) || /\b\d{7,}\b/.test(l)) return false;
  const a = l.match(/^(?:anot[ae]|lan[cç]a|registr[ae]|coloca|bota|p[õo]e)?\s*([\p{L}][\p{L} ]{1,30}?)\s*[:,-]?\s+(?:de\s+)?(?:R\$\s?)?\d{1,6}(?:[.,]\d{1,2})?\s*(?:reais|real|conto|contos|pila)?$/iu);
  if (a) return !NOT_MONEY.test(a[1]!.trim().split(/\s+/).at(-1) ?? "");
  return /^(?:R\$\s?)?\d{1,6}(?:[.,]\d{1,2})?\s*(?:reais|real|conto|contos|pila)?\s+(?:de|no|na|em|com)\s+[\p{L}][\p{L} ]{1,30}$/iu.test(l);
}
const EVENT = /\b(reuni[ãa]o|consulta|dentista|m[ée]dic[oa]|anivers[áa]rio|compromisso|prova|entrevista|exame|academia|aula|voo|jantar|almo[çc]o|pagar|pagamento|boleto|vencimento|buscar|levar|ligar)\b/i;
const TOLD = /\b(tenho|tive|teve|tem|foi|era|fui|vou|estou|estava|t[áa]va)\b/i;
/** "amanhã 8h reunião", "lembrar de pagar o boleto sexta": anotação de compromisso sem "me lembra". */
function shortSchedule(line: string) {
  const l = line.trim();
  if (l.length > 90 || ASKY.test(l)) return false;
  if (/\blembrar (de|que|do|da|o|a)\b/i.test(l) && WHEN.test(l)) return true;
  return WHEN.test(l) && /\b\d{1,2}\s?h(\d{2})?\b|\b\d{1,2}:\d{2}\b|meio-dia/i.test(l) && EVENT.test(l) && !TOLD.test(l);
}

/**
 * Pedido claro de ação que terminou sem nenhuma ferramenta da área: o modelo respondeu "combinado"
 * sem fazer. Pergunta de volta ("que horas?", "qual valor?") é resposta válida. null = tudo certo.
 */
export function unmetRequest(asked: string, answer: string, done: Set<string>): string | null {
  const said = asked.replace(/\[msg_id=\d+\]\s*/g, "");
  if (/\?\s*\S{0,4}\s*$/.test(answer.trim())) return null;
  for (const r of REQUESTS) {
    if (!r.asks.test(said) || r.unless.test(said)) continue;
    if (!r.tools.some((t) => done.has(t))) return r.what;
  }
  const lines = said.split("\n").map((l) => l.replace(/^\s*\[[^\]]*\]\s*/, ""));
  if (lines.some(shortExpense) && !REQUESTS[1]!.tools.some((t) => done.has(t)) && !done.has("save_memory")) return REQUESTS[1]!.what;
  if (lines.some((l) => shortSchedule(l) && !REQUESTS[0]!.unless.test(l)) && !REQUESTS[0]!.tools.some((t) => done.has(t)) && !done.has("save_memory")) return REQUESTS[0]!.what;
  return null;
}

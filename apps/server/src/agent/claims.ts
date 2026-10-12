/**
 * Trava de honestidade: a resposta só pode dizer que fez algo (anotei, apaguei, agendei…) se a ferramenta
 * correspondente rodou com sucesso nesta execução, pelo CTO ou por um especialista.
 */
const SCHEDULE_TOOLS = ["schedule_reminder", "set_alarm", "calendar_create_event", "reschedule_reminder", "watch_create", "watch_update", "automation_save", "bill_save", "card_save", "card_invoice_pay", "errand_start", "errand_done", "send_whatsapp"];
// "amanhã às 8h", "hoje", "segunda", "daqui a 20 min": a frase fala de um momento futuro
const WHEN = /\b(amanh[ãa]|hoje|depois de amanh[ãa]|daqui a?|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|semana que vem|m[êe]s que vem|de manh[ãa]|[àa] tarde|[àa] noite|meio-dia|meia-noite|dia \d{1,2}|[àa]s? \d{1,2})\b|\b\d{1,2}\s?h(\d{2})?\b|\b\d{1,2}:\d{2}\b/i;

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
  for (const c of CLAIMS) {
    const hit = sentences.some((s) => c.says.test(s) && (!c.about || c.about.test(s) || (!c.sameSentence && c.about.test(text))));
    if (hit && !c.tools.some((t) => done.has(t))) return c.what;
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
  return null;
}

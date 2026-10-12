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

// "me lembra amanhã às 8h", "cria um lembrete", "põe um alarme": pedido claro de agendar (não de ver, mudar ou cancelar)
const ASKS_REMINDER = /\b(me (lembr[ae]\w*|avis[ae]\w*|acord[ae]\w*|cutuc[ae]\w*)|cri[ae]\w* (um |o |esse |este )?(lembrete|alarme)|(p[õo]e|coloca|bota|marca|agenda) (um |o )?(lembrete|alarme)|lembrete (pra|para|de|às|amanh[ãa])|alarme (pra|para|às))\b/i;
const NOT_NEW = /\b(cancel\w*|apag\w*|remov\w*|exclu\w*|desmarc\w*|tir[ae] (o|esse|aquele)|quais|lista\w*|mostr\w*|mud[ae]\w*|troc[ae]\w*|adi[ae]\w*|remarc\w*|n[ãa]o precisa|esquece)\b/i;
const REMINDER_TOOLS = [...SCHEDULE_TOOLS, "list_reminders", "alarm_list", "watch_list", "shop_save", "shop_update"];

/**
 * Pedido claro de lembrete que terminou sem nenhuma ferramenta de agenda: o modelo respondeu "combinado"
 * sem agendar. Pergunta de volta ("que horas?") é resposta válida. null = tudo certo.
 */
export function unmetReminder(asked: string, answer: string, done: Set<string>): string | null {
  const said = asked.replace(/\[msg_id=\d+\]\s*/g, "");
  if (!ASKS_REMINDER.test(said) || NOT_NEW.test(said)) return null;
  if (/\?\s*\S{0,4}\s*$/.test(answer.trim())) return null;
  return REMINDER_TOOLS.some((t) => done.has(t)) ? null : "agendar lembrete ou evento";
}

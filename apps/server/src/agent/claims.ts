/**
 * Trava de honestidade: a resposta só pode dizer que fez algo (anotei, apaguei, agendei…) se a ferramenta
 * correspondente rodou com sucesso nesta execução, pelo CTO ou por um especialista.
 */
const CLAIMS: { what: string; says: RegExp; about?: RegExp; tools: string[] }[] = [
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
    tools: ["update_transaction", "add_transaction", "delete_transaction", "reschedule_reminder"],
  },
  {
    what: "apagar ou cancelar",
    says: /\b(apaguei|removi|exclu[ií]|deletei|cancelei)\b/i,
    tools: ["delete_transaction", "cancel_reminder", "document_delete", "forget_memory", "watch_cancel", "watch_update", "automation_manage", "set_budget", "bill_delete", "bill_save"],
  },
  {
    what: "agendar lembrete ou evento",
    says: /\b(agendei|marquei|lembrete (criado|marcado|agendado)|vou te lembrar|te lembro)\b/i,
    tools: ["schedule_reminder", "calendar_create_event", "reschedule_reminder", "watch_create", "watch_update", "automation_save", "bill_save", "errand_start", "errand_done"],
  },
  {
    what: "guardar documento ou nota",
    says: /\b(salvei|guardei)\b/i,
    tools: ["document_save", "save_memory", "automation_save", "set_budget", "add_transaction", "bill_save", "bill_pay"],
  },
  {
    what: "enviar mensagem",
    says: /\b(mandei|enviei|encaminhei)\b/i,
    tools: ["send_to_contact", "make_audio", "gmail_send", "slack_send_message", "errand_start", "errand_continue", "invite_person", "contact_owner"],
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
    const hit = sentences.some((s) => c.says.test(s) && (!c.about || c.about.test(s) || c.about.test(text)));
    if (hit && !c.tools.some((t) => done.has(t))) return c.what;
  }
  return null;
}

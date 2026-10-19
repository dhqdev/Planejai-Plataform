/**
 * Deixa o texto com cara de gente digitando no WhatsApp: sem travessão no meio da frase (vira vírgula;
 * "10 - 12h" vira "10 a 12h"; "100 - 30" fica, é conta). Marcador de lista ("-", "*", "•") some, ou vira "•"
 * com `bullets` (respostas do assistente para a pessoa, que podem vir organizadas em blocos).
 */
export function humanize(text: string, opts: { bullets?: boolean } = {}) {
  return plainCalendar(text)
    .replace(/^[ \t]*(?:[-*•–—]|\d+[.)])[ \t]+/gm, (m) => (/\d/.test(m) ? m.trimStart() : opts.bullets ? "• " : ""))
    // faixa de horário/data ("10 - 12h", "5 - 10 dias") vira "a"; conta ("100 - 30 = 70") fica como está
    .replace(/(\d)[ \t]+[-–—][ \t]+(\d+(?:[:,]\d+)?)(?=[ \t]*(?:h\b|hs?\b|horas?|min|dias?|semanas?|meses|m[eê]s|anos?|de |\/|%))/g, "$1 a $2")
    .replace(/(?<!\d)[ \t]*[–—][ \t]*|[ \t]*[–—][ \t]*(?!\d)/g, ", ")
    .replace(/(?<!\d)[ \t]+-[ \t]+|[ \t]+-[ \t]+(?!\d)/g, ", ")
    .replace(/^, */gm, "")
    .replace(/,[ \t]*,/g, ",")
    .replace(/,[ \t]*$/gm, "")
    .trim();
}

/** Calendário sem número: 📅 e 📆 aparecem no WhatsApp com um dia fixo ("17") e confundem; 🗓️ é o calendário sem data. */
export function plainCalendar(text: string) {
  return text.replace(/[\u{1F4C5}\u{1F4C6}]️?/gu, "\u{1F5D3}️");
}

/** Parágrafo acima disso (com 3+ frases) vira blocos de até 2 frases: textão não se lê no celular. */
const WALL = 200;
const SENTENCES_PER_PARAGRAPH = 2;
/** Abreviações que terminam em ponto e não fecham frase ("Dr. Paulo", "R. Augusta", "aprox. 10") */
const ABBREV = /(?:^|\s)(?:sr|sra|srta|dr|dra|prof|profa|av|r|n|nº|tel|aprox|obs|ex|etc|p\.ex|vs|min|máx|mín)\.$/i;

const isItem = (l: string) => /^\s*(?:•|◦|\d+[.)])\s/.test(l);
const isSub = (l: string) => /^\s+\S/.test(l);
/** Título de bloco: linha curta só em negrito, com ou sem emoji antes ("🗓️ *Amanhã*", "*Resumo:*") */
const isTitle = (l: string) => l.length <= 70 && /^(?:\S{1,8}\s+)?\*[^*\n]+\*:?$/u.test(l.trim());

function sentences(p: string) {
  const out: string[] = [];
  let cur = "";
  for (const piece of p.split(/(?<=[.!?…])\s+/)) {
    cur = cur ? `${cur} ${piece}` : piece;
    if (!ABBREV.test(cur)) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Sub-item de lista do markdown ("  - detalhe") vira "◦" recuado; precisa rodar antes do humanize, que tira o recuo. */
export function subItems(text: string) {
  return text.replace(/^(?: {2,}|\t+)[-*•◦][ \t]+/gm, "   ◦ ");
}

/** Quebra um parágrafo longo em blocos de poucas frases (link, conta e lista ficam como estão). */
function unwall(line: string) {
  if (line.length <= WALL || isItem(line) || isSub(line)) return [line];
  const s = sentences(line);
  if (s.length < 3) return [line];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += SENTENCES_PER_PARAGRAPH) out.push(s.slice(i, i + SENTENCES_PER_PARAGRAPH).join(" "));
  return out.flatMap((p, i) => (i ? ["", p] : [p]));
}

/**
 * Organiza a resposta para bater o olho no WhatsApp, sem mudar o que foi dito: título de bloco com uma linha
 * em branco antes e os itens logo embaixo, itens da mesma lista juntos, linha em branco quando a lista acaba,
 * sub-item recuado com "◦" e parágrafo longo quebrado em blocos de até 2 frases.
 */
export function arrange(text: string) {
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .flatMap(unwall);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const prev = out[out.length - 1];
    if (l.trim() === "") {
      // linha em branco entre itens da mesma lista, ou logo depois do título, sai
      const next = lines.slice(i + 1).find((x) => x.trim() !== "");
      if (prev === undefined || prev === "" || !next) continue;
      if ((isItem(prev) || isSub(prev)) && (isItem(next) || isSub(next))) continue;
      if (isTitle(prev)) continue;
      out.push("");
      continue;
    }
    if (prev !== undefined && prev !== "") {
      if (isTitle(l)) out.push("");
      else if ((isItem(prev) || isSub(prev)) && !isItem(l) && !isSub(l)) out.push("");
    }
    out.push(l);
  }
  return out.join("\n").trim();
}

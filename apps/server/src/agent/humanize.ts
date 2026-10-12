/**
 * Deixa o texto com cara de gente digitando no WhatsApp: sem travessão no meio da frase (vira vírgula;
 * "10 - 12h" vira "10 a 12h"; "100 - 30" fica, é conta). Marcador de lista ("-", "*", "•") some, ou vira "•"
 * com `bullets` (respostas do assistente para a pessoa, que podem vir organizadas em blocos).
 */
export function humanize(text: string, opts: { bullets?: boolean } = {}) {
  return text
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

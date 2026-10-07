/**
 * Deixa o texto com cara de gente digitando no WhatsApp: sem marcador de lista ("-", "•", "*")
 * e sem travessão no meio da frase (vira vírgula; "10 - 12h" vira "10 a 12h").
 */
export function humanize(text: string) {
  return text
    .replace(/^[ \t]*(?:[-*•–—]|\d+[.)])[ \t]+/gm, (m) => (/\d/.test(m) ? m.trimStart() : ""))
    .replace(/(\d)[ \t]+[-–—][ \t]+(\d)/g, "$1 a $2")
    .replace(/[ \t]*[–—][ \t]*/g, ", ")
    .replace(/[ \t]+-[ \t]+/g, ", ")
    .replace(/^, */gm, "")
    .replace(/,[ \t]*,/g, ",")
    .replace(/,[ \t]*$/gm, "")
    .trim();
}

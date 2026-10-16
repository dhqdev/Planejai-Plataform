/**
 * Texto -> jeito falado, antes da voz (Kokoro e afins leem "R$ 42,50", "15/03" e "CPF" de um jeito estranho).
 * Só regras, sem LLM: dinheiro, porcentagem, data, hora, telefone, ordinal, número solto, sigla e nomes da casa.
 * Ideia do VoiceFormatter do Pipecat, para pt-BR.
 */

const UNITS = ["zero", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove", "dez", "onze", "doze", "treze", "catorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const TENS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const HUNDREDS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];
const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

const fem = (w: string) => w.replace(/^um$/, "uma").replace(/^dois$/, "duas").replace(/entos$/, "entas");

/** 0..999 por extenso; feminino para "duas horas", "duzentas pessoas". */
function under1000(n: number, f: boolean): string {
  if (n === 100) return "cem";
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const rest = n % 100;
  if (h) parts.push(f ? fem(HUNDREDS[h]) : HUNDREDS[h]);
  if (rest) {
    if (rest < 20) parts.push(f ? fem(UNITS[rest]) : UNITS[rest]);
    else {
      const t = TENS[Math.floor(rest / 10)];
      const u = rest % 10;
      parts.push(u ? `${t} e ${f ? fem(UNITS[u]) : UNITS[u]}` : t);
    }
  }
  return parts.join(" e ");
}

const SCALES: [number, string, string][] = [
  [1e9, "um bilhão", "bilhões"],
  [1e6, "um milhão", "milhões"],
];

/** Inteiro por extenso em pt-BR (até centenas de bilhões). */
export function numberWords(n: number, feminine = false): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `menos ${numberWords(-n, feminine)}`;
  n = Math.floor(n);
  if (n < 1000) return n === 0 ? "zero" : under1000(n, feminine);
  const groups: string[] = [];
  let rest = n;
  for (const [size, one, many] of SCALES) {
    const q = Math.floor(rest / size);
    if (q) groups.push(q === 1 ? one : `${under1000(q, false)} ${many}`);
    rest %= size;
  }
  const thousands = Math.floor(rest / 1000);
  if (thousands) groups.push(thousands === 1 ? "mil" : `${under1000(thousands, feminine)} mil`);
  const last = rest % 1000;
  if (last) {
    // "mil e quinhentos", "mil duzentos e trinta": o "e" só antes de centena redonda ou de menos de cem
    const joiner = last < 100 || last % 100 === 0 ? " e " : " ";
    return `${groups.join(" e ")}${joiner}${under1000(last, feminine)}`;
  }
  return groups.join(" e ");
}

const toInt = (s: string) => Number(s.replace(/\./g, ""));

/** "R$ 1.234,56" -> "mil duzentos e trinta e quatro reais e cinquenta e seis centavos". */
export function moneyWords(intPart: number, cents: number) {
  const parts: string[] = [];
  if (intPart) {
    const big = intPart >= 1e6 && intPart % 1e6 === 0;
    parts.push(`${numberWords(intPart)}${big ? " de" : ""} ${intPart === 1 ? "real" : "reais"}`);
  }
  if (cents) parts.push(`${numberWords(cents)} ${cents === 1 ? "centavo" : "centavos"}`);
  return parts.length ? parts.join(" e ") : "zero reais";
}

function decimalWords(s: string, feminine = false) {
  const [i, d] = s.split(",");
  const int = numberWords(toInt(i), feminine);
  if (!d) return int;
  // "3,5" -> "três vírgula cinco"; "2,05" -> "dois vírgula zero cinco"
  const dec = d.startsWith("0") ? [...d].map((c) => UNITS[Number(c)]).join(" ") : numberWords(Number(d));
  return `${int} vírgula ${dec}`;
}

function timeWords(h: number, m: number) {
  if (m > 59) return null;
  // "48h" é duração, não horário
  if (h > 23) return m ? null : `${numberWords(h, true)} horas`;
  const hour = h === 0 ? "meia-noite" : h === 12 && !m ? "meio-dia" : numberWords(h, true);
  if (!m) return h === 0 || h === 12 ? hour : `${hour} ${h === 1 ? "hora" : "horas"}`;
  return `${hour} e ${m === 30 ? "trinta" : numberWords(m, true)}`;
}

function dateWords(d: number, mo: number, y?: string) {
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  const day = d === 1 ? "primeiro" : numberWords(d);
  const year = y ? ` de ${numberWords(y.length === 2 ? 2000 + Number(y) : Number(y))}` : "";
  return `${day} de ${MONTHS[mo - 1]}${year}`;
}

/** Telefone dígito a dígito, com pausa entre os grupos: "onze, nove oito sete seis cinco, quatro três dois um". */
const digits = (s: string) =>
  (s.match(/\d+/g) ?? []).map((g) => [...g].map((c) => UNITS[Number(c)]).join(" ")).join(", ");

const ORDINAL_UNITS = ["", "primeir", "segund", "terceir", "quart", "quint", "sext", "sétim", "oitav", "non"];
const ORDINAL_TENS = ["", "décim", "vigésim", "trigésim"];
function ordinalWords(n: number, suffix: "o" | "a") {
  if (n < 1 || n > 39) return null;
  const t = Math.floor(n / 10);
  const u = n % 10;
  return [t ? ORDINAL_TENS[t] + suffix : "", u ? ORDINAL_UNITS[u] + suffix : ""].filter(Boolean).join(" ");
}

/** Siglas lidas letra a letra e palavras que a voz erra; a chave é a palavra inteira (sem diferenciar maiúscula onde faz sentido). */
const SPELLED: Record<string, string> = {
  CPF: "cê pê éfe",
  CNPJ: "cê ene pê jota",
  RG: "érre gê",
  CNH: "cê ene agá",
  PDF: "pê dê éfe",
  IPVA: "i pê vê á",
  IPTU: "i pê tê u",
  FGTS: "éfe gê tê ésse",
  INSS: "i ene ésse ésse",
  SUS: "sus",
  SAMU: "samu",
  CEP: "cep",
  PIX: "pix",
  TED: "téd",
  DOC: "dóc",
  IA: "i á",
  SMS: "ésse eme ésse",
  ONG: "ong",
  UBS: "u bê ésse",
  UPA: "upa",
};
const NAMES: Record<string, string> = {
  planejai: "Planejaí",
  whatsapp: "uótzap",
  google: "gúgol",
  "e-mail": "imêil",
  email: "imêil",
  emails: "imêils",
  "e-mails": "imêils",
  instagram: "instagrã",
  online: "onlaine",
  app: "ép",
  ok: "ôquei",
};

/** Texto já limpo de marcação -> texto para a voz falar natural. */
export function voiceText(text: string): string {
  let t = text;
  // dinheiro: R$ 1.234,56 / R$ 50 / R$50,00 / -R$ 10
  t = t.replace(/(-\s*)?R\$\s*(\d{1,3}(?:\.\d{3})+|\d+)(?:,(\d{1,2}))?/g, (_m, neg, i, c) => {
    const cents = c ? Number(c.padEnd(2, "0")) : 0;
    return `${neg ? "menos " : ""}${moneyWords(toInt(i), cents)}`;
  });
  // porcentagem: 12,5% / 30 %
  t = t.replace(/(\d+(?:,\d+)?)\s*%/g, (_m, n) => `${decimalWords(n)} por cento`);
  // telefone: (11) 98765-4321, 11 98765-4321, +55 11 98765-4321, 98765-4321
  t = t.replace(/(?:\+?55\s*)?(?:\(?\b\d{2}\)?\s*)?\b9?\d{4}-\d{4}\b/g, (m) => digits(m.replace(/^\+?55\s*/, "")));
  // data: 15/03/2026, 15/03/26, 15/03
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?\b/g, (m, d, mo, y) => dateWords(Number(d), Number(mo), y) ?? m);
  // hora: 14h30, 14h, 14:30, 9h05min
  t = t.replace(/\b(\d{1,3})(?:h(\d{2})?(?:min)?|:(\d{2}))(?![\d:])/g, (m, h, m1, m2) => timeWords(Number(h), Number(m1 ?? m2 ?? 0)) ?? m);
  // ordinal: 1º, 2ª, 3o lugar não (só com º/ª)
  t = t.replace(/\b(\d{1,2})\s*([ºª])/g, (m, n, s) => ordinalWords(Number(n), s === "ª" ? "a" : "o") ?? m);
  t = t.replace(/\bn[º°]\s*/gi, "número ");
  // medidas comuns
  t = t.replace(/(\d+(?:,\d+)?)\s*(km|kg|ml|cm|mm|m|g|l)\b/g, (_m, n, u) => {
    const unit: Record<string, string> = { km: "quilômetros", kg: "quilos", ml: "mililitros", cm: "centímetros", mm: "milímetros", m: "metros", g: "gramas", l: "litros" };
    return `${decimalWords(n)} ${n === "1" ? unit[u].replace(/s$/, "") : unit[u]}`;
  });
  // número solto: 1.500 / 3,5 / 42 (anos de 4 dígitos também viram "dois mil e vinte e seis")
  t = t.replace(/\b\d{1,3}(?:\.\d{3})+(?:,\d+)?\b|\b\d+(?:,\d+)?\b/g, (m) => decimalWords(m));
  t = t.replace(/\s&\s/g, " e ");
  // siglas (só em maiúsculas, para não mexer em "doc" ou "sus" no meio de frase comum) e nomes
  t = t.replace(/\b[A-Z]{2,5}\b/g, (m) => SPELLED[m] ?? m);
  t = t.replace(/(?<![\p{L}-])(e-mails?|[\p{L}]+)(?![\p{L}-])/giu, (m) => NAMES[m.toLowerCase()] ?? m);
  return t.replace(/[ \t]{2,}/g, " ");
}

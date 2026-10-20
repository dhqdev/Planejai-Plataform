import { createHash } from "node:crypto";

/**
 * Leitura de extrato OFX (o arquivo que todo banco brasileiro exporta), sem IA e sem dependência.
 * Vale para o OFX 1.x (SGML, tags sem fechar) e o 2.x (XML), conta corrente e cartão de crédito.
 * Valores saem em centavos (inteiro) para não perder nada no caminho.
 */

export interface OfxTransaction {
  /** Identificador estável do lançamento dentro da conta (FITID; sem ele, um hash do conteúdo). */
  ref: string;
  /** AAAA-MM-DD */
  date: string;
  /** Centavos, com sinal: negativo = saiu, positivo = entrou. */
  cents: number;
  type: string;
  description: string;
  /** Lugar ou pessoa, limpo (para aprender a categoria e achar o histórico). */
  merchant: string | null;
}

export interface OfxStatement {
  bank: string | null;
  bankId: string | null;
  account: string | null;
  /** Fatura de cartão (CCSTMTRS) em vez de conta corrente. */
  creditCard: boolean;
  currency: string;
  start: string | null;
  end: string | null;
  transactions: OfxTransaction[];
}

/** Código do banco (COMPE) que aparece no BANKID para o nome que a pessoa reconhece. */
const BANKS: Record<string, string> = {
  "1": "Banco do Brasil",
  "33": "Santander",
  "77": "Inter",
  "104": "Caixa",
  "208": "BTG Pactual",
  "212": "Banco Original",
  "237": "Bradesco",
  "260": "Nubank",
  "290": "PagBank",
  "323": "Mercado Pago",
  "336": "C6 Bank",
  "341": "Itaú",
  "380": "PicPay",
  "403": "Cora",
  "422": "Safra",
  "655": "Votorantim",
  "735": "Neon",
  "748": "Sicredi",
  "756": "Sicoob",
};

/** Bytes do arquivo para texto: respeita o CHARSET/encoding do cabeçalho e cai para o Windows-1252 dos bancos antigos. */
export function decodeOfx(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 600));
  const latin = /CHARSET:\s*(1252|ISO-?8859-?1|8859)|encoding=["'](windows-1252|iso-8859-1)/i.test(head);
  if (!latin) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^﻿/, "");
    } catch {
      // não era UTF-8 de verdade
    }
  }
  return new TextDecoder("windows-1252").decode(bytes);
}

const entities = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&");

/** Valor de uma tag folha (`<MEMO>texto` no SGML ou `<MEMO>texto</MEMO>` no XML). */
function field(block: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, "i").exec(block);
  const v = m ? entities(m[1]!).trim() : "";
  return v || null;
}

/** 20261015120000[-3:BRT] ou 20261015 -> 2026-10-15 */
function ofxDate(v: string | null): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(v ?? "");
  if (!m) return null;
  const [, y, mo, d] = m;
  if (Number(mo) < 1 || Number(mo) > 12 || Number(d) < 1 || Number(d) > 31) return null;
  return `${y}-${mo}-${d}`;
}

/** "-1.234,56", "-1234.56", "+80" -> centavos com sinal, sem passar por float. */
export function ofxCents(v: string | null): number | null {
  let s = String(v ?? "").replace(/\s/g, "");
  if (!s) return null;
  const neg = s.startsWith("-");
  s = s.replace(/^[+-]/, "");
  const comma = s.lastIndexOf(",");
  const dot = s.lastIndexOf(".");
  const sep = Math.max(comma, dot);
  // separador de milhar sozinho (1.234) não é decimal
  const decimals = sep >= 0 && s.length - sep - 1 <= 2 ? sep : -1;
  const int = (decimals >= 0 ? s.slice(0, decimals) : s).replace(/[.,]/g, "");
  const frac = decimals >= 0 ? s.slice(decimals + 1).padEnd(2, "0") : "00";
  if (!/^\d*$/.test(int) || !/^\d{2}$/.test(frac)) return null;
  const cents = Number(int || "0") * 100 + Number(frac);
  return neg ? -cents : cents;
}

const SMALL = new Set(["de", "da", "do", "das", "dos", "e", "em", "no", "na", "para", "com"]);
/** "COMPRA CARTAO DEB  PADARIA PAO QUENTE 15/10" -> "Compra cartao deb padaria pao quente": tudo maiúsculo vira frase legível. */
export function tidy(s: string): string {
  let t = s.replace(/\s+/g, " ").trim();
  // data e hora soltas no fim ("15/10", "15/10 12:34") não ajudam a reconhecer o lugar
  t = t.replace(/\s+\d{2}\/\d{2}(\/\d{2,4})?(\s+\d{2}:\d{2}(:\d{2})?)?$/, "").trim();
  if (t && t === t.toUpperCase() && /[A-Z]/.test(t)) {
    t = t
      .toLowerCase()
      .split(" ")
      .map((w, i) => (i > 0 && SMALL.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
      .join(" ");
  }
  return t.slice(0, 200);
}

/** Prefixos de banco que vêm antes do nome do lugar ou da pessoa. */
const PREFIX =
  /^(compra (com |no )?cart[aã]o( de)?( d[eé]bito| cr[eé]dito| deb| cred)?( visa| master(card)?| elo)?|compra( d[eé]bito| no d[eé]bito)?|pix (enviado|recebido|transf\w*|emitido|qr code)( para| de)?|transfer[eê]ncia (enviada|recebida|pix)( para| de)?|ted (enviada|recebida|enviado|recebido)?|doc (enviado|recebido)?|pagamento( de)?( boleto| conta| titulo)?|pgto|pag\b|deb(ito)? autom[aá]tico|d[eé]bito)\b\s*[-:]?\s*/i;

/** Lugar ou pessoa sem o prefixo do banco ("Pix enviado Maria Souza" -> "Maria Souza"). */
export function merchantOf(name: string | null, memo: string | null): string | null {
  const base = tidy(name && memo && name !== memo ? name : (name ?? memo ?? ""));
  const m = base.replace(PREFIX, "").replace(/^[-*:\s]+/, "").trim();
  return m.length >= 3 ? m.slice(0, 80) : null;
}

const MAX_TRANSACTIONS = 2000;

/** Lê o texto do OFX. Lança erro com mensagem para a pessoa quando não parece um extrato. */
export function parseOfx(text: string): OfxStatement {
  if (!/<OFX>/i.test(text) || !/<STMTTRN>/i.test(text)) {
    if (/<OFX>/i.test(text)) return { bank: null, bankId: null, account: null, creditCard: false, currency: "BRL", start: null, end: null, transactions: [] };
    throw new Error("Esse arquivo não parece um extrato OFX. No app do banco, procure por Exportar extrato > OFX (ou Money).");
  }
  const bankId = field(text, "BANKID");
  const org = field(text, "ORG");
  const idNum = bankId ? String(Number(bankId.replace(/\D/g, "")) || "") : "";
  const bank = BANKS[idNum] ?? (org && !/^\d+$/.test(org) ? tidy(org) : null);
  const blocks = text.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>/i)[0]!);
  const seen = new Map<string, number>();
  const transactions: OfxTransaction[] = [];
  for (const b of blocks.slice(0, MAX_TRANSACTIONS)) {
    const cents = ofxCents(field(b, "TRNAMT"));
    const date = ofxDate(field(b, "DTPOSTED") ?? field(b, "DTUSER"));
    if (cents == null || !date || cents === 0) continue;
    const name = field(b, "NAME");
    const memo = field(b, "MEMO");
    const description = tidy(memo && name && !memo.toLowerCase().includes(name.toLowerCase()) ? `${name} ${memo}` : (memo ?? name ?? field(b, "TRNTYPE") ?? "Lançamento"));
    const fitid = field(b, "FITID");
    // FITID repetido no mesmo arquivo (alguns bancos repetem) ou ausente: hash do conteúdo
    let ref = fitid ?? createHash("sha1").update(`${date}|${cents}|${description}`).digest("hex").slice(0, 20);
    const n = seen.get(ref) ?? 0;
    seen.set(ref, n + 1);
    if (n > 0) ref = `${ref}#${createHash("sha1").update(`${date}|${cents}|${description}|${n}`).digest("hex").slice(0, 8)}`;
    transactions.push({ ref, date, cents, type: (field(b, "TRNTYPE") ?? "").toUpperCase(), description, merchant: merchantOf(name, memo) });
  }
  return {
    bank,
    bankId: idNum || null,
    account: field(text, "ACCTID"),
    creditCard: /<CCSTMTRS>/i.test(text),
    currency: (field(text, "CURDEF") ?? "BRL").toUpperCase(),
    start: ofxDate(field(text, "DTSTART")),
    end: ofxDate(field(text, "DTEND")),
    transactions,
  };
}

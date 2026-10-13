import { normalizePhone } from "./accounts.js";
import { many, one, query } from "./db/pool.js";

/**
 * Agenda de contatos da pessoa: importada do celular (arquivo .vcf ou o seletor de contatos do Android) ou salva
 * pelo assistente. Serve para mandar mensagem pelo nome ("manda pra Ana que..."). Particular: cada um vê só a sua.
 */

export const MAX_CONTACTS = 5000;

export interface ContactInput {
  name: string;
  phones: { number: string; label?: string }[];
}

export const nameKey = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Número que dá para usar no WhatsApp (só dígitos, com DDI); null para ramal, 0800, número curto. */
export function cleanContactPhone(raw: string): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  // +DDI fora do Brasil fica como veio; sem DDI, o Brasil (DDD + número)
  const intl = s.startsWith("+") || s.startsWith("00");
  let d = s.replace(/\D/g, "");
  if (s.startsWith("00")) d = d.slice(2);
  if (/^0?800/.test(d) && !intl) return null;
  if (!intl) {
    d = d.replace(/^0(?=\d{10,11}$)/, ""); // 0 + DDD
    d = d.replace(/^0\d{2}(?=\d{10,11}$)/, ""); // 0 + operadora + DDD
  }
  if (d.length < 10 || d.length > 15) return null;
  return intl ? d : normalizePhone(d);
}

/** Tem letra ou número? ";;;;", "-" e "()" não são nome. */
export const hasName = (s: string) => /[\p{L}\p{N}]/u.test(s);

const isQp = (params: string) => /ENCODING=QUOTED-PRINTABLE|(?:^|;)QUOTED-PRINTABLE(?:;|$)/i.test(params);

/**
 * Junta as linhas de cada campo: dobra do vCard (linha seguinte começa com espaço ou tab) e quebra "suave" do
 * quoted-printable (linha termina com "=" e o campo é QP). Base64 de foto também termina com "=", e não pode juntar.
 */
export function vcfLines(vcf: string) {
  const out: string[] = [];
  let qpOpen = false;
  for (const raw of vcf.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    if (out.length && (qpOpen || /^[ \t]/.test(raw))) {
      out[out.length - 1] = qpOpen ? out[out.length - 1]!.slice(0, -1) + raw : out[out.length - 1]! + raw.slice(1);
    } else out.push(raw);
    const cur = out[out.length - 1]!;
    const head = cur.slice(0, cur.indexOf(":") + 1);
    qpOpen = cur.endsWith("=") && isQp(head);
  }
  return out;
}

/** Divide em ";" que não está escapado (N e ORG têm partes). */
const splitParts = (v: string) => v.split(/(?<!\\);/);

function decodeValue(params: string, value: string) {
  let v = value;
  if (isQp(params)) {
    const bytes: number[] = [];
    for (let i = 0; i < v.length; i++) {
      if (v[i] === "=" && /^[0-9A-F]{2}$/i.test(v.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(v.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        const ch = String.fromCodePoint(v.codePointAt(i)!);
        bytes.push(...Buffer.from(ch, "utf8"));
        i += ch.length - 1;
      }
    }
    const buf = Buffer.from(bytes);
    const latin = /CHARSET=(?:ISO-8859-1|WINDOWS-1252|LATIN1)/i.test(params);
    const utf = buf.toString("utf8");
    // sem charset dito e com byte que não é UTF-8, é latin1 (celular antigo)
    v = latin || utf.includes("\uFFFD") ? buf.toString("latin1") : utf;
  } else if (/ENCODING=(?:B|BASE64)(?:;|$)/i.test(params)) {
    v = Buffer.from(v, "base64").toString("utf8");
  }
  return v
    .replace(/\\n/gi, " ")
    .replace(/\\([,;:\\])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const LABELS: Record<string, string> = { cell: "celular", mobile: "celular", work: "trabalho", home: "casa", main: "principal", iphone: "celular" };

/**
 * Lê um arquivo .vcf (iPhone, Android, Google, Samsung). O nome vem do FN; sem ele, do N (nome + sobrenome),
 * do apelido, da empresa ou do e-mail. Sem número, o contato fica de fora; sem nome nenhum também.
 */
export function parseVcf(vcf: string): ContactInput[] {
  const out: ContactInput[] = [];
  let card: { fn: string; n: string; nick: string; org: string; email: string; phones: ContactInput["phones"] } | null = null;
  for (const line of vcfLines(vcf)) {
    const m = line.match(/^(?:[A-Za-z0-9-]+\.)?([A-Za-z-]+)((?:;[^:]*)?):(.*)$/);
    if (!m) continue;
    const [, key, params, value] = m as unknown as [string, string, string, string];
    const k = key.toUpperCase();
    if (k === "BEGIN" && /^VCARD$/i.test(value.trim())) {
      card = { fn: "", n: "", nick: "", org: "", email: "", phones: [] };
      continue;
    }
    if (!card) continue;
    if (k === "END" && /^VCARD$/i.test(value.trim())) {
      const name = [card.fn, card.n, card.nick, card.org, card.email].find(hasName) ?? "";
      if (name && card.phones.length) out.push({ name: name.slice(0, 80), phones: card.phones });
      card = null;
    } else if (k === "FN") card.fn = decodeValue(params, value);
    else if (k === "N") {
      const [last = "", first = "", middle = "", prefix = "", suffix = ""] = splitParts(value).map((p) => decodeValue(params, p));
      card.n = [prefix, first, middle, last, suffix].filter(hasName).join(" ");
    } else if (k === "NICKNAME") card.nick = decodeValue(params, value).split(",")[0]!.trim();
    else if (k === "ORG") card.org = splitParts(value).map((p) => decodeValue(params, p)).filter(hasName).join(" - ");
    else if (k === "EMAIL" && !card.email) card.email = decodeValue(params, value).split("@")[0]!.replace(/[._]+/g, " ").trim();
    else if (k === "TEL") {
      const type = params.match(/TYPE=([^;:]+)/i)?.[1]?.split(",")[0]?.toLowerCase() ?? params.replace(/^;/, "").split(";")[0]?.toLowerCase();
      card.phones.push({ number: decodeValue("", value.replace(/^tel:/i, "")), label: type ? LABELS[type] : undefined });
    }
  }
  return out;
}

/** Junta a lista na agenda: o mesmo número só atualiza o nome. Devolve quantos entraram e quantos ficaram de fora. */
export async function importContacts(userId: string, list: ContactInput[], source: string) {
  const rows = new Map<string, { name: string; label: string | null }>();
  let skipped = 0;
  for (const c of list.slice(0, MAX_CONTACTS * 2)) {
    const name = String(c?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    const phones = Array.isArray(c?.phones) ? c.phones.slice(0, 6) : [];
    if (!hasName(name) || !phones.length) {
      skipped++;
      continue;
    }
    let any = false;
    for (const p of phones) {
      const phone = cleanContactPhone(typeof p === "string" ? p : p?.number);
      if (!phone) continue;
      any = true;
      rows.set(phone, { name, label: typeof p === "object" && p?.label ? String(p.label).slice(0, 20) : null });
    }
    if (!any) skipped++;
  }
  const have = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM phonebook WHERE user_id = $1", [userId]);
  const room = MAX_CONTACTS - (have?.n ?? 0);
  const entries = [...rows.entries()];
  // o que já existe só atualiza; o que é novo respeita o limite
  const existing = new Set((await many<{ phone: string }>("SELECT phone FROM phonebook WHERE user_id = $1 AND phone = ANY($2)", [userId, entries.map(([p]) => p)])).map((r) => r.phone));
  let fresh = 0;
  const keep = entries.filter(([p]) => existing.has(p) || fresh++ < room);
  const over = entries.length - keep.length;
  for (let i = 0; i < keep.length; i += 500) {
    const chunk = keep.slice(i, i + 500);
    await query(
      `INSERT INTO phonebook (user_id, name, name_key, phone, label, source)
       SELECT $1, n, k, p, l, $6 FROM unnest($2::text[], $3::text[], $4::text[], $5::text[]) AS t(n, k, p, l)
       ON CONFLICT (user_id, phone) DO UPDATE SET name = EXCLUDED.name, name_key = EXCLUDED.name_key, label = COALESCE(EXCLUDED.label, phonebook.label), updated_at = now()`,
      [userId, chunk.map(([, r]) => r.name), chunk.map(([, r]) => nameKey(r.name)), chunk.map(([p]) => p), chunk.map(([, r]) => r.label), source.slice(0, 20)],
    );
  }
  return { saved: keep.length, added: keep.filter(([p]) => !existing.has(p)).length, skipped, over_limit: over };
}

export async function saveContact(userId: string, name: string, phone: string, source = "assistente") {
  const p = cleanContactPhone(phone);
  if (!p) throw new Error("Número inválido: mande com DDD.");
  const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!hasName(n)) throw new Error("Falta o nome.");
  const r = await importContacts(userId, [{ name: n, phones: [{ number: phone }] }], source);
  if (!r.saved) throw new Error(`A agenda chegou no limite de ${MAX_CONTACTS} contatos.`);
  return { name: n, phone: p };
}

/** Grafia "pelo som", para achar mesmo escrito diferente: Thaís = Tais, Kauã = Caua, Luiz = Luis, Mayara = Maiara. */
export function soundKey(s: string) {
  return nameKey(s)
    .replace(/ph/g, "f")
    .replace(/th/g, "t")
    .replace(/y/g, "i")
    .replace(/k/g, "c")
    .replace(/w/g, "v")
    .replace(/z/g, "s")
    .replace(/qu/g, "c")
    .replace(/(^|[^cln])h/g, "$1")
    .replace(/([a-z])\1+/g, "$1");
}

function lev(a: string, b: string) {
  if (a === b) return 0;
  if (!a.length || !b.length) return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

const sim = (a: string, b: string) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);

/**
 * Quanto um nome parece com o que foi digitado (0 a 1), tolerando erro de digitação, acento, espaço a mais ou a menos
 * e grafias que soam igual. Cada palavra digitada precisa achar uma parecida no nome (ou o começo dela).
 */
export function nameScore(query: string, name: string) {
  const q = soundKey(query);
  const n = soundKey(name);
  if (!q || !n) return 0;
  const qs = q.replace(/ /g, "");
  const ns = n.replace(/ /g, "");
  if (ns.includes(qs)) return 1;
  const nameWords = n.split(" ");
  const perWord = q.split(" ").map((w) =>
    Math.max(
      ...nameWords.map((nw) => Math.max(sim(w, nw), nw.length > w.length && w.length >= 3 ? sim(w, nw.slice(0, w.length)) - 0.05 : 0)),
    ),
  );
  const words = perWord.reduce((a, b) => a + b, 0) / perWord.length;
  // a palavra mais fraca não pode ser muito ruim: "ana souza" não acha "ana lima"
  const weakest = Math.min(...perWord);
  return Math.max(weakest < 0.5 ? 0 : words, sim(qs, ns));
}

/** Corte do "parecido": curto tolera 1 letra trocada, longo tolera mais. */
export const fuzzyOk = (query: string, score: number) => score >= (soundKey(query).replace(/ /g, "").length <= 4 ? 0.74 : 0.62);

type Found = { id: string; name: string; phone: string; label: string | null; approximate?: true };

/**
 * Busca pelo nome (sem acento, qualquer parte) ou pelo número. Primeiro quem começa com o que foi digitado.
 * Sem achar assim, procura parecidos (erro de digitação, grafia diferente) e marca como approximate.
 */
export async function searchContacts(userId: string, q: string, limit = 5): Promise<Found[]> {
  const key = nameKey(q);
  const digits = q.replace(/\D/g, "");
  if (!key && !digits) return [];
  const words = key.split(" ").filter(Boolean);
  const byDigits = Boolean(digits) && !words.some((w) => /\D/.test(w));
  const exact = await many<Found>(
    `SELECT id, name, phone, label FROM phonebook
      WHERE user_id = $1 AND (
        ($2::text[] <> '{}' AND (SELECT bool_and(name_key LIKE '%' || w || '%') FROM unnest($2::text[]) AS w))
        OR ($3 <> '' AND length($3) >= 4 AND phone LIKE '%' || $3 || '%'))
      ORDER BY (name_key LIKE $4 || '%') DESC, length(name), name LIMIT $5`,
    [userId, byDigits ? [] : words, digits, key, limit],
  );
  if (exact.length || byDigits || key.replace(/ /g, "").length < 3) return exact;
  // a agenda tem no máximo MAX_CONTACTS nomes: comparar aqui é rápido e não precisa de extensão no banco
  const all = await many<Found>("SELECT id, name, phone, label FROM phonebook WHERE user_id = $1", [userId]);
  return all
    .map((c) => ({ c, score: nameScore(q, c.name) }))
    .filter((x) => fuzzyOk(q, x.score))
    .sort((a, b) => b.score - a.score || a.c.name.length - b.c.name.length)
    .slice(0, limit)
    .map((x) => ({ ...x.c, approximate: true as const }));
}

/** Já tem esse número na agenda? (para não trocar o nome que a pessoa deu) */
export async function hasContactPhone(userId: string, phone: string) {
  const p = cleanContactPhone(phone);
  return p ? Boolean(await one("SELECT 1 FROM phonebook WHERE user_id = $1 AND phone = $2", [userId, p])) : false;
}

/** Sem letra nem número no nome (";;;;" de importação antiga): vai para o fim e aparece como "Sem nome". */
const NO_NAME_SQL = "name !~ '[[:alnum:]]'";

export async function listPhonebook(userId: string, q: string, limit = 100, offset = 0, onlyNoName = false) {
  const counts = await one<{ n: number; noname: number }>(
    `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ${NO_NAME_SQL})::int AS noname FROM phonebook WHERE user_id = $1`,
    [userId],
  );
  const items = q.trim()
    ? await searchContacts(userId, q, limit)
    : await many(
        `SELECT id, name, phone, label FROM phonebook WHERE user_id = $1${onlyNoName ? ` AND ${NO_NAME_SQL}` : ""} ORDER BY (${NO_NAME_SQL}), name_key, phone LIMIT $2 OFFSET $3`,
        [userId, limit, offset],
      );
  return { total: counts?.n ?? 0, noname: counts?.noname ?? 0, items };
}

/** Troca o nome de um contato (na tela Contatos). */
export async function renameContact(userId: string, id: string, name: string) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!hasName(n)) throw new Error("Escreva o nome.");
  const row = await one("UPDATE phonebook SET name = $3, name_key = $4, updated_at = now() WHERE user_id = $1 AND id = $2 RETURNING id", [userId, id, n, nameKey(n)]);
  if (!row) throw new Error("Contato não encontrado");
  return { id, name: n };
}

export async function deleteContact(userId: string, id: string) {
  await query("DELETE FROM phonebook WHERE user_id = $1 AND id = $2", [userId, id]);
}

export async function clearPhonebook(userId: string) {
  await query("DELETE FROM phonebook WHERE user_id = $1", [userId]);
}

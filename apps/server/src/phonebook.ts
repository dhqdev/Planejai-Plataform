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

function unfold(vcf: string) {
  // linhas dobradas do vCard começam com espaço ou tab; quoted-printable termina com "="
  return vcf.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").replace(/=\n/g, "");
}

function decodeValue(params: string, value: string) {
  let v = value;
  if (/ENCODING=QUOTED-PRINTABLE/i.test(params)) {
    const bytes: number[] = [];
    for (let i = 0; i < v.length; i++) {
      if (v[i] === "=" && /^[0-9A-F]{2}$/i.test(v.slice(i + 1, i + 3))) {
        bytes.push(Number.parseInt(v.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(v.charCodeAt(i));
    }
    v = Buffer.from(bytes).toString("utf8");
  }
  return v.replace(/\\,/g, ",").replace(/\;/g, ";").replace(/\\n/gi, " ").trim();
}

const LABELS: Record<string, string> = { cell: "celular", mobile: "celular", work: "trabalho", home: "casa", main: "principal", iphone: "celular" };

/** Lê um arquivo .vcf (iPhone, Android, Google). Sem número, o contato fica de fora. */
export function parseVcf(vcf: string): ContactInput[] {
  const out: ContactInput[] = [];
  for (const card of unfold(vcf).split(/BEGIN:VCARD/i).slice(1)) {
    let fn = "";
    let n = "";
    let org = "";
    const phones: ContactInput["phones"] = [];
    for (const line of card.split("\n")) {
      const m = line.match(/^(?:item\d+\.)?([A-Za-z-]+)((?:;[^:]*)?):(.*)$/);
      if (!m) continue;
      const [, key, params, value] = m as unknown as [string, string, string, string];
      const k = key.toUpperCase();
      if (k === "FN") fn = decodeValue(params, value);
      else if (k === "N") {
        const [last = "", first = "", middle = ""] = decodeValue(params, value.replace(/\;/g, "\u0000")).split(";").map((p) => p.replace(/\u0000/g, ";").trim());
        n = [first, middle, last].filter(Boolean).join(" ");
      } else if (k === "ORG") org = decodeValue(params, value).split(";")[0]!.trim();
      else if (k === "TEL") {
        const type = params.match(/TYPE=([^;:]+)/i)?.[1]?.split(",")[0]?.toLowerCase() ?? params.replace(/^;/, "").split(";")[0]?.toLowerCase();
        phones.push({ number: value.replace(/^tel:/i, "").trim(), label: type ? LABELS[type] : undefined });
      }
    }
    const name = (fn || n || org).slice(0, 80);
    if (name && phones.length) out.push({ name, phones });
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
    if (!name || !phones.length) {
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
  if (!n) throw new Error("Falta o nome.");
  const r = await importContacts(userId, [{ name: n, phones: [{ number: phone }] }], source);
  if (!r.saved) throw new Error(`A agenda chegou no limite de ${MAX_CONTACTS} contatos.`);
  return { name: n, phone: p };
}

/** Busca pelo nome (sem acento, qualquer parte) ou pelo número. Primeiro quem começa com o que foi digitado. */
export async function searchContacts(userId: string, q: string, limit = 5) {
  const key = nameKey(q);
  const digits = q.replace(/\D/g, "");
  if (!key && !digits) return [];
  const words = key.split(" ").filter(Boolean);
  return many<{ id: string; name: string; phone: string; label: string | null }>(
    `SELECT id, name, phone, label FROM phonebook
      WHERE user_id = $1 AND (
        ($2::text[] <> '{}' AND (SELECT bool_and(name_key LIKE '%' || w || '%') FROM unnest($2::text[]) AS w))
        OR ($3 <> '' AND length($3) >= 4 AND phone LIKE '%' || $3 || '%'))
      ORDER BY (name_key LIKE $4 || '%') DESC, length(name), name LIMIT $5`,
    [userId, digits && !words.some((w) => /\D/.test(w)) ? [] : words, digits, key, limit],
  );
}

export async function listPhonebook(userId: string, q: string, limit = 100, offset = 0) {
  const total = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM phonebook WHERE user_id = $1", [userId]);
  const items = q.trim()
    ? await searchContacts(userId, q, limit)
    : await many("SELECT id, name, phone, label FROM phonebook WHERE user_id = $1 ORDER BY name_key LIMIT $2 OFFSET $3", [userId, limit, offset]);
  return { total: total?.n ?? 0, items };
}

export async function deleteContact(userId: string, id: string) {
  await query("DELETE FROM phonebook WHERE user_id = $1 AND id = $2", [userId, id]);
}

export async function clearPhonebook(userId: string) {
  await query("DELETE FROM phonebook WHERE user_id = $1", [userId]);
}

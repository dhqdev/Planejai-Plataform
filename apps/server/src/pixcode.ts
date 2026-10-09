/**
 * Pix "copia e cola" (BR Code, padrão EMV do Banco Central): lê o código sem rede nenhuma.
 * Serve para conferir antes de pagar: o código está inteiro (CRC certo), quem recebe e o valor, quando vem escrito.
 * Pix dinâmico de loja às vezes não traz o valor no código (só a URL da cobrança): aí quem confirma é o decode do Asaas.
 */

export interface PixCode {
  payload: string;
  /** valor em centavos escrito no código (campo 54), se tiver */
  cents: number | null;
  receiver: string | null;
  city: string | null;
  /** cobrança dinâmica (tem URL no campo 26/25) */
  dynamic: boolean;
}

function fields(s: string): Map<string, string> | null {
  const out = new Map<string, string>();
  let i = 0;
  while (i < s.length) {
    const id = s.slice(i, i + 2);
    const len = Number(s.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(len) || i + 4 + len > s.length) return null;
    out.set(id, s.slice(i + 4, i + 4 + len));
    i += 4 + len;
  }
  return out;
}

/** CRC16-CCITT (polinômio 0x1021, início 0xFFFF), o mesmo do BR Code. */
export function crc16(s: string) {
  let crc = 0xffff;
  for (const byte of Buffer.from(s, "utf8")) {
    crc ^= byte << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Código Pix válido e lido, ou null (cortado, digitado errado, não é Pix). */
export function parsePixCode(raw: string): PixCode | null {
  const payload = String(raw ?? "").replace(/[\r\n]+/g, "").trim();
  if (payload.length < 40 || payload.length > 600 || !payload.startsWith("000201")) return null;
  const crcAt = payload.lastIndexOf("6304");
  if (crcAt < 0 || crcAt + 8 !== payload.length) return null;
  if (crc16(payload.slice(0, crcAt + 4)) !== payload.slice(crcAt + 4).toUpperCase()) return null;
  const top = fields(payload);
  if (!top) return null;
  const account = fields(top.get("26") ?? "");
  if (!account || (account.get("00") ?? "").toLowerCase() !== "br.gov.bcb.pix") return null;
  const amount = top.get("54");
  const cents = amount && /^\d+(\.\d{1,2})?$/.test(amount) ? Math.round(Number(amount) * 100) : null;
  return {
    payload,
    cents: cents && cents > 0 ? cents : null,
    receiver: top.get("59")?.trim() || null,
    city: top.get("60")?.trim() || null,
    dynamic: account.has("25"),
  };
}

/** Monta um BR Code (usado nos testes e no sandbox). */
export function buildPixCode(o: { key?: string; url?: string; cents?: number; receiver: string; city: string; txid?: string }) {
  const f = (id: string, v: string) => `${id}${String(v.length).padStart(2, "0")}${v}`;
  const account = f("00", "br.gov.bcb.pix") + (o.url ? f("25", o.url) : f("01", o.key ?? ""));
  const body =
    f("00", "01") +
    f("26", account) +
    f("52", "0000") +
    f("53", "986") +
    (o.cents ? f("54", (o.cents / 100).toFixed(2)) : "") +
    f("58", "BR") +
    f("59", o.receiver.slice(0, 25)) +
    f("60", o.city.slice(0, 15)) +
    f("62", f("05", o.txid ?? "***")) +
    "6304";
  return body + crc16(body);
}

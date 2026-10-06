/** Diferença (ms) entre o horário local no fuso e UTC naquele instante. */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Converte "2026-10-10T14:30" (horário local do fuso) em Date.
 * Se a string já tem Z ou offset (+03:00), respeita.
 */
export function parseLocalDateTime(input: string, timeZone: string): Date {
  const s = input.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) throw new Error(`Data inválida: ${input}`);
    return d;
  }
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`Data inválida (use AAAA-MM-DDTHH:MM): ${input}`);
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  ts = guess - tzOffsetMs(new Date(ts), timeZone); // ajuste em viradas de horário de verão
  return new Date(ts);
}

export function formatLocal(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone, dateStyle: "full", timeStyle: "short" }).format(date);
}

/** ISO local sem offset, ex.: 2026-10-06T14:45 */
export function isoLocal(date: Date, timeZone: string) {
  const local = new Date(date.getTime() + tzOffsetMs(date, timeZone));
  return local.toISOString().slice(0, 16);
}

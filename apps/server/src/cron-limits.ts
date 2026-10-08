/** Campo de minutos de um cron: aceita minuto fixo, lista espaçada ou "a cada N" com N grande o bastante. */
export function minuteFieldOk(f: string, minMinutes: number) {
  const step = /^\*\/(\d+)$/.exec(f);
  if (step) return Number(step[1]) >= minMinutes;
  if (!/^\d+(,\d+)*$/.test(f)) return false;
  const m = f.split(",").map(Number).sort((a, b) => a - b);
  return m.every((v, i) => (i === 0 ? v + 60 - m.at(-1)! : v - m[i - 1]!) >= minMinutes || m.length === 1);
}

/** Motivo pelo qual o cron dispara mais que a cada minMinutes, ou null se está bom. */
export function cronTooFrequent(expression: string, minMinutes: number): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return "expressão cron inválida";
  // com 6 campos o primeiro é o segundo, que tem de ser fixo
  if (parts.length === 6 && !/^\d+$/.test(parts[0]!)) return "cron com segundos variáveis";
  if (!minuteFieldOk(parts[parts.length - 5]!, minMinutes)) return `cron "${expression}"`;
  return null;
}

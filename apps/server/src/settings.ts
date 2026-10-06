import { config } from "./config.js";
import { many, query } from "./db/pool.js";

export interface AgentSettings {
  assistantName: string;
  /** Instruções extras de personalidade, editáveis no dashboard */
  persona: string;
  timezone: string;
  language: string;
}

const defaults = (): AgentSettings => ({
  assistantName: "Planejai",
  persona: "",
  timezone: config.DEFAULT_TIMEZONE,
  language: "pt-BR",
});

let cache: { at: number; value: AgentSettings } | null = null;

export async function getSettings(): Promise<AgentSettings> {
  if (cache && Date.now() - cache.at < 10_000) return cache.value;
  const rows = await many<{ key: string; value: any }>("SELECT key, value FROM settings");
  const value = { ...defaults() } as any;
  for (const r of rows) if (r.key in value) value[r.key] = r.value;
  cache = { at: Date.now(), value };
  return value;
}

export async function saveSettings(patch: Partial<AgentSettings>) {
  const allowed = Object.keys(defaults());
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    await query(
      "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()",
      [k, JSON.stringify(v)],
    );
  }
  cache = null;
  return getSettings();
}

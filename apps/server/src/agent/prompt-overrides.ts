import { createHash } from "node:crypto";
import { many } from "../db/pool.js";
import type { AgentDef } from "./team.js";

/**
 * Prompts que o dono editou no Mapa do time (tabela agent_prompts). Sem linha, vale o texto do código.
 * Cache curto: a API grava e o worker enxerga em até 15 s, sem LISTEN nem reinício.
 */
export interface PromptOverride {
  role: string | null;
  instructions: string | null;
  base_hash: string | null;
  updated_at: string;
}

const TTL_MS = 15_000;
let cache: { at: number; map: Map<string, PromptOverride> } | null = null;

export async function promptOverrides(): Promise<Map<string, PromptOverride>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.map;
  let map: Map<string, PromptOverride>;
  try {
    const rows = await many<PromptOverride & { agent: string }>("SELECT agent, role, instructions, base_hash, updated_at FROM agent_prompts");
    map = new Map(rows.map((r) => [r.agent, r]));
  } catch {
    // banco fora do ar: segue com o último que leu (ou com o padrão do código)
    map = cache?.map ?? new Map();
  }
  cache = { at: Date.now(), map };
  return map;
}

/** Depois de salvar: o próximo pedido lê de novo (neste processo; os outros em até 15 s). */
export function forgetPromptOverrides() {
  cache = null;
}

const filled = (s: string | null | undefined) => (s != null && s.trim() ? s : null);

/** Texto de um prompt fixo (bastidores, regras do time, regras do CTO): o editado ou o padrão. */
export async function promptText(id: string, fallback: string) {
  return filled((await promptOverrides()).get(id)?.instructions) ?? fallback;
}

/** Especialista com o papel e as instruções editados pelo dono (o resto continua do código). */
export function withPrompt(def: AgentDef, map: Map<string, PromptOverride>): AgentDef {
  const o = map.get(def.id);
  if (!o) return def;
  return { ...def, role: filled(o.role) ?? def.role, instructions: filled(o.instructions) ?? def.instructions };
}

/** Resumo do texto padrão, para saber se o código mudou depois de uma edição. */
export const promptHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

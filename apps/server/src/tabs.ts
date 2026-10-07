import { one, query } from "./db/pool.js";

/**
 * Abas do app de cada pessoa. Todo mundo começa só com o essencial (Início, Agenda, Finanças e De olho);
 * a reunião noturna do time libera módulos e cria abas sob medida conforme o uso. Menos tela,
 * menos ferramenta no prompt e menos token.
 */
export const ESSENTIAL = ["inicio", "agenda", "financas", "de_olho"] as const;
export const OPTIONAL: Record<string, { label: string; icon: string; to: string; desc: string }> = {
  convites: { label: "Convites", icon: "user-plus", to: "/invites", desc: "convidar pessoas e ver contatos (para quem compartilha coisas)" },
  memorias: { label: "O que ele sabe", icon: "bookmark", to: "/memories", desc: "o que o assistente guardou sobre a pessoa" },
  meu_time: { label: "Meu time", icon: "brain", to: "/time", desc: "os agentes criados para a pessoa, com nome e carinha" },
};
/** Widgets que uma aba sob medida pode ter (os mesmos do painel do cliente). */
export const TAB_WIDGETS = ["expenses", "income", "messages", "watchCount", "team", "invites", "categories", "reminders", "recentTx", "watches"];
export const TAB_ICONS = ["sparkle", "heart", "car", "plane", "book", "ticket", "cart", "food", "home", "briefcase", "trend", "target", "calendar", "wallet", "eye"];

export interface CustomTab {
  slug: string;
  title: string;
  icon: string;
  widgets: string[];
}
export interface AppTabs {
  modules: string[];
  custom: CustomTab[];
}

export function normalizeTabs(raw: any): AppTabs {
  const modules = [...new Set((Array.isArray(raw?.modules) ? raw.modules : []).filter((m: string) => m in OPTIONAL))] as string[];
  const custom = (Array.isArray(raw?.custom) ? raw.custom : [])
    .map((t: any) => ({
      slug: String(t.slug ?? t.title ?? "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 24),
      title: String(t.title ?? "").slice(0, 24),
      icon: TAB_ICONS.includes(t.icon) ? t.icon : "sparkle",
      widgets: (Array.isArray(t.widgets) ? t.widgets : []).filter((w: string) => TAB_WIDGETS.includes(w)).slice(0, 8),
    }))
    .filter((t: CustomTab, i: number, all: CustomTab[]) => t.slug && t.title && t.widgets.length && all.findIndex((o) => o.slug === t.slug) === i);
  return { modules, custom: custom.slice(0, 3) };
}

export async function getTabs(userId: string): Promise<AppTabs> {
  const r = await one("SELECT app_tabs FROM users WHERE id = $1", [userId]);
  return normalizeTabs(r?.app_tabs);
}

export async function saveTabs(userId: string, tabs: AppTabs) {
  await query("UPDATE users SET app_tabs = $2 WHERE id = $1", [userId, JSON.stringify(normalizeTabs(tabs))]);
}

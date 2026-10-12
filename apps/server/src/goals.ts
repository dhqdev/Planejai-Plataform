import { many, one, query } from "./db/pool.js";
import { brl, parseAmount } from "./agent/tools/finance.js";
import { isoLocal } from "./time.js";

/**
 * Metas financeiras ("juntar R$ 2.000 até dezembro"). Valores em reais com 2 casas, contas em centavos.
 * O painel (Finanças > Metas) e o Moacir (goal_*) usam as mesmas funções.
 */
export const MAX_GOALS = 10;

export interface GoalRow {
  id: string;
  title: string;
  target: string;
  saved: string;
  deadline: string | null;
  done_at: string | null;
  created_at: string;
}

const c = (v: unknown) => Math.round(Number(v ?? 0) * 100);

/** Progresso e quanto guardar por mês até o prazo (centavos inteiros, arredondado para cima). */
export function goalProgress(g: Pick<GoalRow, "target" | "saved" | "deadline">, today: string) {
  const target = c(g.target);
  const saved = c(g.saved);
  const left = Math.max(0, target - saved);
  const pct = target ? Math.min(100, Math.floor((saved * 100) / target)) : 0;
  let months: number | null = null;
  let perMonth: number | null = null;
  if (g.deadline && left > 0) {
    const [y1, m1, d1] = today.split("-").map(Number) as [number, number, number];
    const [y2, m2, d2] = String(g.deadline).slice(0, 10).split("-").map(Number) as [number, number, number];
    // meses que ainda dá para guardar, contando o atual; prazo vencido = tudo agora
    months = Math.max(1, (y2 - y1) * 12 + (m2 - m1) + (d2 >= d1 ? 1 : 0));
    perMonth = Math.ceil(left / months);
  }
  return { target, saved, left, pct, months, perMonth };
}

export function describeGoal(g: GoalRow, tz: string) {
  const p = goalProgress(g, isoLocal(new Date(), tz).slice(0, 10));
  return {
    id: g.id,
    title: g.title,
    target: brl(p.target / 100),
    saved: brl(p.saved / 100),
    left: brl(p.left / 100),
    percent: `${p.pct}%`,
    ...(g.deadline ? { deadline: String(g.deadline).slice(0, 10).split("-").reverse().join("/") } : {}),
    ...(p.perMonth != null ? { per_month: brl(p.perMonth / 100), months_left: p.months } : {}),
    ...(g.done_at ? { done: true } : {}),
  };
}

const dateOk = (d: unknown) => (d == null || d === "" ? null : /^\d{4}-\d{2}-\d{2}$/.test(String(d)) ? String(d) : (() => { throw new Error("Prazo inválido (use AAAA-MM-DD)"); })());

export async function listGoals(userId: string, all = false) {
  return many<GoalRow>(
    `SELECT id, title, target, saved, to_char(deadline, 'YYYY-MM-DD') AS deadline, done_at, created_at FROM finance_goals
      WHERE user_id = $1 ${all ? "" : "AND (done_at IS NULL OR done_at > now() - interval '30 days')"} ORDER BY done_at NULLS FIRST, created_at`,
    [userId],
  );
}

export async function findGoal(userId: string, ref: { id?: string; title?: string }) {
  if (ref.id && /^[0-9a-f-]{36}$/i.test(ref.id)) return one<GoalRow>("SELECT *, to_char(deadline, 'YYYY-MM-DD') AS deadline FROM finance_goals WHERE user_id = $1 AND id = $2", [userId, ref.id]);
  const t = ref.title?.trim();
  if (!t) throw new Error("Diga qual meta (id ou nome)");
  const rows = await many<GoalRow>("SELECT *, to_char(deadline, 'YYYY-MM-DD') AS deadline FROM finance_goals WHERE user_id = $1 AND title ILIKE $2 ORDER BY done_at NULLS FIRST, created_at LIMIT 3", [userId, `%${t}%`]);
  if (rows.length > 1 && rows[0]!.title.toLowerCase() !== t.toLowerCase()) throw new Error(`Mais de uma meta parecida: ${rows.map((r) => r.title).join(", ")}. Qual delas?`);
  return rows[0];
}

export async function createGoal(userId: string, p: { title?: string; target?: unknown; deadline?: unknown; saved?: unknown }) {
  const title = String(p.title ?? "").trim().slice(0, 60);
  if (!title) throw new Error("Dê um nome para a meta");
  const target = parseAmount(p.target);
  if (target <= 0) throw new Error("O valor da meta precisa ser maior que zero");
  const saved = p.saved == null || p.saved === "" ? 0 : parseAmount(p.saved);
  const n = await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM finance_goals WHERE user_id = $1 AND done_at IS NULL", [userId]);
  if ((n?.n ?? 0) >= MAX_GOALS) throw new Error(`Você já tem ${MAX_GOALS} metas abertas. Conclua ou apague uma antes.`);
  const g = await one<GoalRow>(
    `INSERT INTO finance_goals (user_id, title, target, saved, deadline, done_at) VALUES ($1, $2, $3, $4, $5, CASE WHEN $4::numeric >= $3::numeric THEN now() END)
     RETURNING id, title, target, saved, to_char(deadline, 'YYYY-MM-DD') AS deadline, done_at, created_at`,
    [userId, title, target, saved, dateOk(p.deadline)],
  );
  if (saved > 0) await query("INSERT INTO finance_goal_moves (goal_id, amount, note) VALUES ($1, $2, 'já guardado')", [g!.id, saved]);
  return g!;
}

export async function updateGoal(userId: string, id: string, p: { title?: string; target?: unknown; deadline?: unknown }) {
  const title = p.title === undefined ? null : String(p.title).trim().slice(0, 60) || null;
  const target = p.target === undefined || p.target === null || p.target === "" ? null : parseAmount(p.target);
  if (target !== null && target <= 0) throw new Error("O valor da meta precisa ser maior que zero");
  const g = await one<GoalRow>(
    `UPDATE finance_goals SET title = COALESCE($3, title), target = COALESCE($4, target),
        deadline = CASE WHEN $6 THEN $5::date ELSE deadline END, updated_at = now(),
        done_at = CASE WHEN saved >= COALESCE($4, target) THEN COALESCE(done_at, now()) ELSE NULL END
      WHERE user_id = $1 AND id = $2 RETURNING id, title, target, saved, to_char(deadline, 'YYYY-MM-DD') AS deadline, done_at, created_at`,
    [userId, id, title, target, p.deadline === undefined ? null : dateOk(p.deadline), p.deadline !== undefined],
  );
  if (!g) throw new Error("Meta não encontrada");
  return g;
}

/** Guarda (positivo) ou tira (negativo) dinheiro da meta. Nunca fica abaixo de zero. */
export async function moveGoal(userId: string, id: string, amount: unknown, withdraw = false, note?: string) {
  const raw = typeof amount === "number" ? amount : String(amount ?? "");
  const negative = withdraw || (typeof raw === "number" ? raw < 0 : raw.trim().startsWith("-"));
  const value = parseAmount(raw);
  if (value <= 0) throw new Error("Diga quanto guardar ou tirar");
  const delta = negative ? -value : value;
  const g = await one<GoalRow>(
    `UPDATE finance_goals SET saved = saved + $3, updated_at = now(),
        done_at = CASE WHEN saved + $3 >= target THEN COALESCE(done_at, now()) ELSE NULL END
      WHERE user_id = $1 AND id = $2 AND saved + $3 >= 0
      RETURNING id, title, target, saved, to_char(deadline, 'YYYY-MM-DD') AS deadline, done_at, created_at`,
    [userId, id, delta],
  );
  if (!g) {
    const exists = await one("SELECT saved FROM finance_goals WHERE user_id = $1 AND id = $2", [userId, id]);
    throw new Error(exists ? `Só tem ${brl(Number(exists.saved))} guardado nessa meta` : "Meta não encontrada");
  }
  await query("INSERT INTO finance_goal_moves (goal_id, amount, note) VALUES ($1, $2, $3)", [id, delta, note?.slice(0, 120) ?? null]);
  return g;
}

export async function goalMoves(userId: string, id: string) {
  return many(
    `SELECT m.amount, m.note, m.created_at FROM finance_goal_moves m JOIN finance_goals g ON g.id = m.goal_id
      WHERE g.user_id = $1 AND g.id = $2 ORDER BY m.created_at DESC LIMIT 30`,
    [userId, id],
  );
}

export async function deleteGoal(userId: string, id: string) {
  return Boolean(await one("DELETE FROM finance_goals WHERE user_id = $1 AND id = $2 RETURNING id", [userId, id]));
}

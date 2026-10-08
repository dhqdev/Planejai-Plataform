import type { FastifyInstance } from "fastify";
import { hashPassword, normalizePhone } from "../../../accounts.js";
import { many, one, query } from "../../../db/pool.js";

/** Contas do painel (só super admin). */
export function accountRoutes(api: FastifyInstance) {
  // ---------- Contas do painel ----------
  api.get("/api/accounts", async () =>
    many(`SELECT a.id, a.email, a.name, 'admin' AS role, a.status, a.phone, a.created_at, a.last_login_at, u.status AS whatsapp_status
            FROM accounts a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.status = 'pending' DESC, a.created_at DESC`),
  );
  api.patch<{ Params: { id: string }; Body: { status?: string; role?: string } }>("/api/accounts/:id", async (req, reply) => {
    const status = req.body.status && ["active", "pending", "disabled"].includes(req.body.status) ? req.body.status : null;
    // papel não muda pelo painel: super admin é só o dono da stack
    const row = await one(
      "UPDATE accounts SET status = COALESCE($2, status), session_version = session_version + CASE WHEN $2 = 'disabled' THEN 1 ELSE 0 END WHERE id = $1 RETURNING *",
      [req.params.id, status],
    );
    if (!row) return reply.code(404).send({ error: "não encontrada" });
    // aprovar a conta libera o número no WhatsApp; desativar bloqueia
    if (row.user_id && status === "active") await query("UPDATE users SET status = 'active' WHERE id = $1 AND status = 'pending'", [row.user_id]);
    if (row.user_id && status === "disabled") await query("UPDATE users SET status = 'blocked' WHERE id = $1", [row.user_id]);
    return { ok: true };
  });
  api.delete<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
    await query("DELETE FROM accounts WHERE id = $1", [req.params.id]);
    return { ok: true };
  });
  api.post<{ Body: { name: string; email: string; password: string; phone?: string; role?: string } }>("/api/accounts", async (req, reply) => {
    const email = String(req.body.email ?? "").trim().toLowerCase();
    if (!email || String(req.body.password ?? "").length < 8) return reply.code(400).send({ error: "E-mail e senha (8+ caracteres) são obrigatórios" });
    if (await one("SELECT 1 FROM accounts WHERE email = $1", [email])) return reply.code(409).send({ error: "E-mail já cadastrado" });
    let userId: string | null = null;
    const phone = req.body.phone ? normalizePhone(req.body.phone) : null;
    if (phone) {
      const u = await one(
        `INSERT INTO users (phone, name, status) VALUES ($1, $2, 'active') ON CONFLICT (phone) DO UPDATE SET status = 'active' RETURNING id`,
        [phone, req.body.name ?? null],
      );
      userId = u.id;
    }
    return one(
      `INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ($1,$2,$3,$4,'active',$5,$6) RETURNING id, email, name, role, status`,
      [email, req.body.name ?? null, hashPassword(req.body.password), "admin", userId, phone],
    );
  });
}

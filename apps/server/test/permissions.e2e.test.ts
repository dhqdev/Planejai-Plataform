import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Varredura de permissão: duas contas comuns, cada uma com dados marcados. Nenhuma rota de leitura do painel
 * pode devolver o marcador da outra, e o dono também não vê o que é particular dos clientes.
 * Pega a regressão silenciosa de alguém mexer num SELECT e esquecer o escopo.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

const READS = [
  "/api/finance",
  "/api/finance/categories",
  "/api/bills",
  "/api/reminders",
  "/api/calendar",
  "/api/watches",
  "/api/errands",
  "/api/memories",
  "/api/documents",
  "/api/recordings",
  "/api/notifications",
  "/api/contacts",
  "/api/shares",
  "/api/me/overview",
  "/api/me/dashboard",
  "/api/me/profile",
];

describe.skipIf(!enabled)("permissão por rota (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let app: any;
  const cookieOf = (res: any) => String(res.headers["set-cookie"]).split(";")[0]!;

  async function person(phone: string, name: string, email: string, mark: string) {
    const { hashPassword } = await import("../src/accounts.js");
    const u = await db.one("INSERT INTO users (phone, name, status) VALUES ($1, $2, 'active') RETURNING id", [phone, name]);
    await db.query("INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ($1, $2, $3, 'admin', 'active', $4, $5)", [
      email,
      name,
      hashPassword("senha-forte-123"),
      u.id,
      phone,
    ]);
    const conv = await db.one("INSERT INTO conversations (user_id, channel, remote_jid) VALUES ($1, 'whatsapp', $2) RETURNING id", [u.id, `${phone}@s.whatsapp.net`]);
    await db.query("INSERT INTO transactions (user_id, kind, amount, category, description) VALUES ($1, 'expense', 10, 'Outros', $2)", [u.id, mark]);
    await db.query("INSERT INTO memories (user_id, content) VALUES ($1, $2)", [u.id, mark]);
    await db.query("INSERT INTO reminders (user_id, conversation_id, intent, due_at) VALUES ($1, $2, $3, now() + interval '1 day')", [u.id, conv.id, mark]);
    await db.query("INSERT INTO bills (user_id, description, amount, due_day) VALUES ($1, $2, 10, 5)", [u.id, mark]);
    await db.query("INSERT INTO documents (user_id, name, mimetype, size, data) VALUES ($1, $2, 'text/plain', 1, '\\x00')", [u.id, mark]);
    await db.query("INSERT INTO watches (user_id, conversation_id, kind, query) VALUES ($1, $2, 'news', $3)", [u.id, conv.id, mark]);
    await db.query("INSERT INTO errands (user_id, conversation_id, place, phone, jid, goal, expires_at) VALUES ($1, $2, $3, '5511900000000', 'x', $3, now() + interval '1 day')", [u.id, conv.id, mark]);
    await db.query("INSERT INTO notifications (user_id, kind, title) VALUES ($1, 'teste', $2)", [u.id, mark]);
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "senha-forte-123" } });
    expect(login.statusCode).toBe(200);
    return { id: u.id, cookie: cookieOf(login) };
  }

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
  });
  afterAll(async () => {
    await app?.close();
  });

  it("nenhuma tela de leitura mostra o dado de outra pessoa (nem para o dono)", async () => {
    const a = await person("5519911110001", "Ana", "ana@x.com", "MARCA_DA_ANA");
    const b = await person("5519911110002", "Beto", "beto@x.com", "MARCA_DO_BETO");
    const owner = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
    let seenOwn = 0;
    for (const url of READS) {
      for (const [who, cookie, other] of [
        ["Ana", a.cookie, "MARCA_DO_BETO"],
        ["Beto", b.cookie, "MARCA_DA_ANA"],
        ["dono", owner, "MARCA_D"],
      ] as const) {
        const r = await app.inject({ method: "GET", url, headers: { cookie } });
        expect(r.statusCode, `${who} ${url}`).toBeLessThan(500);
        expect(r.body, `${who} viu dado de outra pessoa em ${url}`).not.toContain(other);
        if (who === "Ana" && r.body.includes("MARCA_DA_ANA")) seenOwn++;
      }
      // pedir os dados de outra pessoa por ?user= sem ela ter compartilhado é recusado (ou ignorado)
      const peek = await app.inject({ method: "GET", url: `${url}?user=${b.id}`, headers: { cookie: a.cookie } });
      expect(peek.body, `Ana viu o Beto em ${url}?user=`).not.toContain("MARCA_DO_BETO");
    }
    // a varredura só vale se as telas mostram os dados da própria pessoa
    expect(seenOwn).toBeGreaterThanOrEqual(6);
  });
});

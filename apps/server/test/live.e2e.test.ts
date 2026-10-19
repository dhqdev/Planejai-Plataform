import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Painel em tempo real (GET /api/live): a mudança numa tabela do painel chega por SSE só para quem pode ver,
 * só com o nome da tabela (nunca o dado).
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("tempo real do painel (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let app: any;
  let base = "";
  let ana: any;
  let bia: any;
  const cookies: Record<string, string> = {};
  const cookieOf = (res: any) => ([] as string[]).concat(res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]!).find((c) => c.startsWith("pj_session="))!;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { upsertUser } = await import("../src/ingest.js");
    ana = await upsertUser("5519944440001", "Ana");
    bia = await upsertUser("5519944440002", "Bia");
    const { hashPassword } = await import("../src/accounts.js");
    for (const [email, u] of [["ana@x.com", ana], ["bia@x.com", bia]] as const) {
      await db.query("UPDATE users SET status = 'active' WHERE id = $1", [u.id]);
      await db.query("INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ($1, $2, $3, 'admin', 'active', $4, $5)", [email, u.name, hashPassword("senha-forte-1"), u.id, u.phone]);
    }
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    for (const email of ["ana@x.com", "bia@x.com"]) {
      const r = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password: "senha-forte-1" } });
      cookies[email] = cookieOf(r);
    }
  });

  afterAll(async () => {
    await (await import("../src/live.js")).stopLive();
    await app?.close();
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  /** Abre o SSE e junta os eventos "change" até fechar. */
  function listen(email: string) {
    const events: string[][] = [];
    let ready!: () => void;
    const isReady = new Promise<void>((r) => (ready = r));
    const req = http.get(`${base}/api/live`, { headers: { cookie: cookies[email]!, accept: "text/event-stream" } }, (res) => {
      expect(res.headers["content-type"]).toContain("text/event-stream");
      let buf = "";
      res.on("data", (c) => {
        buf += c;
        let at: number;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, at);
          buf = buf.slice(at + 2);
          if (block.includes("event: ready")) ready();
          const m = block.match(/event: change\ndata: (.*)/);
          if (m) events.push(JSON.parse(m[1]!));
        }
      });
    });
    return { events, isReady, close: () => req.destroy() };
  }

  it("cada pessoa recebe só o aviso da própria tabela, sem dado", async () => {
    const a = listen("ana@x.com");
    const b = listen("bia@x.com");
    await Promise.all([a.isReady, b.isReady]);

    await db.query("INSERT INTO memories (user_id, content) VALUES ($1, 'gosta de café')", [ana.id]);
    await db.query("INSERT INTO memories (user_id, content) VALUES ($1, 'segredo da Ana')", [ana.id]);
    await new Promise((r) => setTimeout(r, 700));

    expect(a.events.flat()).toContain("memories");
    // duas linhas seguidas viram um aviso só
    expect(a.events.length).toBe(1);
    expect(JSON.stringify(a.events)).not.toContain("café");
    expect(b.events).toEqual([]);
    a.close();
    b.close();
  });

  it("sem login não abre", async () => {
    const r = await app.inject({ method: "GET", url: "/api/live" });
    expect(r.statusCode).toBe(401);
  });
});

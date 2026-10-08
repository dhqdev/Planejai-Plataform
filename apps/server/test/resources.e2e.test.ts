import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Tela Servidor (Postgres real): quanto cada cliente ocupa, sem conteúdo, e a visão de memória/banco/disco. */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("servidor e armazenamento por cliente (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let app: any;
  let sup: string;
  let ana: any;
  let bia: any;
  const cookieOf = (res: any) =>
    ([] as string[]).concat(res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]!).find((c) => c.startsWith("pj_session="))!;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { upsertUser } = await import("../src/ingest.js");
    ana = await upsertUser("5519922220001", "Ana");
    bia = await upsertUser("5519922220002", "Bia");
    // Ana guarda um PDF de 200 KB e alguns gastos; Bia só um gasto
    await db.query("INSERT INTO documents (user_id, name, mimetype, size, data) VALUES ($1, 'contrato.pdf', 'application/pdf', 204800, $2)", [
      ana.id,
      Buffer.from(Array.from({ length: 204800 }, () => Math.floor(Math.random() * 256))),
    ]);
    for (let i = 0; i < 5; i++)
      await db.query("INSERT INTO transactions (user_id, kind, amount, description, category) VALUES ($1, 'expense', $2, 'mercado', 'Mercado')", [ana.id, 10 + i]);
    await db.query("INSERT INTO transactions (user_id, kind, amount, description, category) VALUES ($1, 'expense', 5, 'café', 'Alimentação')", [bia.id]);
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
    sup = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it("mostra quanto cada cliente ocupa, por categoria, sem devolver o conteúdo", async () => {
    const res = await app.inject({ method: "GET", url: "/api/resources/storage?fresh=1", headers: { cookie: sup } });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    const a = s.clients.find((c: any) => c.id === ana.id);
    const b = s.clients.find((c: any) => c.id === bia.id);
    expect(s.clients[0].id).toBe(ana.id); // quem ocupa mais vem primeiro
    expect(a.files).toBe(1);
    expect(a.fileBytes).toBe(204800);
    expect(a.categories.files).toBeGreaterThan(200_000);
    expect(a.categories.finance).toBeGreaterThan(b.categories.finance);
    expect(a.bytes).toBeGreaterThan(b.bytes);
    expect(s.attributed).toBeLessThanOrEqual(s.dbBytes);
    // só tamanhos: nada do texto dos lançamentos nem o nome do arquivo
    expect(res.body).not.toContain("mercado");
    expect(res.body).not.toContain("contrato.pdf");
  });

  it("visão do servidor: processo da API, banco, disco e foto do dia", async () => {
    const res = await app.inject({ method: "GET", url: "/api/resources", headers: { cookie: sup } });
    expect(res.statusCode).toBe(200);
    const o = res.json();
    expect(o.processes.length).toBeGreaterThanOrEqual(1);
    expect(o.processes[0].rss).toBeGreaterThan(0);
    expect(o.postgres.size).toBeGreaterThan(0);
    expect(o.postgres.tables.some((t: any) => t.name === "documents")).toBe(true);
    expect(o.machine.memTotal).toBeGreaterThan(0);
    expect(o.history.at(-1).files_bytes).toBe(204800);
  });
});

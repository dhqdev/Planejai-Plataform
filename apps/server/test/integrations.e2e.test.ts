import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Tela Integrações (Postgres real): app OAuth do Google ainda sem autorizar precisa salvar para o "Conectar com Google" aparecer. */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("integrações com OAuth (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let app: any;
  let sup: string;
  const cookieOf = (res: any) =>
    ([] as string[]).concat(res.headers["set-cookie"] ?? []).map((c) => c.split(";")[0]!).find((c) => c.startsWith("pj_session="))!;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { buildServer } = await import("../src/api/server.js");
    app = await buildServer();
    sup = cookieOf(await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } }));
  });
  afterAll(async () => {
    await app?.close();
  });

  it("salva Client ID e Secret do Google antes de autorizar e libera o Conectar com Google", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/integrations/google",
      headers: { cookie: sup },
      payload: { client_id: "123-abc.apps.googleusercontent.com", client_secret: "GOCSPX-teste" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toContain("Conectar com Google");
    const list = await app.inject({ method: "GET", url: "/api/integrations", headers: { cookie: sup } });
    const g = list.json().integrations.find((i: any) => i.id === "google");
    expect(g.pendingOAuth).toBe(true);
    expect(g.connected).toBe(false);
    const start = await app.inject({ method: "GET", url: "/api/integrations/google/oauth/start", headers: { cookie: sup } });
    expect(start.json().url).toContain("client_id=123-abc.apps.googleusercontent.com");
  });
});

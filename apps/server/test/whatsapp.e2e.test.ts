import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Sessão do Baileys persistida no Postgres: credenciais e chaves Signal sobrevivem a reinícios. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("sessão do WhatsApp no banco", () => {
  let db: typeof import("../src/db/pool.js");
  let auth: typeof import("../src/whatsapp/auth-state.js");

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    auth = await import("../src/whatsapp/auth-state.js");
  });
  afterAll(async () => {
    await db?.pool.end();
  });

  it("salva e recarrega credenciais e chaves com Buffers", async () => {
    const a = await auth.usePgAuthState("t1");
    expect(a.state.creds.registered).toBe(false);
    a.state.creds.registered = true;
    await a.saveCreds();
    await a.state.keys.set({ "pre-key": { "1": { public: Buffer.from([1, 2, 3]), private: Buffer.from([4, 5]) } } });

    const b = await auth.usePgAuthState("t1");
    expect(b.state.creds.registered).toBe(true);
    expect(Buffer.from(b.state.creds.noiseKey.public).equals(Buffer.from(a.state.creds.noiseKey.public))).toBe(true);
    const keys = await b.state.keys.get("pre-key", ["1", "2"]);
    expect(Buffer.from(keys["1"]!.public).equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(keys["2"]).toBeUndefined();

    await b.state.keys.set({ "pre-key": { "1": null } });
    expect(await b.state.keys.get("pre-key", ["1"])).toEqual({});
    await auth.clearAuthState("t1");
    expect((await auth.usePgAuthState("t1")).state.creds.registered).toBe(false);
  });

  it("tem a linha da sessão padrão para o dashboard", async () => {
    expect(await db.one("SELECT id, status FROM wa_sessions")).toEqual({ id: "default", status: "disconnected" });
  });
});

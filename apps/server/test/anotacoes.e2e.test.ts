import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Anotações: a Zulmira escreve pelo WhatsApp, a pessoa edita no painel, versões e conflito entre os dois. */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("anotações (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let user: any;
  let other: any;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { upsertUser } = await import("../src/ingest.js");
    user = await upsertUser("5519955553333", "Lia");
    other = await upsertUser("5519955554444", "Outra");
  });

  afterAll(async () => {
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("a Zulmira cria, acrescenta na seção, lê, renomeia e reorganiza guardando a versão anterior", async () => {
    const { noteWrite, noteRead, noteList, noteRename } = await import("../src/agent/tools/notes.js");
    const ctx: any = { user };
    const made: any = await noteWrite.run({ title: "Festa da Bia", content: "## Comidas\n- coxinha\n## Bebidas\n- suco" }, ctx);
    expect(made).toMatchObject({ ok: true, created: true, title: "Festa da Bia" });
    expect(made.link).toMatch(/\/anotacoes\/[0-9a-f-]{36}$/);

    // pelo título (sem acento/maiúscula), dentro da seção
    expect(await noteWrite.run({ title: "festa da bia", content: "- empada", under: "Comidas" }, ctx)).toMatchObject({ ok: true, updated: true, id: made.id });
    const read: any = await noteRead.run({ title: "Festa" }, ctx);
    expect(read.text).toBe("## Comidas\n- coxinha\n- empada\n## Bebidas\n- suco");

    expect(await noteRename.run({ note_id: made.id, new_title: "Aniversário da Bia" }, ctx)).toMatchObject({ ok: true, title: "Aniversário da Bia" });
    expect(await noteWrite.run({ note_id: made.id, mode: "replace", content: "# Aniversário\n[ ] bolo\n[x] convites" }, ctx)).toMatchObject({ ok: true });
    const list: any = await noteList.run({}, ctx);
    expect(list.notes).toHaveLength(1);
    expect(list.notes[0]).toMatchObject({ title: "Aniversário da Bia", start: "Aniversário bolo convites" });

    const { noteVersions } = await import("../src/notes.js");
    const versions = await noteVersions(user.id, made.id);
    expect(versions.map((v) => v.reason)).toEqual(["antes de reescrever", "antes de renomear", "antes de acrescentar"]);

    // de outra pessoa ninguém mexe
    expect(await noteRead.run({ note_id: made.id }, { user: other } as any)).toMatchObject({ ok: false });
    expect(((await noteList.run({}, { user: other } as any)) as any).notes).toEqual([]);
  });

  it("painel: lista, salva limpando o HTML, conflito com o Planejai, versões e restaurar", async () => {
    const { config } = await import("../src/config.js");
    const owners = config.OWNER_PHONES;
    config.OWNER_PHONES = [user.phone];
    try {
      const { buildServer } = await import("../src/api/server.js");
      const app = await buildServer();
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;

      const created = await app.inject({ method: "POST", url: "/api/anotacoes", headers: { cookie }, payload: { title: "Ideias", html: "<p>oi<script>x()</script></p>" } });
      expect(created.statusCode).toBe(200);
      const note = created.json();
      expect(note.html).toBe("<p>oi</p>");

      const list = await app.inject({ method: "GET", url: "/api/anotacoes", headers: { cookie } });
      expect(list.json().items.map((n: any) => n.title)).toEqual(["Ideias", "Aniversário da Bia"]);

      const saved = await app.inject({
        method: "PATCH",
        url: `/api/anotacoes/${note.id}`,
        headers: { cookie },
        payload: { html: '<h2 style="color:red">Viagem</h2><ul data-check="1"><li data-done="1">mala</li></ul><img src=x onerror=alert(1)>', since: note.updated_at },
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().html).toBe('<h2>Viagem</h2><ul data-check="1"><li data-done="1">mala</li></ul>');
      const opened = saved.json().updated_at;

      // o Planejai escreve enquanto a pessoa edita a versão antiga
      await new Promise((r) => setTimeout(r, 700));
      const { noteWrite } = await import("../src/agent/tools/notes.js");
      await noteWrite.run({ note_id: note.id, content: "- passaporte" }, { user } as any);
      const clash = await app.inject({ method: "PATCH", url: `/api/anotacoes/${note.id}`, headers: { cookie }, payload: { html: "<p>minha</p>", since: opened } });
      expect(clash.statusCode).toBe(409);
      expect(clash.json().note.html).toContain("passaporte");
      // escolheu manter a dela: o texto do Planejai vai para as versões
      const forced = await app.inject({ method: "PATCH", url: `/api/anotacoes/${note.id}`, headers: { cookie }, payload: { html: "<p>minha</p>", since: opened, force: true } });
      expect(forced.json().html).toBe("<p>minha</p>");

      const versions = (await app.inject({ method: "GET", url: `/api/anotacoes/${note.id}/versoes`, headers: { cookie } })).json().items;
      expect(versions[0].reason).toBe("o que o Planejai escreveu");
      expect(versions[0].preview).toContain("passaporte");
      const restored = await app.inject({ method: "POST", url: `/api/anotacoes/${note.id}/versoes/${versions[0].id}/restaurar`, headers: { cookie } });
      expect(restored.json().html).toContain("passaporte");

      // anotação de outra pessoa: 404
      const { createNote } = await import("../src/notes.js");
      const alheia = await createNote(other.id, { title: "Segredo" }, "pessoa");
      expect((await app.inject({ method: "GET", url: `/api/anotacoes/${alheia.id}`, headers: { cookie } })).statusCode).toBe(404);
      expect((await app.inject({ method: "PATCH", url: `/api/anotacoes/${alheia.id}`, headers: { cookie }, payload: { html: "x" } })).statusCode).toBe(404);
      expect((await app.inject({ method: "DELETE", url: `/api/anotacoes/${alheia.id}`, headers: { cookie } })).statusCode).toBe(404);

      expect((await app.inject({ method: "DELETE", url: `/api/anotacoes/${note.id}`, headers: { cookie } })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: `/api/anotacoes/${note.id}`, headers: { cookie } })).statusCode).toBe(404);
      await app.close();
    } finally {
      config.OWNER_PHONES = owners;
    }
  });
});

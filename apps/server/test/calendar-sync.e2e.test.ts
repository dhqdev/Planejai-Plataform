import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** Agenda espelhada no Google (Postgres real, Google falso): criar, mudar e cancelar acompanham; recorrente não vai. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("agenda no Google Agenda (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let tools: typeof import("../src/agent/tools/agenda.js");
  let user: any;
  let ctx: any;
  const calls: { method: string; url: string; body: any }[] = [];
  const tz = "America/Sao_Paulo";
  const local = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(d).replace(" ", "T");
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    tools = await import("../src/agent/tools/agenda.js");
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    user = await upsertUser("5519944444444", "Lia");
    ctx = { user, conversation: await upsertConversation(user.id, "playground", "teste-google"), timezone: tz };
    const reg = await import("../src/integrations/registry.js");
    await reg.saveCredentials("google", { client_id: "app", client_secret: "s" });
    await reg.savePersonalCredentials("google", user.id, { refresh_token: "r-lia", email: "lia@x.com" });
    let n = 0;
    vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "t", expires_in: 3600 });
      if (u.startsWith("https://www.googleapis.com/calendar/")) {
        calls.push({ method: init.method ?? "GET", url: u, body: init.body ? JSON.parse(init.body) : null });
        if (init.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json({ id: `g${++n}` });
      }
      return realFetch(url, init);
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await (await import("../src/queue/boss.js")).stopBoss();
  });

  it("cria no Google, muda o horário e o título lá e apaga quando cancela", async () => {
    const at = new Date(Date.now() + 2 * 86400_000);
    at.setUTCSeconds(0, 0);
    const r: any = await tools.scheduleReminder.run({ intent: "Dentista às 15h", title: "Dentista", at: local(at) }, ctx);
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { summary: "Dentista", extendedProperties: { private: { planejai: r.id } } } });
    const row = await db.one("SELECT google_event_id FROM reminders WHERE id = $1", [r.id]);
    expect(row.google_event_id).toBe("g1");

    const later = new Date(at.getTime() + 3600_000);
    await tools.rescheduleReminderTool.run({ id: r.id, at: local(later) }, ctx);
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", url: expect.stringContaining("/events/g1") });
    expect(new Date(calls.at(-1)!.body.start.dateTime).getTime()).toBe(later.getTime());

    const { updateReminderLook } = await import("../src/reminders.js");
    await updateReminderLook(r.id, user.id, { title: "Dentista Dra. Ana" });
    expect(calls.at(-1)).toMatchObject({ method: "PATCH", body: { summary: "Dentista Dra. Ana" } });

    await tools.cancelReminderTool.run({ id: r.id }, ctx);
    expect(calls.at(-1)).toMatchObject({ method: "DELETE", url: expect.stringContaining("/events/g1") });
  });

  it("recorrente fica só no Planejai e sem Google conectado nada sai", async () => {
    const before = calls.length;
    await tools.scheduleReminder.run({ intent: "Tomar água", cron: "0 9 * * *" }, ctx);
    expect(calls.length).toBe(before);
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    const other = await upsertUser("5519955555555", "Rui");
    const octx: any = { user: other, conversation: await upsertConversation(other.id, "playground", "sem-google"), timezone: tz };
    const r: any = await tools.scheduleReminder.run({ intent: "Pagar luz", in_minutes: 120 }, octx);
    expect(r.ok).toBe(true);
    expect(calls.length).toBe(before);
  });

  it("conectou depois: manda o que já estava agendado", async () => {
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    const bia = await upsertUser("5519966666666", "Bia");
    const bctx: any = { user: bia, conversation: await upsertConversation(bia.id, "playground", "depois"), timezone: tz };
    const r: any = await tools.scheduleReminder.run({ intent: "Reunião do condomínio", title: "Condomínio", in_minutes: 300 }, bctx);
    const before = calls.length;
    await (await import("../src/integrations/registry.js")).savePersonalCredentials("google", bia.id, { refresh_token: "r-bia" });
    await (await import("../src/calendar-sync.js")).syncAllFor([bia.id]);
    expect(calls.length).toBe(before + 1);
    expect(calls.at(-1)!.body.summary).toBe("Condomínio");
    expect((await db.one("SELECT google_event_id FROM reminders WHERE id = $1", [r.id])).google_event_id).toBeTruthy();
  });
});

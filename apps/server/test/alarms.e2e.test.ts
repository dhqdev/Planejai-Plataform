import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * Alarme ponta a ponta (Postgres real): rotas do painel (inscrição de push, modo, teste, cancelar),
 * ferramenta set_alarm, disparo (push + ligação do Twilio + WhatsApp), soneca/parar pelo token da notificação
 * e limpeza de inscrição que sumiu (410). web-push e a API do Twilio são simulados.
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);
process.env.OWNER_PHONES = "5519933333333";

const pushes: { endpoint: string; payload: any; opts: any }[] = [];
const gone = new Set<string>();
vi.mock("web-push", async (orig) => {
  const real: any = await orig();
  return {
    default: {
      ...real.default,
      sendNotification: vi.fn(async (sub: any, payload: string, opts: any) => {
        if (gone.has(sub.endpoint)) throw Object.assign(new Error("gone"), { statusCode: 410 });
        pushes.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });
        return { statusCode: 201 };
      }),
    },
  };
});

const twilioCalls: { url: string; body: URLSearchParams; auth: string | null }[] = [];
const realFetch = globalThis.fetch;
vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.startsWith("https://api.twilio.com/")) {
    twilioCalls.push({ url, body: new URLSearchParams(String(init?.body ?? "")), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify({ sid: `CA${twilioCalls.length}`, status: "queued" }), { status: 201, headers: { "content-type": "application/json" } });
  }
  return realFetch(input, init);
});

const SUB = (n: number) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/aparelho-${n}`,
  keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
});

describe.skipIf(!enabled)("alarme (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let alarms: typeof import("../src/alarms.js");
  let app: Awaited<ReturnType<typeof import("../src/api/server.js").buildServer>>;
  let cookie: string;
  let user: any;
  let convId: string;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    user = await upsertUser("5519933333333", "David");
    await db.query("UPDATE users SET status = 'active' WHERE id = $1", [user.id]);
    convId = (await upsertConversation(user.id, "playground", "teste-alarme")).id;
    alarms = await import("../src/alarms.js");
    app = await (await import("../src/api/server.js")).buildServer();
    const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } });
    cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  });

  afterAll(async () => {
    await app?.close();
    await (await import("../src/shortmem.js")).closeShort().catch(() => {});
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  const get = (url: string) => app.inject({ method: "GET", url, headers: { cookie } });
  const post = (url: string, payload: unknown = {}) => app.inject({ method: "POST", url, headers: { cookie }, payload: payload as any });

  it("liga a notificação no aparelho, gera as chaves VAPID uma vez e recusa serviço de push desconhecido", async () => {
    const first = (await get("/api/alarms")).json();
    expect(first.vapidPublicKey).toMatch(/^[\w-]{80,}$/);
    expect(first).toMatchObject({ alarms: [], devices: [], mode: "push", callAvailable: false });
    // guardada cifrada no banco, não em texto
    const stored = await db.one("SELECT value FROM settings WHERE key = 'vapid_keys'");
    expect(JSON.stringify(stored.value)).not.toContain(first.vapidPublicKey);

    expect((await post("/api/push/subscribe", { subscription: SUB(1) })).statusCode).toBe(200);
    expect((await post("/api/push/subscribe", { subscription: SUB(2) })).statusCode).toBe(200);
    const evil = await post("/api/push/subscribe", { subscription: { ...SUB(3), endpoint: "https://169.254.169.254/latest" } });
    expect(evil.statusCode).toBe(400);
    expect((await get("/api/alarms")).json().devices).toHaveLength(2);

    // sem login não entra
    expect((await app.inject({ method: "GET", url: "/api/alarms" })).statusCode).toBe(401);
  });

  it("testar manda a notificação para os aparelhos; ligação só com Twilio configurado", async () => {
    pushes.length = 0;
    const r = (await post("/api/alarms/test")).json();
    expect(r.push).toMatchObject({ devices: 2, sent: 2 });
    expect(pushes[0]!.payload).toMatchObject({ type: "alarm", label: "Teste de alarme", test: true });
    expect(pushes[0]!.opts).toMatchObject({ urgency: "high" });
    expect((await post("/api/alarms/test", { call: true })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/alarms/settings", headers: { cookie }, payload: { mode: "both" } })).statusCode).toBe(400);
  });

  it("set_alarm agenda, o disparo toca no celular, liga pelo Twilio e manda no WhatsApp; soneca e parar pela notificação", async () => {
    const { saveCredentials } = await import("../src/integrations/registry.js");
    await saveCredentials("twilio", { account_sid: `AC${"a".repeat(32)}`, auth_token: "tok", from_number: "+5511900000000" });
    const set = await app.inject({ method: "PUT", url: "/api/alarms/settings", headers: { cookie }, payload: { mode: "both" } });
    expect(set.statusCode).toBe(200);

    const { setAlarm, alarmList } = await import("../src/agent/tools/agenda.js");
    const ctx: any = { user, conversation: { id: convId }, timezone: "America/Sao_Paulo" };
    const created: any = await setAlarm.run({ label: "Tirar o bolo do forno", in_minutes: 15 }, ctx);
    expect(created).toMatchObject({ ok: true });
    expect(created.note).toBeUndefined();
    const listed: any = await alarmList.run({}, ctx);
    expect(listed.map((a: any) => a.label)).toEqual(["Tirar o bolo do forno"]);
    const job = await db.one("SELECT j.start_after FROM pgboss.job j JOIN alarms a ON a.job_id = j.id::text WHERE a.id = $1", [created.id]);
    expect(new Date(job.start_after).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect((await get("/api/alarms")).json().alarms).toHaveLength(1);

    // um aparelho saiu (410): some da lista no disparo
    gone.add(SUB(2).endpoint);
    pushes.length = 0;
    await db.query("UPDATE alarms SET ring_at = now() WHERE id = $1", [created.id]);
    const out: any = await alarms.ringAlarm(created.id);
    expect(out.push).toMatchObject({ devices: 2, sent: 1, removed: 1 });
    expect(pushes).toHaveLength(1);
    const payload = pushes[0]!.payload;
    expect(payload).toMatchObject({ type: "alarm", id: created.id, label: "Tirar o bolo do forno" });
    expect((await get("/api/alarms")).json().devices).toHaveLength(1);

    expect(out.call).toMatchObject({ ok: true, sid: "CA1" });
    expect(twilioCalls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/AC${"a".repeat(32)}/Calls.json`);
    expect(twilioCalls[0]!.body.get("To")).toBe("+5519933333333");
    expect(twilioCalls[0]!.body.get("From")).toBe("+5511900000000");
    expect(twilioCalls[0]!.body.get("Twiml")).toContain('<Say language="pt-BR" voice="Polly.Camila">Alarme do Planejai: Tirar o bolo do forno</Say>');
    expect(twilioCalls[0]!.auth).toMatch(/^Basic /);

    // Execuções: um passo por canal
    const steps = await db.many(
      "SELECT s.name, s.status FROM execution_steps s JOIN executions e ON e.id = s.execution_id WHERE e.trigger = 'alarm' AND e.user_id = $1 ORDER BY s.id",
      [user.id],
    );
    expect(steps.map((s) => s.name)).toEqual(["alarme: notificação", "alarme: ligação", "alarme: whatsapp"]);
    expect(steps.every((s) => s.status === "success")).toBe(true);
    const { playground } = await import("../src/channels/index.js");
    expect(playground.sent.some((m: any) => m.type === "text" && m.text === "Alarme: Tirar o bolo do forno")).toBe(true);

    // o mesmo job de novo não toca duas vezes
    expect(await alarms.ringAlarm(created.id)).toBeNull();

    // soneca pela notificação (token assinado, sem login)
    const bad = await app.inject({ method: "POST", url: "/api/alarm-action", payload: { token: "x.y", action: "snooze" } });
    expect(bad.statusCode).toBe(401);
    const snooze = await app.inject({ method: "POST", url: "/api/alarm-action", payload: { token: payload.token, action: "snooze" } });
    expect(snooze.json()).toMatchObject({ ok: true });
    expect(new Date(snooze.json().ringAt).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);

    // soneca toca de novo sem repetir o WhatsApp
    const sentBefore = playground.sent.length;
    await db.query("UPDATE alarms SET ring_at = now() WHERE id = $1", [created.id]);
    const again: any = await alarms.ringAlarm(created.id);
    expect(again.push.sent).toBe(1);
    expect(playground.sent.length).toBe(sentBefore);

    const stop = await app.inject({ method: "POST", url: "/api/alarm-action", payload: { token: payload.token, action: "stop" } });
    expect(stop.json()).toEqual({ ok: true });
    expect((await db.one("SELECT status FROM alarms WHERE id = $1", [created.id])).status).toBe("stopped");
    await expect(setAlarm.run({ label: "Reunião", at: "2099-01-01T08:00" }, ctx)).rejects.toThrow(/um ano/);
  });

  it("cancelar, horário que passou e limite de ligações por dia", async () => {
    const { setAlarm, alarmCancel } = await import("../src/agent/tools/agenda.js");
    const ctx: any = { user, conversation: { id: convId }, timezone: "America/Sao_Paulo" };
    await expect(setAlarm.run({ label: "Ontem", at: "2020-01-01T08:00" }, ctx)).rejects.toThrow(/passou/);
    const a: any = await setAlarm.run({ label: "Remédio", in_minutes: 60 }, ctx);
    const del = await app.inject({ method: "DELETE", url: `/api/alarms/${a.id}`, headers: { cookie } });
    expect(del.json()).toEqual({ ok: true });
    expect(await alarmCancel.run({ id: a.id }, ctx)).toEqual({ ok: false });

    await db.query("INSERT INTO alarm_calls (user_id, status) SELECT $1, 'queued' FROM generate_series(1, 10)", [user.id]);
    const r: any = await alarms.placeAlarmCall(user.id, user.phone, "x", null);
    expect(r).toMatchObject({ ok: false });
    expect(r.skipped).toMatch(/limite/);
  });
});

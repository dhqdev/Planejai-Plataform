import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { freeSlots, slugify, whenText } from "../src/booking.js";

const tz = "America/Sao_Paulo";

describe("link de agendamento: horários livres (sem banco)", () => {
  const page = { hours: { "3": [["09:00", "12:00"]] as [string, string][] }, step_min: 30, buffer_min: 0, notice_min: 0, days_ahead: 7 };
  // terça, 20/10/2026, 10h em São Paulo
  const now = new Date("2026-10-20T13:00:00Z");

  it("só no dia da semana marcado, no passo, sem passar do fim da faixa", () => {
    const d = freeSlots(page, 60, [], tz, now);
    expect(Object.keys(d)).toEqual(["2026-10-21"]);
    // 9:00 a 11:00 (o de 11:30 terminaria 12:30)
    expect(d["2026-10-21"]).toEqual(["2026-10-21T12:00:00.000Z", "2026-10-21T12:30:00.000Z", "2026-10-21T13:00:00.000Z", "2026-10-21T13:30:00.000Z", "2026-10-21T14:00:00.000Z"]);
  });

  it("ocupado, folga entre clientes e antecedência mínima tiram horários", () => {
    const busy = [{ s: Date.parse("2026-10-21T13:00:00Z"), e: Date.parse("2026-10-21T14:00:00Z") }];
    expect(freeSlots(page, 60, busy, tz, now)["2026-10-21"]).toEqual(["2026-10-21T12:00:00.000Z", "2026-10-21T14:00:00.000Z"]);
    expect(freeSlots({ ...page, buffer_min: 15 }, 60, busy, tz, now)["2026-10-21"]).toBeUndefined();
    // antecedência de 1 dia: amanhã 9h está a 23 h de agora
    expect(freeSlots({ ...page, notice_min: 1440 }, 60, [], tz, now)["2026-10-21"]).toEqual(["2026-10-21T13:00:00.000Z", "2026-10-21T13:30:00.000Z", "2026-10-21T14:00:00.000Z"]);
  });

  it("endereço e texto da data", () => {
    expect(slugify("Studio da Ana Paula!")).toBe("studio-da-ana-paula");
    expect(whenText(new Date("2026-10-21T18:00:00Z"), tz, now)).toBe("amanhã, às 15:00");
    expect(whenText(new Date("2026-10-23T18:00:00Z"), tz, now)).toBe("sexta-feira, 23 de outubro, às 15:00");
  });
});

/** Postgres real, Google falso: o cliente marca, cai na Agenda, ninguém pega o mesmo horário, avisos e desmarcar. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("link de agendamento (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let bk: typeof import("../src/booking.js");
  let owner: any;
  const gcal: { url: string; body: any }[] = [];
  const mails: string[] = [];
  let googleBusy: { start: string; end: string }[] = [];
  const realFetch = globalThis.fetch;
  const startedAt = new Date();
  const outbound = async () =>
    (await db.many("SELECT data FROM pgboss.job WHERE name = 'outbound.send' AND created_on >= $1 ORDER BY created_on", [startedAt])).map((j) => j.data as { phone: string; text: string });

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    bk = await import("../src/booking.js");
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    owner = await upsertUser("5519977777777", "Ana");
    await upsertConversation(owner.id, "playground", "agendamento");
    const reg = await import("../src/integrations/registry.js");
    await reg.saveCredentials("google", { client_id: "app", client_secret: "s" });
    await reg.savePersonalCredentials("google", owner.id, { refresh_token: "r-ana", email: "ana@x.com" });
    vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
      const u = String(url);
      if (u.startsWith("https://oauth2.googleapis.com/token")) return Response.json({ access_token: "t", expires_in: 3600 });
      if (u.includes("/freeBusy")) return Response.json({ calendars: { primary: { busy: googleBusy } } });
      if (u.startsWith("https://gmail.googleapis.com/")) {
        mails.push(Buffer.from(JSON.parse(init.body).raw, "base64url").toString("utf8"));
        return Response.json({ id: "m1" });
      }
      if (u.startsWith("https://www.googleapis.com/calendar/")) {
        gcal.push({ url: u, body: init.body ? JSON.parse(init.body) : null });
        return init.method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ id: `g${gcal.length}` });
      }
      return realFetch(url, init);
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await (await import("../src/queue/boss.js")).stopBoss();
  });

  it("primeira vez cria a página fechada; abrir exige serviço e horário", async () => {
    const p = await bk.ensurePage(owner.id);
    expect(p).toMatchObject({ slug: "ana", enabled: false, title: "Ana" });
    expect(await bk.pageBySlug("ana")).toBeFalsy();
    await expect(bk.savePage(owner.id, { services: [] })).rejects.toThrow(/serviço/);
    await expect(bk.savePage(owner.id, { enabled: true, hours: {} })).rejects.toThrow(/dia/);
    await expect(bk.savePage(owner.id, { slug: "horario" })).rejects.toThrow(/reservado/);
    const all = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), [["07:00", "22:00"]]]));
    const saved = await bk.savePage(owner.id, {
      enabled: true,
      slug: "Studio Ana",
      title: "Studio Ana",
      services: [{ name: "Unha", minutes: 45 }, { name: "Cabelo", minutes: 90 }],
      hours: all,
      notice_min: 0,
      client_leads: [1440, 120],
    });
    expect(saved.slug).toBe("studio-ana");
    expect(saved.services.map((s) => s.id)).toEqual(["unha", "cabelo"]);
    expect(await bk.pageBySlug("studio-ana")).toBeTruthy();
  });

  it("o cliente marca: cai na Agenda com a duração, vai pro Google, contato salvo e os dois avisados", async () => {
    const page = (await bk.pageBySlug("studio-ana"))!;
    const a = await bk.availability(page, "unha");
    const day = Object.keys(a.days).sort()[2]!;
    const start = a.days[day]![0]!;
    // ocupado no Google some da lista
    googleBusy = [{ start, end: new Date(Date.parse(start) + 3600_000).toISOString() }];
    bk.forgetGoogleBusy(owner.id);
    expect((await bk.availability(page, "unha")).days[day] ?? []).not.toContain(start);
    googleBusy = [];
    bk.forgetGoogleBusy(owner.id);

    const b = await bk.book(page, { service: "unha", start, name: "Maria Souza", phone: "(11) 98765-4321", email: "maria@ex.com", note: "Primeira vez" });
    expect(b).toMatchObject({ service: "Unha", minutes: 45, client_phone: "5511987654321", status: "confirmado" });
    const rem = await db.one("SELECT * FROM reminders WHERE id = (SELECT reminder_id FROM bookings WHERE id = $1)", [b.id]);
    expect(rem).toMatchObject({ title: "Maria Souza · Unha", tag: "Agendamento", event_minutes: 45 });
    expect(new Date(rem.event_at).toISOString()).toBe(start);
    expect(new Date(rem.due_at).getTime()).toBe(Date.parse(start) - 60 * 60_000);
    // espelhado no Google com 45 min
    const ev = gcal.find((c) => c.body?.summary === "Maria Souza · Unha")!;
    expect(Date.parse(ev.body.end.dateTime) - Date.parse(ev.body.start.dateTime)).toBe(45 * 60_000);
    // pré-cadastro nos Contatos
    expect(await db.one("SELECT name FROM phonebook WHERE user_id = $1 AND phone = '5511987654321'", [owner.id])).toMatchObject({ name: "Maria Souza" });
    // confirmação para o cliente no WhatsApp e no e-mail (pelo Gmail da Ana)
    const sent = await outbound();
    expect(sent.at(-1)).toMatchObject({ phone: "5511987654321", text: expect.stringContaining("Horário confirmado") });
    expect(sent.at(-1)!.text).toContain(`/agendar/horario/${b.token}`);
    expect(mails.at(-1)).toContain("To: maria@ex.com");
    // lembretes do cliente na fila (1 dia e 2 h antes, os que ainda não passaram)
    const jobs = await db.many("SELECT start_after FROM pgboss.job WHERE name = 'booking.remind' AND data->>'bookingId' = $1", [b.id]);
    expect(jobs.length).toBeGreaterThan(0);

    // o mesmo horário não aparece mais e não dá para pegar de novo
    const after = await bk.availability(page, "unha");
    expect(after.days[day] ?? []).not.toContain(start);
    await expect(bk.book(page, { service: "unha", start, name: "João", phone: "11912345678" })).rejects.toThrow(/ocupado/);

    // aviso da Ana na hora: texto pronto, sem IA
    expect(await bk.ownerReminderText(rem.id)).toContain("Unha com Maria Souza");
    // aviso do cliente: sai se o horário ainda vale
    expect(await bk.runClientReminder({ bookingId: b.id, start })).toBe(true);
    expect((await outbound()).at(-1)!.text).toContain("Lembrete do seu horário");
    expect(await bk.runClientReminder({ bookingId: b.id, start: new Date(Date.parse(start) + 60_000).toISOString() })).toBe(false);
  });

  it("a Ana arrasta na Agenda: o horário do cliente anda junto e ele é avisado", async () => {
    const b = await db.one("SELECT * FROM bookings WHERE client_name = 'Maria Souza'");
    const { retimeReminder } = await import("../src/reminders.js");
    const later = new Date(new Date(b.start_at).getTime() + 2 * 3600_000);
    await retimeReminder(b.reminder_id, owner.id, { at: later });
    const moved = await db.one("SELECT start_at, end_at FROM bookings WHERE id = $1", [b.id]);
    expect(new Date(moved.start_at).getTime()).toBe(later.getTime());
    expect(new Date(moved.end_at).getTime()).toBe(later.getTime() + 45 * 60_000);
    expect((await outbound()).at(-1)!.text).toContain("Seu horário mudou");
  });

  it("o cliente desmarca pelo link e o horário volta a ficar livre", async () => {
    const page = (await bk.pageBySlug("studio-ana"))!;
    const b = await db.one("SELECT * FROM bookings WHERE client_name = 'Maria Souza'");
    const c = await bk.cancelByClient(b.token);
    expect(c).toMatchObject({ status: "desmarcado", cancelled_by: "cliente" });
    expect(await db.one("SELECT status FROM reminders WHERE id = $1", [b.reminder_id])).toMatchObject({ status: "cancelled" });
    expect(await bk.cancelByClient(b.token)).toBeFalsy();
    const a = await bk.availability(page, "unha");
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(b.start_at));
    expect(a.days[day]).toContain(new Date(b.start_at).toISOString());
  });

  it("a Ana exclui na Agenda: o cliente recebe que foi desmarcado com o link para remarcar", async () => {
    const page = (await bk.pageBySlug("studio-ana"))!;
    const a = await bk.availability(page, "cabelo");
    const day = Object.keys(a.days).sort()[3]!;
    const b = await bk.book(page, { service: "cabelo", start: a.days[day]![0]!, name: "Rita", phone: "+351 912 345 678" });
    expect(b.client_phone).toBe("351912345678");
    const { cancelReminder } = await import("../src/reminders.js");
    const fresh = await db.one("SELECT reminder_id FROM bookings WHERE id = $1", [b.id]);
    await cancelReminder(fresh.reminder_id, owner.id);
    expect(await db.one("SELECT status, cancelled_by FROM bookings WHERE id = $1", [b.id])).toMatchObject({ status: "desmarcado", cancelled_by: "dono" });
    const last = (await outbound()).at(-1)!;
    expect(last).toMatchObject({ phone: "351912345678" });
    expect(last.text).toContain("/agendar/studio-ana");
  });

  it("até 3 horários futuros por WhatsApp em cada agenda", async () => {
    const page = (await bk.pageBySlug("studio-ana"))!;
    const a = await bk.availability(page, "unha");
    const days = Object.keys(a.days).sort().slice(4, 8);
    for (const d of days.slice(0, 3)) await bk.book(page, { service: "unha", start: a.days[d]![0]!, name: "Lu", phone: "11955554444" });
    await expect(bk.book(page, { service: "unha", start: a.days[days[3]!]![0]!, name: "Lu", phone: "11955554444" })).rejects.toThrow(/3 horários/);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { subjectOf, tagKey } from "../src/agenda-tags.js";

/** Agenda com tags: assunto sem IA, tag reaproveitada, compromisso no horário dele e aviso antes. */
describe("assunto da tag (sem IA)", () => {
  it("acha o assunto pelo texto e pelo nome", () => {
    expect(subjectOf("Centro Veterinário Estados Unidos")?.name).toBe("Pet");
    expect(subjectOf("consulta no dentista")?.name).toBe("Saúde");
    expect(subjectOf("Reunião com o cliente")?.name).toBe("Trabalho");
    expect(subjectOf("saude")?.name).toBe("Saúde");
    expect(subjectOf("Petrobras")).toBeNull();
    expect(subjectOf("buscar a encomenda")).toBeNull();
    expect(tagKey(" Estudos ")).toBe(tagKey("estudo"));
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("agenda com tags (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let tools: typeof import("../src/agent/tools/agenda.js");
  let user: any;
  let ctx: any;
  const tz = "America/Sao_Paulo";
  const local = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(d).replace(" ", "T");

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    tools = await import("../src/agent/tools/agenda.js");
    const { upsertUser, upsertConversation } = await import("../src/ingest.js");
    user = await upsertUser("5519933333333", "Caio");
    const conv = await upsertConversation(user.id, "playground", "teste-tags");
    ctx = { user, conversation: conv, timezone: tz };
  });
  afterAll(async () => {
    await (await import("../src/queue/boss.js")).stopBoss();
  });

  it("reaproveita a tag do mesmo assunto, mostra o dia e o choque de horário", async () => {
    const { resolveTag } = await import("../src/agenda-tags.js");
    expect(await resolveTag(user.id, "Médico", "")).toMatchObject({ name: "Saúde", color: "#e03150", created: true });
    expect(await resolveTag(user.id, "dentista", "")).toMatchObject({ name: "Saúde", created: false });
    expect(await resolveTag(user.id, "Academia do bairro", "", { exact: true })).toMatchObject({ name: "Academia do bairro", created: true });
    expect(await resolveTag(user.id, null, "buscar a encomenda")).toBeNull();

    const day = new Date(Date.now() + 3 * 86400_000);
    day.setUTCHours(21, 0, 0, 0); // 18h em São Paulo
    const vet = new Date(day.getTime() + 3600_000);
    const first: any = await tools.scheduleReminder.run(
      { intent: "Levar o Thor no veterinário às 19h", title: "Veterinário do Thor", tag: "Veterinário", at: local(day), event_at: local(vet) },
      ctx,
    );
    expect(first).toMatchObject({ ok: true, tag: "Pet (nova)" });
    expect(first.same_day).toBeUndefined();
    const second: any = await tools.scheduleReminder.run({ intent: "Ligar para a mãe", title: "Ligar para a mãe", at: local(new Date(vet.getTime() + 30 * 60_000)) }, ctx);
    expect(second).toMatchObject({ tag: "Família (nova)", same_day: ["19:00 Veterinário do Thor"], clash: "Choca com Veterinário do Thor" });

    // na agenda o compromisso fica às 19h (1h de bloco) e o aviso às 18h
    const { reminderOccurrences, rescheduleReminder } = await import("../src/reminders.js");
    const occ = await reminderOccurrences(new Date(day.getTime() - 86400_000), new Date(day.getTime() + 86400_000), user.id);
    const ev = occ.find((o) => o.reminderId === first.id)!;
    expect(ev).toMatchObject({ title: "Veterinário do Thor", tag: "Pet", color: "#e8710a", start: vet.toISOString(), remindAt: day.toISOString() });

    // arrastar o compromisso leva o aviso junto, com a mesma antecedência
    const moved = new Date(vet.getTime() + 2 * 3600_000);
    expect(await rescheduleReminder(first.id, moved, user.id)).toBe(true);
    const row = await db.one("SELECT due_at, event_at FROM reminders WHERE id = $1", [first.id]);
    expect(new Date(row.event_at).getTime()).toBe(moved.getTime());
    expect(moved.getTime() - new Date(row.due_at).getTime()).toBe(3600_000);

    const list: any = await tools.listRemindersTool.run({} as never, ctx);
    expect(list.find((r: any) => r.id === first.id)).toMatchObject({ title: "Veterinário do Thor", tag: "Pet" });
  });
});

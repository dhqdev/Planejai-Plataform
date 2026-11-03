import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matchQuick } from "../src/agent/quick.js";
import { parseLocalDateTime } from "../src/time.js";
import { pickDay2, type TipCandidate, tipDay1, tipDay2, tipDue, tipEnd } from "../src/trial-tips.js";

const tz = "America/Sao_Paulo";
const at = (s: string) => parseLocalDateTime(s, tz);
// cadastro segunda 03/11 às 10h; uso livre de 3 dias vai até quinta 06/11 às 10h
const base = (o: Partial<TipCandidate> = {}): TipCandidate => ({
  createdAt: at("2026-11-03T10:00"),
  lastSeenAt: at("2026-11-03T10:05"),
  timezone: tz,
  sent: {},
  off: false,
  trialEnd: at("2026-11-06T10:00"),
  ...o,
});

describe("dicas dos primeiros dias", () => {
  it("dia 1 às 9h, dia 2 às 12h, nunca fora da hora", () => {
    expect(tipDue(base(), at("2026-11-04T09:03"))).toBe("d1");
    expect(tipDue(base(), at("2026-11-04T10:03"))).toBeNull();
    expect(tipDue(base(), at("2026-11-03T21:03"))).toBeNull();
    expect(tipDue(base({ sent: { d1: "x", last_on: "2026-11-04" } }), at("2026-11-05T12:03"))).toBe("d2");
    expect(tipDue(base({ sent: { d1: "x" } }), at("2026-11-04T09:03"))).toBeNull();
  });

  it("uso livre acaba antes das 11h: aviso de fim sai na véspera de manhã, no lugar da dica do dia 2", () => {
    const c = base({ sent: { d1: "x", last_on: "2026-11-04" } });
    expect(tipDue(c, at("2026-11-05T09:03"))).toBe("fim");
    // já saiu o fim nesse dia: não manda a dica do meio-dia
    expect(tipDue(base({ sent: { d1: "x", fim: "y", last_on: "2026-11-05" } }), at("2026-11-05T12:03"))).toBeNull();
  });

  it("uso livre acaba à tarde: aviso no próprio dia de manhã", () => {
    const c = base({ createdAt: at("2026-11-03T15:00"), trialEnd: at("2026-11-06T15:00"), sent: { d1: "x", d2: "y", last_on: "2026-11-05" } });
    expect(tipDue(c, at("2026-11-05T09:03"))).toBeNull();
    expect(tipDue(c, at("2026-11-06T09:03"))).toBe("fim");
  });

  it("pula quem já falou hoje, quem nunca respondeu, quem desligou e quem não tem cobrança no fim", () => {
    expect(tipDue(base({ lastSeenAt: at("2026-11-04T07:40") }), at("2026-11-04T09:03"))).toBeNull();
    expect(tipDue(base({ lastSeenAt: null }), at("2026-11-04T09:03"))).toBeNull();
    expect(tipDue(base({ off: true }), at("2026-11-04T09:03"))).toBeNull();
    expect(tipDue(base({ trialEnd: null, sent: { d1: "x", last_on: "2026-11-04" } }), at("2026-11-05T09:03"))).toBeNull();
  });

  it("dia 1 segue o cadastro", () => {
    const money = tipDay1("Ana Souza", { goal: ["money"], money_goal: "debt" });
    expect(money).toContain("*Bom dia, Ana!*");
    expect(money).toContain("gastei 12 no café");
    expect(money).toContain("sair das dívidas");
    expect(money).toContain("PARAR DICAS");
    expect(tipDay1(null, { goal: ["habits"], habit: ["water"] })).toContain("beber água");
    expect(tipDay1("Bia", { goal: ["agenda"], forget: ["meds"] })).toContain("remédio às 8h");
    expect(tipDay1("Bia", {})).toContain("me lembra às 15h");
    expect(tipDay1("Bia", { goal: ["agenda"], tone: "short" })).not.toContain("áudio");
  });

  it("dia 2 mostra o que ainda não usou", () => {
    expect(pickDay2({ reminders: 0, expenses: 0 }, { goal: ["agenda"] })).toBe("gasto");
    expect(pickDay2({ reminders: 0, expenses: 0 }, { goal: ["money"] })).toBe("lembrete");
    expect(pickDay2({ reminders: 2, expenses: 0 }, { goal: ["money"] })).toBe("gasto");
    expect(pickDay2({ reminders: 1, expenses: 1 })).toBe("lista");
    expect(tipDay2("lista")).toContain("lista de compras");
  });

  it("fim: até quando, o que fez e os grãos de presente", () => {
    const t = tipEnd({ end: at("2026-11-06T10:00"), now: at("2026-11-05T09:20"), timezone: tz, reminders: 3, expenses: 1, welcomeGrains: 300, link: "https://x/plano" });
    expect(t).toContain("*Seu uso livre vai até amanhã às 10h*");
    expect(t).toContain("criou 3 lembretes");
    expect(t).toContain("anotou 1 gasto");
    expect(t).toContain("300 grãos de presente");
    const none = tipEnd({ end: at("2026-11-06T15:30"), now: at("2026-11-06T09:20"), timezone: tz, reminders: 0, expenses: 0, welcomeGrains: 0, link: "https://x/plano" });
    expect(none).toContain("hoje às 15h30");
    expect(none).toContain("Ainda dá tempo");
    expect(none).toContain("escolher um plano");
  });

  it("PARAR DICAS vira atalho sem IA; 'para' sozinho não", () => {
    expect(matchQuick("PARAR DICAS")).toEqual({ kind: "parar_dicas" });
    expect(matchQuick("sem dicas, por favor")).toEqual({ kind: "parar_dicas" });
    expect(matchQuick("para")).toBeNull();
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("dicas dos primeiros dias (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
  });
  afterAll(async () => {
    await (await import("../src/queue/boss.js")).stopBoss();
  });

  it("manda uma vez só, respeita quem já falou hoje e PARAR DICAS", async () => {
    const { upsertUser } = await import("../src/ingest.js");
    const { sendTrialTip, stopTrialTips } = await import("../src/trial-tips.js");
    const u = await upsertUser("5519944440000", "Lia");
    await db.query("UPDATE users SET status = 'active', timezone = $2, created_at = now() - interval '1 day' WHERE id = $1", [u.id, tz]);
    // última mensagem ontem à noite (horário local): hoje ainda não falou
    await db.query("UPDATE users SET last_seen_at = (date_trunc('day', now() AT TIME ZONE $2) - interval '2 hours') AT TIME ZONE $2 WHERE id = $1", [u.id, tz]);
    expect(await sendTrialTip(u.id, "d1")).toBe(true);
    expect(await sendTrialTip(u.id, "d1")).toBe(false);
    // uma por dia: a do dia 2 no mesmo dia não sai
    expect(await sendTrialTip(u.id, "d2")).toBe(false);
    const row = await db.one("SELECT profile FROM users WHERE id = $1", [u.id]);
    expect(row.profile.trial_tips.d1).toBeTruthy();

    const v = await upsertUser("5519944440001", "Rui");
    await db.query("UPDATE users SET status = 'active', timezone = $2, created_at = now() - interval '1 day' WHERE id = $1", [v.id, tz]);
    // acabou de falar (upsertUser marca last_seen_at = agora)
    expect(await sendTrialTip(v.id, "d1")).toBe(false);
    await db.query("UPDATE users SET last_seen_at = now() - interval '3 days' WHERE id = $1", [v.id]);
    await stopTrialTips(v.id);
    expect(await sendTrialTip(v.id, "d1")).toBe(false);
  });
});

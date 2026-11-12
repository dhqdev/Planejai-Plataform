import { describe, expect, it } from "vitest";
import { plainText } from "../src/credits.js";
import { parseLocalDateTime } from "../src/time.js";
import { IMAGE_DAYS, pickWeekTip, trialDaysFor, type WeekCandidate, weekDayDue, weekTipImageHtml, weekTipText, WEEK_HOURS } from "../src/week-tips.js";
import { WEEK_TIPS } from "../src/week-tips-texts.js";

const tz = "America/Sao_Paulo";
const at = (s: string) => parseLocalDateTime(s, tz);
// cadastro segunda 03/11 às 10h; uso livre de 3 dias acaba quinta 06/11; a semana de dicas vai de sexta 07/11 a quinta 13/11
const base = (o: Partial<WeekCandidate> = {}): WeekCandidate => ({
  createdAt: at("2026-11-03T10:00"),
  lastSeenAt: at("2026-11-05T20:00"),
  timezone: tz,
  trialDays: 3,
  sent: {},
  off: false,
  ...o,
});

describe("as 100 dicas", () => {
  it("são 100, com id único, no estilo do WhatsApp e sem o que quebra no WhatsApp", () => {
    expect(WEEK_TIPS).toHaveLength(100);
    expect(new Set(WEEK_TIPS.map((t) => t.id)).size).toBe(100);
    for (const t of WEEK_TIPS) {
      // título em negrito com emoji na primeira linha
      expect(t.text.split("\n")[0], t.id).toMatch(/^\S+ \*[^*]+\*$/u);
      // sem travessão, sem markdown de outro lugar e sem calendário com dia fixo
      expect(t.text, t.id).not.toMatch(/[—–]|\*\*|^#|[\u{1F4C5}\u{1F4C6}]/mu);
      expect(t.text.length, t.id).toBeLessThan(500);
    }
    // os dias com imagem têm dica com exemplo de conversa de sobra
    expect(WEEK_TIPS.filter((t) => t.chat).length).toBeGreaterThanOrEqual(15);
  });
});

describe("dicas da semana depois do uso livre", () => {
  it("dia 1 começa no dia seguinte ao fim do uso livre, na hora do dia; vai até o dia 7", () => {
    expect(weekDayDue(base(), at(`2026-11-07T${WEEK_HOURS[0]}:03`))).toBe(1);
    expect(weekDayDue(base(), at("2026-11-07T15:03"))).toBeNull();
    // ainda no último dia livre
    expect(weekDayDue(base(), at(`2026-11-06T${WEEK_HOURS[0]}:03`))).toBeNull();
    const seis = { sent: { days: [1, 2, 3, 4, 5, 6], last_on: "2026-11-12" } };
    expect(weekDayDue(base(seis), at(`2026-11-13T${WEEK_HOURS[6]}:03`))).toBe(7);
    // passou a semana
    expect(weekDayDue(base(), at(`2026-11-14T${WEEK_HOURS[0]}:03`))).toBeNull();
  });

  it("pula quem falou hoje, quem nunca respondeu, quem desligou, quem já recebeu hoje e o dia que já saiu", () => {
    const now = at(`2026-11-07T${WEEK_HOURS[0]}:03`);
    expect(weekDayDue(base({ lastSeenAt: at("2026-11-07T08:00") }), now)).toBeNull();
    expect(weekDayDue(base({ lastSeenAt: null }), now)).toBeNull();
    expect(weekDayDue(base({ off: true }), now)).toBeNull();
    expect(weekDayDue(base({ sent: { last_on: "2026-11-07" } }), now)).toBeNull();
    expect(weekDayDue(base({ trialTipOn: "2026-11-07" }), now)).toBeNull();
    expect(weekDayDue(base({ sent: { days: [1] } }), now)).toBeNull();
  });

  it("uso livre desligado ou curto: espera pelo menos 3 dias (nunca cruza com as dicas dos primeiros dias)", () => {
    expect(trialDaysFor(0)).toBe(3);
    expect(trialDaysFor(7)).toBe(7);
    expect(weekDayDue(base({ trialDays: 7 }), at(`2026-11-07T${WEEK_HOURS[0]}:03`))).toBeNull();
  });

  it("cada pessoa tem sua ordem, sem repetir dica nem assunto; começa pelo que não usou; dia de imagem tem exemplo", () => {
    const used = { reminders: 0, expenses: 3 };
    const d1 = pickWeekTip({ userId: "ana", day: 1, sentIds: [], used });
    expect(d1.topic).toBe("lembretes");
    expect(d1.chat).toBeTruthy();
    expect(pickWeekTip({ userId: "ana", day: 1, sentIds: [], used }).id).toBe(d1.id);
    const ids = [d1.id];
    for (let day = 2; day <= 7; day++) {
      const t = pickWeekTip({ userId: "ana", day, sentIds: ids, used: { reminders: 1, expenses: 1 } });
      expect(ids).not.toContain(t.id);
      if (IMAGE_DAYS.has(day)) expect(t.chat, `dia ${day}`).toBeTruthy();
      ids.push(t.id);
    }
    const topics = ids.map((id) => WEEK_TIPS.find((t) => t.id === id)!.topic);
    expect(new Set(topics).size).toBe(7);
    // outra pessoa, outra ordem
    const bia = Array.from({ length: 3 }, (_, i) => pickWeekTip({ userId: `bia${i}`, day: 4, sentIds: [], used: { reminders: 1, expenses: 1 } }).id);
    expect(new Set(bia).size).toBeGreaterThan(1);
  });

  it("texto com o nome, link de volta para quem está sem grãos e o rodapé de PARAR DICAS", () => {
    const t = WEEK_TIPS.find((x) => x.id === "l01")!;
    const txt = weekTipText(t, { name: "Ana Souza", blockedLink: "https://meuplanejai.com/plano" });
    expect(txt).toContain("Oi, Ana!");
    expect(txt).toContain("escolher um plano 👉 https://meuplanejai.com/plano");
    expect(txt).toMatch(/PARAR DICAS\*\._$/);
    expect(weekTipText(t, { name: null })).toContain("Oi! Me manda");
    expect(weekTipText(t, { name: null })).not.toContain("plano");
  });

  it("imagem: título e conversa, com negrito e sem emoji (o navegador pode não ter a fonte)", () => {
    const t = WEEK_TIPS.find((x) => x.id === "g01")!;
    const { html } = weekTipImageHtml(t);
    expect(html).toContain("Anotar gasto em 2 segundos");
    expect(html).toContain("<b>R$ 35,00</b>");
    expect(html).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});

describe("avisos no sininho", () => {
  it("tiram a marcação do WhatsApp", () => {
    expect(plainText("🌾 *Seus grãos estão acabando*\n\nSobraram *90 grãos* e _só_ isso")).toBe("🌾 Seus grãos estão acabando\n\nSobraram 90 grãos e só isso");
  });
});

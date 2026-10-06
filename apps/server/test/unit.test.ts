import { describe, expect, it } from "vitest";
import { splitBubbles, toWhatsApp } from "../src/agent/orchestrator.js";
import { CloudChannel } from "../src/channels/cloud.js";
import { EvolutionChannel } from "../src/channels/evolution.js";
import { parseWAMessage } from "../src/channels/wa-message.js";
import { decryptJson, encryptJson, signSession, verifySession } from "../src/crypto.js";
import { nextCronDate } from "../src/reminders.js";
import { isoLocal, parseLocalDateTime } from "../src/time.js";
import { phoneVariants } from "../src/ingest.js";

describe("formatação para WhatsApp", () => {
  it("converte markdown para o estilo do WhatsApp", () => {
    expect(toWhatsApp("**Kinoplex** e [ingresso](https://ingresso.com)\n- 14h30\n### Sessões")).toBe(
      "*Kinoplex* e ingresso: https://ingresso.com\n• 14h30\n*Sessões*",
    );
  });

  it("divide balões com --- e posiciona mídias", () => {
    expect(splitBubbles("Sessões de sábado:\n• 14h30\n[[media:m1]]\n---\nQual horário você prefere?")).toEqual([
      { type: "text", text: "Sessões de sábado:\n• 14h30" },
      { type: "media", id: "m1" },
      { type: "text", text: "Qual horário você prefere?" },
    ]);
  });
});

describe("datas no fuso da pessoa", () => {
  it("interpreta horário local de São Paulo (UTC-3)", () => {
    expect(parseLocalDateTime("2026-10-10T14:30", "America/Sao_Paulo").toISOString()).toBe("2026-10-10T17:30:00.000Z");
  });
  it("respeita offset explícito", () => {
    expect(parseLocalDateTime("2026-10-10T14:30:00Z", "America/Sao_Paulo").toISOString()).toBe("2026-10-10T14:30:00.000Z");
  });
  it("formata ISO local", () => {
    expect(isoLocal(new Date("2026-10-06T17:45:00Z"), "America/Sao_Paulo")).toBe("2026-10-06T14:45");
  });
  it("calcula a próxima ocorrência de cron no fuso", () => {
    const next = nextCronDate("0 8 * * *", "America/Sao_Paulo", new Date("2026-10-06T12:00:00Z"));
    expect(next.toISOString()).toBe("2026-10-07T11:00:00.000Z");
  });
});

describe("webhooks", () => {
  it("lê mensagem da Evolution, inclusive conta com LID", () => {
    const [m] = new EvolutionChannel().parseWebhook({
      event: "messages.upsert",
      data: {
        key: { remoteJid: "123@lid", remoteJidAlt: "5519999999999@s.whatsapp.net", fromMe: false, id: "ABC" },
        pushName: "David",
        message: { extendedTextMessage: { text: "oi", contextInfo: { stanzaId: "Q1", quotedMessage: { conversation: "antes" } } } },
        messageTimestamp: 1791310000,
      },
    });
    expect(m).toMatchObject({ phone: "5519999999999", externalId: "ABC", kind: "text", text: "oi", quoted: { id: "Q1", text: "antes" } });
  });

  it("ignora grupos e mensagens próprias na Evolution", () => {
    const ch = new EvolutionChannel();
    expect(ch.parseWebhook({ event: "messages.upsert", data: { key: { remoteJid: "1@g.us", id: "x" }, message: { conversation: "a" } } })).toEqual([]);
    expect(ch.parseWebhook({ event: "messages.upsert", data: { key: { remoteJid: "1@s.whatsapp.net", fromMe: true, id: "x" }, message: { conversation: "a" } } })).toEqual([]);
  });

  it("lê áudio e reação da Cloud API", () => {
    const msgs = new CloudChannel().parseWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [{ wa_id: "5519999999999", profile: { name: "David" } }],
                messages: [
                  { from: "5519999999999", id: "w1", type: "audio", audio: { id: "media1", mime_type: "audio/ogg" }, timestamp: "1791310000" },
                  { from: "5519999999999", id: "w2", type: "reaction", reaction: { message_id: "out1", emoji: "❤️" } },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(msgs[0]).toMatchObject({ kind: "audio", pushName: "David", media: { providerId: "media1" } });
    expect(msgs[1]).toMatchObject({ kind: "reaction", text: "❤️", reactionTo: "out1" });
  });
});

describe("cripto", () => {
  it("criptografa e decripta credenciais", () => {
    const enc = encryptJson({ token: "segredo" });
    expect(enc).not.toContain("segredo");
    expect(decryptJson(enc)).toEqual({ token: "segredo" });
  });
  it("rejeita sessão adulterada ou expirada", () => {
    const t = signSession({ sub: "a", exp: Date.now() + 1000 });
    expect(verifySession(t)?.sub).toBe("a");
    expect(verifySession(t.replace(/.$/, (c) => (c === "A" ? "B" : "A")))).toBeNull();
    expect(verifySession(signSession({ sub: "a", exp: Date.now() - 1 }))).toBeNull();
  });
});

describe("telefones", () => {
  it("considera o nono dígito dos celulares do Brasil", () => {
    expect(phoneVariants("5519995378302")).toEqual(["5519995378302", "551995378302"]);
    expect(phoneVariants("551995378302")).toEqual(["5519995378302", "551995378302"]);
    expect(phoneVariants("16504682892")).toEqual(["16504682892"]);
  });
});

describe("mensagens do Baileys", () => {
  it("desembrulha mensagens temporárias e ignora mensagens de protocolo", () => {
    const eph = parseWAMessage(
      { key: { remoteJid: "5519999999999@s.whatsapp.net", id: "E1" }, message: { ephemeralMessage: { message: { conversation: "oi sumido" } } }, messageTimestamp: { toNumber: () => 1791310000 } },
      "baileys",
    );
    expect(eph).toMatchObject({ channel: "baileys", text: "oi sumido", kind: "text", timestamp: new Date(1791310000 * 1000) });
    expect(parseWAMessage({ key: { remoteJid: "5519999999999@s.whatsapp.net", id: "P1" }, message: { protocolMessage: { type: 0 } } }, "baileys")).toBeNull();
  });
});

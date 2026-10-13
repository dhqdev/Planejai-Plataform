import { describe, expect, it } from "vitest";
import { rememberSent, sentMessage } from "../src/whatsapp/sent-cache.js";

/** Pedido de reenvio do WhatsApp: a mensagem que mandamos volta igual pelo getMessage. */
describe("reenvio de mensagem enviada", () => {
  it("guarda só as nossas e devolve o conteúdo", async () => {
    await rememberSent({ key: { id: "m1", fromMe: true, remoteJid: "1@s.whatsapp.net" }, message: { conversation: "Oi! Tudo certo?" } } as any);
    await rememberSent({ key: { id: "m2", fromMe: false, remoteJid: "1@s.whatsapp.net" }, message: { conversation: "de outra pessoa" } } as any);
    expect((await sentMessage({ id: "m1" }))?.conversation).toBe("Oi! Tudo certo?");
    expect(await sentMessage({ id: "m2" })).toBeUndefined();
    expect(await sentMessage({ id: "nao-existe" })).toBeUndefined();
  });
});

describe("perfil do número", () => {
  it("confere nome, recado e foto antes de mandar ao WhatsApp", async () => {
    const { checkProfile } = await import("../src/whatsapp/profile.js");
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]).toString("base64");
    expect(checkProfile({ name: "  Planejai ", status: "Assistente virtual", picture: jpeg })).toEqual({ profile: { name: "Planejai", status: "Assistente virtual", picture: jpeg } });
    expect(checkProfile({ name: "x".repeat(26) })).toHaveProperty("error");
    expect(checkProfile({ name: "   " })).toHaveProperty("error");
    expect(checkProfile({ picture: Buffer.from("png?").toString("base64") })).toEqual({ error: "A foto precisa ser JPEG." });
    expect(checkProfile({})).toEqual({ error: "Nada para mudar." });
  });
});

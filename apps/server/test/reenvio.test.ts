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

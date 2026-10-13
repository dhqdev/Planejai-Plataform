import { createHash, randomBytes } from "node:crypto";
import { proto } from "baileys";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aesEncryptGCM, hmacSign } from "../../../node_modules/baileys/lib/Utils/crypto.js";

/** Voto na enquete do "sim": abre com a chave guardada e vira "sim"/"não" da pessoa, uma vez só e só na enquete mais nova. */
describe.skipIf(!process.env.TEST_DATABASE_URL)("enquete Sim/Não do WhatsApp", () => {
  let db: typeof import("../src/db/pool.js");
  let polls: typeof import("../src/whatsapp/polls.js");
  const me = "5519900000000@s.whatsapp.net";
  const meLid = "111111111111111@lid";
  const chatLid = "222222222222222@lid";
  const chatPn = "5519911110000@s.whatsapp.net";
  const sent: string[] = [];
  const sock = { user: { id: "5519900000000:12@s.whatsapp.net", lid: "111111111111111:12@lid" }, sendMessage: async (_j: string, m: { text: string }) => void sent.push(m.text) } as any;
  const log = { warn() {}, info() {}, error() {} } as any;
  let n = 0;

  // o que o celular da pessoa faz ao votar (inverso de decryptPollVote do Baileys)
  function vote(pollId: string, secret: string, option: string | null, creator = me, voter = chatLid) {
    const vote = proto.Message.PollVoteMessage.encode({ selectedOptions: option ? [createHash("sha256").update(option).digest()] : [] }).finish();
    const sign = Buffer.concat([Buffer.from(pollId), Buffer.from(creator), Buffer.from(voter), Buffer.from("Poll Vote"), Buffer.from([1])]);
    const key = hmacSign(sign, hmacSign(Buffer.from(secret, "base64"), new Uint8Array(32), "sha256"), "sha256");
    const iv = randomBytes(12);
    const encPayload = aesEncryptGCM(vote, key, iv, Buffer.from(`${pollId}\u0000${voter}`));
    return {
      key: { remoteJid: chatLid, remoteJidAlt: chatPn, fromMe: false, id: `v${++n}` },
      message: { pollUpdateMessage: { pollCreationMessageKey: { remoteJid: chatLid, fromMe: true, id: pollId }, vote: { encPayload, encIv: iv } } },
    } as any;
  }

  async function ask(what = "mandar a mensagem para a Ana") {
    const channel = { sendPoll: async () => ({ id: `poll${++n}` }) } as any;
    const r = await polls.sendConfirmPoll(channel, chatLid, what);
    const { secret } = await db.one("SELECT secret FROM wa_polls WHERE message_id = $1", [r.id]);
    return { ...r, secret };
  }

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    polls = await import("../src/whatsapp/polls.js");
  });
  afterAll(async () => {
    await db?.pool.end();
  });

  it("pergunta curta com Sim e Não", async () => {
    expect(polls.pollQuestion("apagar a conta de luz.")).toBe("Posso apagar a conta de luz?");
    expect(polls.pollQuestion("x".repeat(400)).length).toBeLessThanOrEqual(255);
  });

  it("voto Sim vira 'sim' uma vez só; trocar o voto depois não dispara nada", async () => {
    const p = await ask();
    expect(await polls.pollVoteText(sock, vote(p.id, p.secret, "Sim"), log)).toBe("sim");
    expect(await polls.pollVoteText(sock, vote(p.id, p.secret, "Não"), log)).toBeNull();
    expect(sent.at(-1)).toContain("já não vale mais");
  });

  it("voto Não vira 'não'; voto retirado e voto de chave errada são ignorados", async () => {
    const p = await ask();
    expect(await polls.pollVoteText(sock, vote(p.id, p.secret, null), log)).toBeNull();
    expect(await polls.pollVoteText(sock, vote(p.id, randomBytes(32).toString("base64"), "Sim"), log)).toBeNull();
    // nosso número em LID e a pessoa pelo número: abre do mesmo jeito
    expect(await polls.pollVoteText(sock, vote(p.id, p.secret, "Não", meLid, chatPn), log)).toBe("não");
  });

  it("enquete velha não libera nada depois que outra foi mandada", async () => {
    const old = await ask("pagar o boleto");
    await ask("apagar o lembrete");
    expect(await polls.pollVoteText(sock, vote(old.id, old.secret, "Sim"), log)).toBeNull();
    const vencida = await ask();
    await db.query("UPDATE wa_polls SET created_at = now() - interval '31 minutes' WHERE message_id = $1", [vencida.id]);
    expect(await polls.pollVoteText(sock, vote(vencida.id, vencida.secret, "Sim"), log)).toBeNull();
  });

  it("enquete que não é nossa passa reto", async () => {
    expect(await polls.pollVoteText(sock, vote("de-outro", randomBytes(32).toString("base64"), "Sim"), log)).toBeNull();
  });
});

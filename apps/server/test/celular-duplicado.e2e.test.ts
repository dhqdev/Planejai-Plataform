import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Celular com e sem o nono dígito: quem se cadastra no painel com 75 99184-7719 e escreve pelo WhatsApp
 * (que entrega 557591847719) é a mesma pessoa, não um segundo usuário "aguardando aprovação".
 */
const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("celular com e sem o nono dígito (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let ingest: typeof import("../src/ingest.js");
  let seq = 0;
  const from = (phone: string, text: string) => ({
    channel: "playground",
    remoteJid: `${phone}@s.whatsapp.net`,
    phone,
    pushName: "Anderson Lima",
    externalId: `nd${++seq}`,
    kind: "text" as const,
    text,
    timestamp: new Date(),
    raw: {},
  });

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    ingest = await import("../src/ingest.js");
  });

  afterAll(async () => {
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("mensagem do WhatsApp sem o 9 cai no cadastro feito com o 9", async () => {
    const user = await db.one("INSERT INTO users (phone, name, full_name, status) VALUES ('5575991847719', 'Anderson', 'Anderson Araujo Lima', 'active') RETURNING id");
    await db.query("INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ('anderson@x.com', 'Anderson', 'x', 'admin', 'active', $1, '5575991847719')", [user.id]);

    const r = await ingest.ingest(from("557591847719", "gastei 50 reais no mercado"));
    expect(r.reason).not.toBe("convite para assinar");
    expect(r.queued).toBe(true);
    const rows = await db.many("SELECT id, status FROM users WHERE phone IN ('5575991847719', '557591847719')");
    expect(rows).toEqual([{ id: user.id, status: "active" }]);
    const conv = await db.one("SELECT user_id FROM conversations WHERE remote_jid = '557591847719@s.whatsapp.net'");
    expect(conv.user_id).toBe(user.id);
  });

  it("vale também no sentido contrário (gravado sem o 9, chega com o 9)", async () => {
    const user = await db.one("INSERT INTO users (phone, name, status) VALUES ('551988887777', 'Bia', 'active') RETURNING id");
    const got = await ingest.upsertUser("5519988887777", "Bia");
    expect(got.id).toBe(user.id);
    expect(await db.one("SELECT COUNT(*)::int AS n FROM users WHERE phone LIKE '55199%8887777' OR phone = '551988887777'")).toEqual({ n: 1 });
  });

  it("migração junta o duplicado que já existe e leva a conversa para o cadastro de verdade", async () => {
    const real = await db.one("INSERT INTO users (phone, name, full_name, status) VALUES ('5521991112222', 'Caio', 'Caio Real', 'active') RETURNING id");
    await db.query("INSERT INTO accounts (email, name, password_hash, role, status, user_id, phone) VALUES ('caio@x.com', 'Caio', 'x', 'admin', 'active', $1, '5521991112222')", [real.id]);
    const dup = await db.one("INSERT INTO users (phone, name, status) VALUES ('552191112222', 'Caio', 'pending') RETURNING id");
    await db.query("INSERT INTO conversations (user_id, channel, remote_jid) VALUES ($1, 'whatsapp', '552191112222@s.whatsapp.net')", [dup.id]);
    // dois desconhecidos sem cadastro, pendentes: fica o mais antigo
    const old = await db.one("INSERT INTO users (phone, status, created_at) VALUES ('553192223333', 'pending', now() - interval '1 day') RETURNING id");
    await db.query("INSERT INTO users (phone, status) VALUES ('5531992223333', 'pending')");
    // número que não é celular brasileiro e outro sem par: ficam como estão
    await db.query("INSERT INTO users (phone, status) VALUES ('14155550100', 'pending'), ('5511987654321', 'pending')");

    const sql = readFileSync(new URL("../src/db/migrations/088_celular_duplicado_nono_digito.sql", import.meta.url), "utf8");
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    expect(await db.one("SELECT id FROM users WHERE id = $1", [dup.id])).toBeUndefined();
    expect((await db.one("SELECT user_id FROM conversations WHERE remote_jid = '552191112222@s.whatsapp.net'")).user_id).toBe(real.id);
    expect((await db.many("SELECT id FROM users WHERE phone IN ('553192223333', '5531992223333')")).map((u) => u.id)).toEqual([old.id]);
    expect(await db.one("SELECT COUNT(*)::int AS n FROM users WHERE phone IN ('14155550100', '5511987654321')")).toEqual({ n: 2 });
  });
});

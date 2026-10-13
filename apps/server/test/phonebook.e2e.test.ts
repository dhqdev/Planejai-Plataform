import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Agenda de contatos importada do celular: .vcf do iPhone e do Android, números, busca sem acento e a ferramenta do agente. */
const IPHONE = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N:Souza;Ana Paula;;;",
  "FN:Ana Paula Souza",
  "item1.TEL;type=CELL;type=VOICE;type=pref:+55 (19) 99123-4567",
  "TEL;type=WORK;type=VOICE:(19) 3232-1000",
  "PHOTO;ENCODING=b;TYPE=JPEG:/9j/4AAQSkZJRgABAQ",
  " AAAQABAAD",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Pizzaria do Zé",
  "ORG:Pizzaria do Zé;",
  "TEL;type=MAIN:0800 777 1234",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Sem Número",
  "EMAIL:x@y.com",
  "END:VCARD",
].join("\r\n");

const ANDROID = [
  "BEGIN:VCARD",
  "VERSION:2.1",
  "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Concei=C3=A7=C3=A3o;Jo=C3=A3o;;;",
  "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Jo=C3=A3o Concei=C3=A7=C3=A3o",
  "TEL;CELL:011 98888-7777",
  "TEL;CELL:+1 415 555 0100",
  "END:VCARD",
].join("\n");

describe("agenda: arquivo e números", () => {
  it("lê o .vcf do iPhone e do Android (dobra de linha, quoted-printable, foto ignorada)", async () => {
    const { parseVcf } = await import("../src/phonebook.js");
    const list = parseVcf(`${IPHONE}\n${ANDROID}`);
    expect(list.map((c) => c.name)).toEqual(["Ana Paula Souza", "Pizzaria do Zé", "João Conceição"]);
    expect(list[0]!.phones).toEqual([
      { number: "+55 (19) 99123-4567", label: "celular" },
      { number: "(19) 3232-1000", label: "trabalho" },
    ]);
    expect(list[2]!.phones.map((p) => p.number)).toEqual(["011 98888-7777", "+1 415 555 0100"]);
  });

  it("nome sem FN vem do N na ordem certa; QP quebrado em linhas, latin1, apelido, empresa e e-mail; ';;;;' não é nome", async () => {
    const { parseVcf } = await import("../src/phonebook.js");
    const vcf = [
      // só N (sem FN): antes virava "Souza;Ana Paula;;;"
      "BEGIN:VCARD", "VERSION:3.0", "N:Souza;Ana Paula;;;", "TEL;TYPE=CELL:19 99111-0001", "END:VCARD",
      // Android 2.1: QP longo com quebra suave e foto em base64 terminando em "="
      "BEGIN:VCARD", "VERSION:2.1",
      "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:;=4D=61=72=69=61=20=64=61=20=43=6F=6E=63=65=69=C3=A7=C3=A3=",
      "=6F;;;",
      "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=4D=61=72=69=61=20=64=61=20=43=6F=6E=63=65=69=C3=A7=C3=A3=",
      "=6F",
      "PHOTO;ENCODING=BASE64;JPEG:/9j/4AAQ=",
      "TEL;CELL:19 99111-0002", "END:VCARD",
      // celular antigo em latin1
      "BEGIN:VCARD", "VERSION:2.1", "FN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Jos=E9", "TEL;CELL:19 99111-0003", "END:VCARD",
      // sem nome, com apelido / empresa / e-mail
      "BEGIN:VCARD", "VERSION:3.0", "N:;;;;", "FN:", "NICKNAME:Tio Beto", "TEL:19 99111-0004", "END:VCARD",
      "BEGIN:VCARD", "VERSION:3.0", "N:;;;;", "ORG:Clínica Sorriso;Recepção", "TEL:19 99111-0005", "END:VCARD",
      "BEGIN:VCARD", "VERSION:3.0", "N:;;;;", "EMAIL:carla.mendes@x.com", "TEL:19 99111-0006", "END:VCARD",
      // nada de nome: fica de fora
      "BEGIN:VCARD", "VERSION:3.0", "N:;;;;", "FN:;;;;", "TEL:19 99111-0007", "END:VCARD",
      // escape no FN
      "BEGIN:VCARD", "VERSION:3.0", "FN:Lima\\, Pedro", "TEL:19 99111-0008", "END:VCARD",
    ].join("\r\n");
    expect(parseVcf(vcf).map((c) => c.name)).toEqual([
      "Ana Paula Souza",
      "Maria da Conceição",
      "José",
      "Tio Beto",
      "Clínica Sorriso - Recepção",
      "carla mendes",
      "Lima, Pedro",
    ]);
    expect(parseVcf(vcf)[1]!.phones.map((p) => p.number)).toEqual(["19 99111-0002"]);
  });

  it("número de WhatsApp: com DDI, sem DDI, com 0 do DDD; 0800 e curto ficam de fora", async () => {
    const { cleanContactPhone } = await import("../src/phonebook.js");
    expect(cleanContactPhone("+55 (19) 99123-4567")).toBe("5519991234567");
    expect(cleanContactPhone("(19) 99123-4567")).toBe("5519991234567");
    expect(cleanContactPhone("011 98888-7777")).toBe("5511988887777");
    expect(cleanContactPhone("+1 415 555 0100")).toBe("14155550100");
    expect(cleanContactPhone("0800 777 1234")).toBeNull();
    expect(cleanContactPhone("190")).toBeNull();
  });
});

const enabled = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!enabled)("agenda de contatos (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let pb: typeof import("../src/phonebook.js");
  let user: any;
  let other: any;

  beforeAll(async () => {
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    pb = await import("../src/phonebook.js");
    const { upsertUser } = await import("../src/ingest.js");
    user = await upsertUser("5519955551111", "Rita");
    other = await upsertUser("5519955552222", "Outra");
  });

  afterAll(async () => {
    await (await import("../src/shortmem.js")).closeShort();
    await (await import("../src/queue/boss.js")).stopBoss();
    await db?.pool.end();
  });

  it("importa, não duplica o mesmo número e busca sem acento", async () => {
    const first = await pb.importContacts(user.id, pb.parseVcf(`${IPHONE}\n${ANDROID}`), "vcf");
    // Ana: 2 números; João: 2; Pizzaria (só 0800) fica de fora; sem número nem entra na lista
    expect(first).toMatchObject({ saved: 4, added: 4, skipped: 1 });
    const again = await pb.importContacts(user.id, [{ name: "Ana Souza", phones: [{ number: "19991234567" }] }], "celular");
    expect(again).toMatchObject({ saved: 1, added: 0 });
    expect((await pb.listPhonebook(user.id, "")).total).toBe(4);
    expect((await pb.searchContacts(user.id, "joao conceicao")).map((c) => c.phone)).toEqual(expect.arrayContaining(["5511988887777", "14155550100"]));
    expect((await pb.searchContacts(user.id, "ana"))[0]).toMatchObject({ name: "Ana Souza", phone: "5519991234567" });
    expect((await pb.searchContacts(user.id, "3232"))[0]).toMatchObject({ phone: "551932321000" });
    // a agenda é de cada um
    expect(await pb.searchContacts(other.id, "ana")).toEqual([]);
  });

  it("o agente procura pelo nome e salva número novo", async () => {
    const { contactsSearch, contactSave } = await import("../src/agent/tools/direct.js");
    const ctx: any = { user };
    const ana: any = await contactsSearch.run({ query: "Ana" }, ctx);
    expect(ana.contacts[0]).toEqual({ name: "Ana Souza", phone: "5519991234567", label: "celular" });
    expect(ana.contacts[1]).toMatchObject({ name: "Ana Paula Souza", label: "trabalho" });
    expect(await contactsSearch.run({ query: "Beto" }, ctx)).toMatchObject({ contacts: [] });
    expect(await contactSave.run({ name: "Beto Encanador", phone: "(19) 98765-4321" }, ctx)).toMatchObject({ ok: true, phone: "5519987654321" });
    expect(await contactSave.run({ name: "X", phone: "123" }, ctx)).toMatchObject({ ok: false });
    expect(((await contactsSearch.run({ query: "encanador" }, ctx)) as any).contacts[0].phone).toBe("5519987654321");
    // escrito errado ou de outro jeito: acha o parecido e avisa que é aproximado
    await contactSave.run({ name: "Mãe Zera", phone: "19 98358-6166" }, ctx);
    const mae: any = await contactsSearch.run({ query: "maezera" }, ctx);
    expect(mae.contacts[0]).toMatchObject({ name: "Mãe Zera", phone: "5519983586166" });
    const typo: any = await contactsSearch.run({ query: "Ana Sousa" }, ctx);
    expect(typo).toMatchObject({ approximate: true });
    expect(typo.contacts.map((c: any) => c.name)).toContain("Ana Souza");
    expect((await pb.searchContacts(user.id, "jaoo"))[0]).toMatchObject({ name: expect.stringMatching(/^João/), approximate: true });
    expect(await pb.searchContacts(user.id, "pedro")).toEqual([]);
    await pb.deleteContact(user.id, (await pb.searchContacts(user.id, "mae zera"))[0]!.id);
  });

  it("nomes da importação antiga: N cru é remontado, ';;;;' fica no fim como sem nome e dá para renomear", async () => {
    const { readFileSync } = await import("node:fs");
    await db.query("INSERT INTO phonebook (user_id, name, name_key, phone, source) VALUES ($1, 'Souza;Ana Ninguém;;;', 'x', '5519900000001', 'vcf'), ($1, ';;;;', ';;;;', '5519900000002', 'vcf')", [other.id]);
    await db.query(readFileSync(new URL("../src/db/migrations/060_contatos_nome_do_vcf.sql", import.meta.url), "utf8"));
    const list = await pb.listPhonebook(other.id, "");
    expect(list).toMatchObject({ total: 2, noname: 1 });
    expect(list.items.map((c: any) => c.name)).toEqual(["Ana Ninguém Souza", ";;;;"]);
    expect((await pb.searchContacts(other.id, "ninguem"))[0]).toMatchObject({ phone: "5519900000001" });
    const only = await pb.listPhonebook(other.id, "", 100, 0, true);
    expect(only.items.map((c: any) => c.phone)).toEqual(["5519900000002"]);
    await expect(pb.renameContact(other.id, only.items[0]!.id, " ;; ")).rejects.toThrow();
    await expect(pb.renameContact(user.id, only.items[0]!.id, "Zé")).rejects.toThrow();
    await pb.renameContact(other.id, only.items[0]!.id, "Zé da Padaria");
    expect(await pb.listPhonebook(other.id, "")).toMatchObject({ noname: 0 });
    expect((await pb.searchContacts(other.id, "padaria"))[0]).toMatchObject({ name: "Zé da Padaria" });
    // reimportar com nome certo atualiza pelo número; nome vazio não estraga o que tem
    await pb.importContacts(other.id, [{ name: ";;;;", phones: [{ number: "19 90000-0001" }] }], "vcf");
    expect((await pb.searchContacts(other.id, "ninguem"))[0]).toMatchObject({ name: "Ana Ninguém Souza" });
    await pb.clearPhonebook(other.id);
  });

  it("mandar mensagem do cartão: mostra o texto final antes; quem pediu SAIR não recebe", async () => {
    const { config } = await import("../src/config.js");
    const owners = config.OWNER_PHONES;
    config.OWNER_PHONES = [user.phone];
    try {
      const { buildServer } = await import("../src/api/server.js");
      const app = await buildServer();
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "admin@planejai.local", password: "test-password" } });
      const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
      const saved = await pb.saveContact(user.id, "Carol Dentista", "19 97777-1212");
      const [carol] = await pb.searchContacts(user.id, "carol");
      const url = `/api/contatos/${carol!.id}/mensagem`;
      const prev = await app.inject({ method: "POST", url, headers: { cookie }, payload: { message: "Posso remarcar para sexta?" } });
      expect(prev.statusCode).toBe(200);
      expect(prev.json().to).toBe("Carol Dentista");
      expect(prev.json().preview).toContain("Posso remarcar para sexta?");
      expect(prev.json().preview).toContain("Rita");
      expect(prev.json().preview).toContain("SAIR");
      expect((await app.inject({ method: "POST", url, headers: { cookie }, payload: { message: "  " } })).statusCode).toBe(400);
      // contato de outra pessoa não aparece
      await pb.saveContact(other.id, "Outro Fulano", "19 97777-3434");
      const [alheio] = await pb.searchContacts(other.id, "fulano");
      expect((await app.inject({ method: "POST", url: `/api/contatos/${alheio!.id}/mensagem`, headers: { cookie }, payload: { message: "oi" } })).statusCode).toBe(404);
      await db.query("INSERT INTO wa_optouts (phone) VALUES ($1)", [saved.phone]);
      const blocked = await app.inject({ method: "POST", url, headers: { cookie }, payload: { message: "oi", confirm: true } });
      expect(blocked.statusCode).toBe(400);
      expect(blocked.json().error).toMatch(/SAIR/);
      expect(await db.one("SELECT COUNT(*)::int AS n FROM direct_messages WHERE user_id = $1", [user.id])).toEqual({ n: 0 });
      await pb.deleteContact(user.id, carol!.id);
      await pb.clearPhonebook(other.id);
      await app.close();
    } finally {
      config.OWNER_PHONES = owners;
    }
  });

  it("apagar um e apagar tudo", async () => {
    const [ana] = await pb.searchContacts(user.id, "ana");
    await pb.deleteContact(other.id, ana!.id);
    expect((await pb.listPhonebook(user.id, "")).total).toBe(5);
    await pb.deleteContact(user.id, ana!.id);
    expect((await pb.listPhonebook(user.id, "")).total).toBe(4);
    await pb.clearPhonebook(user.id);
    expect((await pb.listPhonebook(user.id, "")).total).toBe(0);
  });
});

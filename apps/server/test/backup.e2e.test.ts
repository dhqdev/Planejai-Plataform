import { execFileSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";

/**
 * Backup e migração (Postgres real + S3 falso que confere a assinatura, lista, copia e guarda em memória):
 * pastas novas no bucket, backup com ficha e conferência, cofre das chaves e restauração com troca de banco
 * e credenciais regravadas com a chave da stack nova.
 */
// pg_dump/pg_restore no PATH, da versão do Postgres de teste (16) ou mais novos
const hasPgDump = (() => {
  try {
    const major = Number(execFileSync("pg_dump", ["--version"]).toString().match(/(\d+)\./)?.[1] ?? 0);
    return major >= 16;
  } catch {
    return false;
  }
})();
const enabled = Boolean(process.env.TEST_DATABASE_URL) && hasPgDump;

const SECRET = "segredo-de-teste-nao-vale-nada";
const objects = new Map<string, { body: Buffer; type: string; at: Date }>();
let server: Server;

const sha = (d: string | Buffer) => createHash("sha256").update(d).digest("hex");
const hmac = (k: string | Buffer, d: string) => createHmac("sha256", k).update(d).digest();

function validSignature(method: string, url: string, headers: Record<string, any>, body: Buffer) {
  const auth = String(headers.authorization ?? "");
  const m = auth.match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
  if (!m || m[1] !== "AKTESTE") return false;
  const [, , day, region, signed, sig] = m;
  if (headers["x-amz-content-sha256"] !== sha(body)) return false;
  const [path, qs = ""] = url.split("?");
  const names = signed!.split(";");
  const canonical = [method, path, qs, ...names.map((n) => `${n}:${String(headers[n]).trim()}`), "", signed, sha(body)].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", headers["x-amz-date"], `${day}/${region}/s3/aws4_request`, sha(canonical)].join("\n");
  let k: Buffer = hmac(`AWS4${SECRET}`, day!);
  for (const p of [region!, "s3", "aws4_request"]) k = hmac(k, p);
  return createHmac("sha256", k).update(toSign).digest("hex") === sig;
}

const keyOf = (path: string) => decodeURIComponent(path.replace(/^\/planejai\//, ""));
const bucketHas = (key: string) => objects.has(`/planejai/pj/${key.split("/").map(encodeURIComponent).join("/")}`);

describe.skipIf(!enabled)("backup e migração (e2e)", () => {
  let db: typeof import("../src/db/pool.js");
  let backup: typeof import("../src/backup.js");
  let storage: typeof import("../src/storage.js");
  let ana: any;
  let dumpKey = "";
  const OLD_KEY = "chave-da-stack-antiga-0123456789abcdef";
  const NEW_KEY = "chave-da-stack-nova-fedcba9876543210xx";

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        const url = req.url ?? "/";
        if (!validSignature(req.method!, url, req.headers, body)) {
          res.writeHead(403).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
          return;
        }
        const [path, qs] = url.split("?");
        if (req.method === "GET" && path === "/planejai" && qs) {
          const q = new URLSearchParams(qs);
          const prefix = q.get("prefix") ?? "";
          const list = [...objects.entries()].map(([p, o]) => ({ key: keyOf(p), o })).filter((x) => x.key.startsWith(prefix)).sort((a, b) => a.key.localeCompare(b.key));
          const xml = `<ListBucketResult><IsTruncated>false</IsTruncated>${list
            .map((x) => `<Contents><Key>${x.key.replace(/&/g, "&amp;")}</Key><LastModified>${x.o.at.toISOString()}</LastModified><Size>${x.o.body.length}</Size></Contents>`)
            .join("")}</ListBucketResult>`;
          res.writeHead(200, { "Content-Type": "application/xml" }).end(xml);
          return;
        }
        const o = objects.get(path!);
        if (req.method === "PUT") {
          const src = req.headers["x-amz-copy-source"];
          if (src) {
            const from = objects.get(String(src));
            if (!from) return void res.writeHead(404).end("<Error><Code>NoSuchKey</Code></Error>");
            objects.set(path!, { ...from, at: new Date() });
            return void res.writeHead(200).end("<CopyObjectResult></CopyObjectResult>");
          }
          objects.set(path!, { body, type: String(req.headers["content-type"] ?? ""), at: new Date() });
          res.writeHead(200).end();
        } else if (req.method === "GET" || req.method === "HEAD") {
          if (!o) res.writeHead(404).end(req.method === "HEAD" ? undefined : "<Error><Code>NoSuchKey</Code></Error>");
          else if (req.method === "HEAD") res.writeHead(200, { "Content-Length": o.body.length }).end();
          else res.writeHead(200, { "Content-Type": o.type }).end(o.body);
        } else if (req.method === "DELETE") {
          objects.delete(path!);
          res.writeHead(204).end();
        } else res.writeHead(405).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    Object.assign(config, {
      STORAGE_S3_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      // bucket com prefixo, como na stack do dono (bucket planejai, tudo dentro de pj/)
      STORAGE_S3_BUCKET: "planejai/pj",
      STORAGE_S3_REGION: "us-east-005",
      STORAGE_S3_ACCESS_KEY_ID: "AKTESTE",
      STORAGE_S3_SECRET_ACCESS_KEY: SECRET,
      ENCRYPTION_KEY: OLD_KEY,
    });
    db = await import("../src/db/pool.js");
    await db.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await (await import("../src/db/migrate.js")).migrate(() => {});
    backup = await import("../src/backup.js");
    storage = await import("../src/storage.js");
    const { upsertUser } = await import("../src/ingest.js");
    ana = await upsertUser("5519933330001", "Ana");
  });

  afterAll(async () => {
    Object.assign(config, { STORAGE_S3_ENDPOINT: "", STORAGE_S3_BUCKET: "", STORAGE_S3_ACCESS_KEY_ID: "", STORAGE_S3_SECRET_ACCESS_KEY: "", ENCRYPTION_KEY: "" });
    await new Promise((r) => server?.close(r));
    // banco de antes da restauração que o teste deixou guardado
    if (db) {
      const cur = backup.currentDbName();
      const admin = new (await import("pg")).default.Client({ connectionString: config.DATABASE_URL.replace(/\/[^/?]+(\?|$)/, "/postgres$1") });
      await admin.connect();
      const olds = await admin.query("SELECT datname FROM pg_database WHERE datname LIKE $1", [`${cur}\\_antes\\_%`]);
      for (const o of olds.rows) await admin.query(`DROP DATABASE IF EXISTS "${o.datname}" WITH (FORCE)`);
      await admin.end();
    }
  });

  it("arquivo antigo (documents/) vai para arquivos/documentos/ sem perder a linha", async () => {
    const doc = await db.one<{ id: string }>("INSERT INTO documents (user_id, name, mimetype, size) VALUES ($1, 'contrato.pdf', 'application/pdf', 3) RETURNING id", [ana.id]);
    const old = `documents/${ana.id}/${doc!.id}`;
    await storage.putObject(old, Buffer.from("pdf"), "application/pdf");
    await db.query("UPDATE documents SET storage_key = $2 WHERE id = $1", [doc!.id, old]);
    expect(await storage.relocateLegacyObjects()).toBe(1);
    const row = await db.one("SELECT storage_key FROM documents WHERE id = $1", [doc!.id]);
    expect(row.storage_key).toBe(`arquivos/documentos/${ana.id}/${doc!.id}`);
    expect(bucketHas(old)).toBe(false);
    expect((await storage.getObject(row.storage_key)).toString()).toBe("pdf");
  });

  it("testar backup: dump em banco/ com ficha, baixa de volta e confere; dump do serviço antigo vem de backups/ para banco/", async () => {
    // credencial cifrada com a chave da stack antiga
    const { encryptJson } = await import("../src/crypto.js");
    await db.query("INSERT INTO integrations (id, enabled, credentials_enc) VALUES ('tavily', true, $1) ON CONFLICT (id) DO UPDATE SET credentials_enc = EXCLUDED.credentials_enc", [encryptJson({ api_key: "tvly-123" })]);
    await storage.putObject("backups/planejai-20261001-0300.dump", Buffer.from("dump do rclone"));

    const r = await backup.runBackup("teste", { verify: true });
    dumpKey = r.key;
    expect(dumpKey).toMatch(/^banco\/planejai-\d{8}-\d{4}\.dump$/);
    expect(bucketHas(dumpKey) && bucketHas(`${dumpKey}.json`) && bucketHas("LEIA-ME.txt")).toBe(true);
    expect(r.manifest.verified?.entries).toBeGreaterThan(50);
    expect(r.manifest.files.missing).toBe(0);
    expect(r.manifest.files.inBucket).toBe(1);
    expect(r.manifest.inventory.find((t) => t.table === "users")?.rows).toBe(1);
    expect(r.manifest.key_fingerprint).toBeTruthy();
    expect(bucketHas("backups/planejai-20261001-0300.dump")).toBe(false);
    expect(bucketHas("banco/planejai-20261001-0300.dump")).toBe(true);
    const run = await db.one("SELECT ok, bytes FROM backup_runs ORDER BY id DESC LIMIT 1");
    expect(run.ok).toBe(true);
    expect(Number(run.bytes)).toBe(r.manifest.bytes);
    const remote = await backup.remoteDumps();
    expect(remote.map((d) => d.key)).toContain(dumpKey);
  });

  it("objeto apagado do bucket aparece como faltando na conferência", async () => {
    const m = await db.one<{ id: string }>("INSERT INTO media_files (kind, mimetype, size, storage_key) VALUES ('screenshot', 'image/png', 10, 'arquivos/midia/sumiu') RETURNING id");
    expect((await backup.checkFiles()).missing).toBe(1);
    await db.query("DELETE FROM media_files WHERE id = $1", [m!.id]);
  });

  it("cofre: guarda as variáveis cifradas com a senha e só abre com ela", async () => {
    await expect(backup.saveVault("curta")).rejects.toThrow(/10 caracteres/);
    await backup.saveVault("minha senha do cofre");
    expect(bucketHas("chaves/cofre-das-chaves.json")).toBe(true);
    const raw = (await storage.getObject("chaves/cofre-das-chaves.json")).toString();
    expect(raw).not.toContain(OLD_KEY);
    await expect(backup.openVault("senha errada demais")).rejects.toThrow(/errada/);
    const env = await backup.openVault("minha senha do cofre");
    expect(env.ADMIN_PASSWORD).toBe("test-password");
    expect(env.POSTGRES_PASSWORD).toBeDefined();
  });

  it("restaurar numa stack com outra chave: troca o banco e regrava as credenciais com a chave nova", async () => {
    // depois do backup: dado novo que a restauração tem que desfazer
    await db.query("UPDATE users SET name = 'Ana depois do backup' WHERE id = $1", [ana.id]);
    // a stack nova tem outra ENCRYPTION_KEY: sem a antiga a restauração para antes de trocar
    Object.assign(config, { ENCRYPTION_KEY: NEW_KEY, APP_SECRET: "" });
    const wait = async () => {
      for (let i = 0; i < 300; i++) {
        const s = backup.restoreStatus();
        if (s && ["pronto", "erro"].includes(s.phase)) return s;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error("restauração não terminou");
    };
    let done = false;
    backup.startRestore({ key: dumpKey }, () => {}, () => (done = true));
    let s = await wait();
    expect(s.phase).toBe("erro");
    expect(s.error).toMatch(/outra ENCRYPTION_KEY/);
    expect((await db.one("SELECT name FROM users WHERE id = $1", [ana.id])).name).toBe("Ana depois do backup");

    // com a senha do cofre (que tem a chave antiga) vai
    backup.startRestore({ key: dumpKey, secret: "minha senha do cofre" }, () => {}, () => (done = true));
    s = await wait();
    expect(s.error).toBeUndefined();
    expect(s.phase).toBe("pronto");
    expect(done).toBe(true);
    expect(s.credentials?.fixed).toBe(1);
    // o pool reconecta no banco restaurado
    let name: string | undefined;
    for (let i = 0; i < 10 && !name; i++) name = await db.one("SELECT name FROM users WHERE id = $1", [ana.id]).then((r) => r?.name).catch(() => undefined);
    expect(name).toBe("Ana");
    const { decryptJson } = await import("../src/crypto.js");
    const row = await db.one("SELECT credentials_enc FROM integrations WHERE id = 'tavily'");
    expect(decryptJson(row.credentials_enc)).toEqual({ api_key: "tvly-123" });
    // banco de antes guardado e marca para o worker reiniciar
    expect(s.previousDb).toMatch(/_antes_/);
    expect(await backup.restoredMark()).toContain(dumpKey);
    // como havia gente cadastrada, guardou uma cópia do banco atual antes de trocar
    expect([...objects.keys()].some((k) => k.includes("/banco/antes-de-restaurar-"))).toBe(true);
  });
});

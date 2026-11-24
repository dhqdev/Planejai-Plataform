import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  bucketLabel,
  currentDbName,
  disconnectStorage,
  isFreshInstall,
  KEEP_DAYS,
  openVault,
  pgTools,
  reconnectStorage,
  remoteDumps,
  restoredMark,
  restoreStatus,
  saveVault,
  startBackup,
  startRestore,
  vaultInfo,
} from "../../../backup.js";
import { config } from "../../../config.js";
import { keyFingerprint, safeEqual } from "../../../crypto.js";
import { many, one } from "../../../db/pool.js";
import { hit } from "../../../ratelimit.js";
import { storageConfigured, storageOn } from "../../../storage.js";

/** Só o dono da stack: restaurar troca o banco inteiro e o cofre mostra as chaves da stack. */
async function requireOwner(req: FastifyRequest, reply: FastifyReply) {
  if (!req.account?.owner) return reply.code(403).send({ error: "Só o dono da stack mexe no backup" });
}

const TRIES_WINDOW = 15 * 60;
const TRIES_MAX = 10;

/** Tela Servidor > Backup: o que está salvo no bucket, testar agora, cofre das chaves e restaurar. */
export async function backupRoutes(api: FastifyInstance) {
  await api.register(async (b) => {
    b.addHook("preHandler", requireOwner);

    b.get("/api/backup", async (req) => {
      const runs = await many(
        `SELECT id, reason, started_at, finished_at, ok, key, bytes, error, manifest->'files' AS files, manifest->'verified' AS verified,
                manifest->'inventory' AS inventory
           FROM backup_runs ORDER BY started_at DESC LIMIT 12`,
      );
      const enabled = await storageOn();
      let remote: Awaited<ReturnType<typeof remoteDumps>> = [];
      let remoteError: string | null = null;
      let vault: Awaited<ReturnType<typeof vaultInfo>> = null;
      if (enabled) {
        try {
          [remote, vault] = await Promise.all([remoteDumps(5), vaultInfo()]);
        } catch (err) {
          remoteError = (err as Error).message;
          req.log.warn({ err }, "não deu para listar o bucket");
        }
      }
      const legacy = await one<{ n: string }>(
        "SELECT (SELECT COUNT(*) FROM documents WHERE storage_key LIKE 'documents/%') + (SELECT COUNT(*) FROM media_files WHERE storage_key LIKE 'media/%') AS n",
      );
      const wa = await one<{ keys: string; status: string | null }>(
        "SELECT (SELECT COUNT(*) FROM wa_auth) AS keys, (SELECT status FROM wa_sessions ORDER BY updated_at DESC NULLS LAST LIMIT 1) AS status",
      ).catch(() => null);
      const restored = await restoredMark();
      return {
        bucket: bucketLabel(),
        disconnected: storageConfigured() && !enabled,
        tools: await pgTools(),
        keyFingerprint: keyFingerprint(),
        fresh: await isFreshInstall(),
        dbName: currentDbName(),
        schedule: { time: "03:30", timezone: config.DEFAULT_TIMEZONE, keepDays: KEEP_DAYS },
        runs,
        remote,
        remoteError,
        vault,
        legacyObjects: Number(legacy?.n ?? 0),
        whatsapp: { keys: Number(wa?.keys ?? 0), status: wa?.status ?? null },
        restore: restoreStatus(),
        restoredAt: restored ? (JSON.parse(JSON.parse(restored)) as { at: string; from: string }) : null,
      };
    });

    b.post<{ Body: { test?: boolean } }>("/api/backup/run", async (req, reply) => {
      if (!(await storageOn())) return reply.code(400).send({ error: "Configure o bucket (STORAGE_S3_*) na stack ou reconecte ele primeiro." });
      try {
        startBackup(req.body?.test ? "teste" : "manual", (m) => req.log.info(m));
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
      return { started: true };
    });

    b.post<{ Body: { passphrase?: string } }>("/api/backup/vault", async (req, reply) => {
      if (!(await storageOn())) return reply.code(400).send({ error: "Configure o bucket (STORAGE_S3_*) na stack ou reconecte ele primeiro." });
      try {
        return await saveVault(String(req.body?.passphrase ?? ""));
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    b.post<{ Body: { passphrase?: string } }>("/api/backup/vault/open", async (req, reply) => {
      if ((await hit(`vault:${req.ip}`, TRIES_WINDOW)) > TRIES_MAX) return reply.code(429).send({ error: "Muitas tentativas. Espere 15 minutos." });
      try {
        return { env: await openVault(String(req.body?.passphrase ?? "")) };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    // Desconectar: os arquivos voltam para o banco e o app para de usar o bucket (nada é apagado lá). Pede a senha do dono.
    b.post<{ Body: { password?: string } }>("/api/backup/disconnect", async (req, reply) => {
      if ((await hit(`disconnect:${req.ip}`, TRIES_WINDOW)) > TRIES_MAX) return reply.code(429).send({ error: "Muitas tentativas. Espere 15 minutos." });
      if (!safeEqual(String(req.body?.password ?? ""), config.ADMIN_PASSWORD)) return reply.code(400).send({ error: "Senha do dono errada." });
      try {
        return await disconnectStorage((m) => req.log.warn(m));
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
    });

    b.post("/api/backup/reconnect", async (_req, reply) => {
      try {
        await reconnectStorage();
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });

    b.get("/api/backup/restore", async () => ({ restore: restoreStatus() }));

    b.post<{ Body: { key?: string; confirm?: string; password?: string; secret?: string; ignoreKeys?: boolean } }>("/api/backup/restore", async (req, reply) => {
      if ((await hit(`restore:${req.ip}`, TRIES_WINDOW)) > TRIES_MAX) return reply.code(429).send({ error: "Muitas tentativas. Espere 15 minutos." });
      const body = req.body ?? {};
      if (String(body.confirm ?? "").trim().toUpperCase() !== "RESTAURAR") return reply.code(400).send({ error: "Escreva RESTAURAR para confirmar." });
      if (!safeEqual(String(body.password ?? ""), config.ADMIN_PASSWORD)) return reply.code(400).send({ error: "Senha do dono errada." });
      try {
        startRestore(
          { key: String(body.key ?? ""), secret: body.secret ? String(body.secret) : undefined, ignoreKeys: body.ignoreKeys === true },
          (m) => req.log.warn(m),
          // banco trocado: reinicia este processo (o Docker sobe de novo) para largar tudo que era do banco anterior
          () => setTimeout(() => process.kill(process.pid, "SIGTERM"), 4000),
        );
      } catch (err) {
        return reply.code(409).send({ error: (err as Error).message });
      }
      return { restore: restoreStatus() };
    });
  });
}

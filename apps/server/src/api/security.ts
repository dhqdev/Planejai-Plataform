import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BlockList, isIPv4 } from "node:net";
import type { FastifyInstance } from "fastify";
import { config } from "../config.js";

// rede interna (Docker/Swarm, loopback): de onde o Traefik chega
const internal = new BlockList();
for (const [net, bits] of [["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["127.0.0.0", 8], ["169.254.0.0", 16]] as const) internal.addSubnet(net, bits, "ipv4");
internal.addSubnet("fc00::", 7, "ipv6");
internal.addAddress("::1", "ipv6");
const PRIVATE_PEER = (addr: string) => {
  const v4 = addr.startsWith("::ffff:") ? addr.slice(7) : addr;
  return isIPv4(v4) ? internal.check(v4, "ipv4") : internal.check(addr, "ipv6");
};

/**
 * TRUST_PROXY: número de proxies na frente (padrão 1 = o Traefik, que entra pela rede interna do Docker),
 * "true"/"false" ou lista de IPs/faixas. Com número, só confia nos saltos de dentro da rede privada:
 * quem manda X-Forwarded-For direto da internet não escolhe o próprio IP (o limite de login é por IP).
 */
export function trustProxySetting(raw = config.TRUST_PROXY): boolean | string[] | ((addr: string, i: number) => boolean) {
  const v = raw.trim();
  if (/^\d+$/.test(v)) {
    const hops = Number(v);
    return (addr, i) => i < hops && PRIVATE_PEER(addr);
  }
  if (v === "true" || v === "false") return v === "true";
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Hash dos <script> inline do index.html (o resgate de cache velho) para a CSP liberar só eles. */
function inlineScriptHashes(publicDir: string) {
  const file = join(publicDir, "index.html");
  if (!existsSync(file)) return [];
  const html = readFileSync(file, "utf8");
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash("sha256").update(m[1] ?? "").digest("base64")}'`,
  );
}

/**
 * Cabeçalhos de segurança em toda resposta (sem dependência nova) e erro do Postgres sem vazar detalhe.
 * A CSP vai só no HTML do painel: scripts só daqui, fontes do Google, nada de iframe de fora.
 */
export function registerSecurity(app: FastifyInstance, publicDir: string) {
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${inlineScriptHashes(publicDir).join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const https = config.PUBLIC_URL.startsWith("https");

  app.addHook("onSend", async (_req, reply, payload) => {
    if (!reply.hasHeader("X-Content-Type-Options")) reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    if (https) reply.header("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    if (!reply.hasHeader("Content-Security-Policy") && String(reply.getHeader("content-type") ?? "").startsWith("text/html")) {
      reply.header("Content-Security-Policy", csp);
    }
    return payload;
  });

  // Erro do Postgres nunca vai para o navegador: id malformado vira 404, o resto vira 500 genérico (detalhe só no log)
  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number; code?: unknown; severity?: unknown };
    const pgCode = err.severity ? String(err.code ?? "") : "";
    if (pgCode) {
      if (pgCode === "22P02" || pgCode === "22007" || pgCode === "22008") {
        const badId = Object.values((req.params ?? {}) as Record<string, string>).some((v) => !/^[0-9a-f-]{36}$/i.test(String(v)));
        return reply.code(badId ? 404 : 400).send({ error: badId ? "não encontrado" : "Dado inválido" });
      }
      req.log.error({ err }, "erro no banco");
      return reply.code(500).send({ error: "Erro interno. Tente de novo." });
    }
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "erro na rota");
    return reply.code(status).send({ error: err.message });
  });
}

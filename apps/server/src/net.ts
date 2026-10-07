import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { config } from "./config.js";

/**
 * Trava contra SSRF: os agentes abrem URLs que vêm da conversa (ou de páginas da web), então nunca podem
 * alcançar a rede interna da stack (db, redis, browserless, app), o host (Portainer, Traefik) nem o metadata
 * do provedor de nuvem. Só http(s) para IPs públicos, conferido também a cada redirecionamento.
 */
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
] as const)
  blocked.addSubnet(net, bits, "ipv6");

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return blocked.check(ip, "ipv4");
  if (v === 6) {
    // ::ffff:10.0.0.1 (IPv4 dentro de IPv6)
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1]!, "ipv4");
    return blocked.check(ip, "ipv6");
  }
  return true;
}

export class BlockedUrlError extends Error {}

const hostCache = new Map<string, { at: number; ok: boolean }>();

/** O host resolve só para IPs públicos? (cache de 1 min, para o navegador não fazer DNS a cada arquivo) */
export async function isPublicHost(hostname: string): Promise<boolean> {
  if (config.ALLOW_PRIVATE_URLS) return true;
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return false;
  if (isIP(host)) return !isPrivateIp(host);
  const hit = hostCache.get(host);
  if (hit && Date.now() - hit.at < 60_000) return hit.ok;
  let ok = false;
  try {
    const addrs = await lookup(host, { all: true, verbatim: true });
    ok = addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    ok = false;
  }
  hostCache.set(host, { at: Date.now(), ok });
  if (hostCache.size > 2000) hostCache.clear();
  return ok;
}

/** Valida uma URL vinda da conversa; devolve a URL normalizada ou lança BlockedUrlError. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new BlockedUrlError(`URL inválida: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BlockedUrlError("Só endereços http(s) são permitidos");
  if (url.username || url.password) throw new BlockedUrlError("URL com usuário/senha não é permitida");
  if (!(await isPublicHost(url.hostname))) throw new BlockedUrlError(`Endereço interno ou privado bloqueado: ${url.hostname}`);
  return url;
}

/** Valida a URL e devolve o texto a usar: o original quando já tem esquema, senão o normalizado. */
export async function checkedUrl(raw: string): Promise<string> {
  const url = await assertPublicUrl(raw);
  return /^https?:\/\//i.test(raw) ? raw : url.toString();
}

/** fetch que só fala com a internet pública, conferindo cada redirecionamento. */
export async function safeFetch(raw: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let url = await assertPublicUrl(raw);
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await fetch(url, { ...init, redirect: "manual" });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) return res;
    url = await assertPublicUrl(new URL(loc, url).toString());
  }
  throw new BlockedUrlError("Redirecionamentos demais");
}

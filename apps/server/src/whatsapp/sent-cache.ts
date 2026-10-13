import { proto, type WAMessage, type WAMessageKey } from "baileys";
import { cacheGet, cacheSet } from "../shortmem.js";

/**
 * Mensagens que enviamos, guardadas por 24h para atender o pedido de reenvio do WhatsApp.
 * Quando o celular de quem recebe não consegue abrir uma mensagem (aparece "Aguardando mensagem"), ele pede
 * de novo; o Baileys só guarda as dos últimos 5 minutos em memória e, sem o getMessage, a mensagem se perdia.
 * Memória local para o caso comum e Redis para depois de um reinício (só o conteúdo já enviado, sem mídia em si).
 */
const TTL_SECONDS = 24 * 3600;
const MAX_LOCAL = 500;
const local = new Map<string, { at: number; bytes: Buffer }>();
const keyOf = (id: string) => `wa:sent:${id}`;

export async function rememberSent(m: WAMessage) {
  const id = m.key?.id;
  if (!id || !m.message || !m.key.fromMe) return;
  const bytes = Buffer.from(proto.Message.encode(m.message).finish());
  local.set(id, { at: Date.now(), bytes });
  while (local.size > MAX_LOCAL) local.delete(local.keys().next().value!);
  await cacheSet(keyOf(id), bytes.toString("base64"), TTL_SECONDS).catch(() => false);
}

/** getMessage do Baileys: o conteúdo de uma mensagem nossa para reenviar, se ainda estiver guardado. */
export async function sentMessage(key: WAMessageKey): Promise<proto.IMessage | undefined> {
  if (!key.id) return undefined;
  const hit = local.get(key.id);
  let bytes = hit && Date.now() - hit.at < TTL_SECONDS * 1000 ? hit.bytes : undefined;
  if (!bytes) {
    const saved = await cacheGet<string>(keyOf(key.id)).catch(() => null);
    if (saved) bytes = Buffer.from(saved, "base64");
  }
  if (!bytes) return undefined;
  try {
    return proto.Message.decode(bytes);
  } catch {
    return undefined;
  }
}

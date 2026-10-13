import { S_WHATSAPP_NET } from "baileys";

/**
 * Perfil do número do assistente (nome, recado e foto), pela tela WhatsApp do painel.
 * Número com perfil completo passa mais confiança para quem recebe e para o WhatsApp do que um perfil vazio.
 * A foto chega pronta do painel (JPEG quadrado, recortado no navegador), então o servidor não precisa de
 * biblioteca de imagem nativa: vai direto no pedido w:profile:picture, como o Baileys faz.
 */
export interface WaProfile {
  name?: string;
  status?: string;
  /** JPEG em base64 */
  picture?: string;
}

export const NAME_MAX = 25;
export const STATUS_MAX = 139;
const PICTURE_MAX_BYTES = 1024 * 1024;

/** Confere e limpa o que veio do painel; devolve o erro para mostrar ou o perfil pronto. */
export function checkProfile(p: WaProfile): { error: string } | { profile: WaProfile } {
  const name = p.name?.trim();
  const status = p.status?.trim();
  if (name !== undefined && (!name || name.length > NAME_MAX)) return { error: `O nome precisa ter de 1 a ${NAME_MAX} letras.` };
  if (status !== undefined && status.length > STATUS_MAX) return { error: `O recado vai até ${STATUS_MAX} letras.` };
  if (p.picture !== undefined) {
    const bytes = Buffer.from(p.picture, "base64");
    if (bytes.length > PICTURE_MAX_BYTES) return { error: "A foto passou de 1 MB." };
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return { error: "A foto precisa ser JPEG." };
  }
  if (name === undefined && status === undefined && p.picture === undefined) return { error: "Nada para mudar." };
  return { profile: { name, status, picture: p.picture } };
}

/** Aplica no socket deste processo (o que segura a conexão). */
export async function applyProfile(p: WaProfile) {
  const { whatsapp } = await import("./session.js");
  const sock = await whatsapp.ready(15_000);
  if (p.name) await sock.updateProfileName(p.name);
  if (p.status !== undefined) await sock.updateProfileStatus(p.status);
  if (p.picture) {
    await sock.query({
      tag: "iq",
      attrs: { to: S_WHATSAPP_NET, type: "set", xmlns: "w:profile:picture" },
      content: [{ tag: "picture", attrs: { type: "image" }, content: Buffer.from(p.picture, "base64") }],
    });
  }
}

/** Da API ou de qualquer processo: aplica aqui ou pede ao processo que segura o WhatsApp. */
export async function updateProfile(p: WaProfile) {
  const { callChannel, holdsWhatsApp } = await import("./rpc.js");
  if (holdsWhatsApp()) return applyProfile(p);
  await callChannel({ op: "profile", profile: p }, 30_000);
}

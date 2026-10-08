import type { AuthenticationCreds, WASocket } from "baileys";
import QRCode from "qrcode";
import type { SessionStatus } from "./status.js";

/**
 * Já foi pareado? `creds.registered` NÃO serve: o Baileys só marca registered no pareamento por código;
 * quem conectou pelo QR fica com registered=false para sempre. O que prova o pareamento é a conta
 * assinada (account) que o WhatsApp devolve no pair-success, junto do me.id.
 */
export function isPaired(creds: Partial<AuthenticationCreds> | null | undefined) {
  return Boolean(creds?.account && creds?.me?.id);
}

/**
 * Pareamento de um aparelho novo: mostra no painel o QR ou, quando o painel mandou um telefone,
 * o código de pareamento (pedido uma vez só por socket).
 */
export class Pairing {
  private phone: string | null = null;

  constructor(private readonly status: SessionStatus) {}

  /** Próxima conexão pareia por código para este telefone, em vez de QR. */
  usePhone(phone: string) {
    this.phone = phone.replace(/\D/g, "");
  }

  /** Um por socket: devolve quem trata cada QR que o socket emitir. */
  forSocket(sock: WASocket) {
    let requested = false;
    return async (qr: string) => {
      if (this.phone && !requested) {
        requested = true;
        const code = await sock.requestPairingCode(this.phone);
        this.phone = null;
        await this.status.set("pairing", { pairing_code: code });
      } else if (!requested) {
        await this.status.set("qr", { qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }) });
      }
    };
  }
}

import type { WASocket } from "baileys";

/** Ping do WhatsApp (w:p): true se o servidor respondeu dentro do prazo. */
export async function pingSocket(sock: WASocket, timeoutMs: number) {
  try {
    await sock.query({ tag: "iq", attrs: { id: sock.generateMessageTag(), to: "s.whatsapp.net", type: "get", xmlns: "w:p" }, content: [{ tag: "ping", attrs: {} }] }, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/** Envios parados esperando a conexão mudar de estado (voltou, caiu de vez, perdeu o aluguel). */
export class Waiters {
  private waiting = new Set<() => void>();

  /** Espera até alguém acordar ou o prazo acabar, o que vier primeiro. */
  wait(ms: number) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiting.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiting.add(done);
    });
  }

  wake() {
    for (const w of [...this.waiting]) w();
  }
}

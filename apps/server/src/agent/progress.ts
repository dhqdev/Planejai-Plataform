import type { Channel } from "../channels/types.js";
import { redactSecrets } from "./guard.js";
import type { Tracer } from "./trace.js";

/** Avisos de reserva quando o CTO foi pesquisar sem dizer nada (variados para não soar robô). */
const FIRST = [
  "Deixa eu ver isso aqui rapidinho 🔎",
  "Boa! Já vou ver, um minutinho 👀",
  "Opa, tô pesquisando aqui, já te falo ⏳",
  "Hmm, deixa eu dar uma olhada nisso 🔍",
];
const STILL = [
  "Ainda tô nisso, só mais um pouquinho ⏳",
  "Tá quase, tô juntando tudo aqui 🙏",
  "Só mais um instante, tô conferindo os detalhes 👀",
];
const pick = (list: string[]) => list[Math.floor(Math.random() * list.length)]!;

/**
 * Ritmo da conversa como no Instinct: enquanto o time trabalha, a pessoa vê "digitando..." o tempo todo
 * e recebe avisos curtos ("já vou ver", "ainda tô nisso") em vez de esperar calada pela resposta final.
 * Nada aqui chama LLM: o aviso principal vem escrito pelo próprio CTO junto da delegação; os de reserva são fixos.
 */
export class Progress {
  /** textos já enviados nesta execução (entram na memória curta junto da resposta) */
  readonly sent: string[] = [];
  private busySince = 0;
  private timers: NodeJS.Timeout[] = [];
  private typing?: NodeJS.Timeout;
  private stillSent = false;
  private stopped = false;

  constructor(
    private o: { channel: Channel; jid: string; tracer: Tracer; firstAfterMs?: number; stillAfterMs?: number; max?: number },
  ) {}

  /** Mantém o "digitando..." ligado enquanto a execução roda. */
  start() {
    const tick = () => void this.o.channel.setTyping(this.o.jid, 12000).catch(() => {});
    tick();
    this.typing = setInterval(tick, 8000);
    this.typing.unref?.();
  }

  /** Avisa que algo demorado começou (delegação, navegador). Agenda os avisos de reserva. */
  busy() {
    if (this.busySince || this.stopped) return;
    this.busySince = Date.now();
    const first = setTimeout(() => {
      if (!this.sent.length) void this.say(pick(FIRST), "reserva");
    }, this.o.firstAfterMs ?? 7000);
    const still = setTimeout(() => {
      if (!this.stillSent) {
        this.stillSent = true;
        void this.say(pick(STILL), "reserva");
      }
    }, this.o.stillAfterMs ?? 45000);
    first.unref?.();
    still.unref?.();
    this.timers.push(first, still);
  }

  /** Manda um aviso agora (texto do CTO ou de reserva). No máximo `max` por execução. */
  async say(text: string, origin: "cto" | "reserva" = "cto") {
    const clean = redactSecrets(text.trim());
    if (!clean || this.stopped || this.sent.length >= (this.o.max ?? 3)) return false;
    this.sent.push(clean);
    const step = await this.o.tracer.step({ agent: "cto", type: "channel", name: "aviso_andamento", input: { text: clean, origem: origin } });
    try {
      const r = await this.o.channel.sendText(this.o.jid, clean);
      await step.ok(r);
      this.o.channel.setTyping(this.o.jid, 12000).catch(() => {});
      return true;
    } catch (err) {
      await step.fail(err);
      return false;
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    if (this.typing) clearInterval(this.typing);
  }
}

import type { AgentSettings } from "../settings.js";

/** Avisa o time para fechar a resposta quando faltar menos que isso do tempo máximo. */
const WRAP_UP_MS = 45_000;

export class GuardTimeout extends Error {
  constructor(
    readonly minutes: number,
    message = `Tempo máximo de execução atingido (${minutes} min)`,
  ) {
    super(message);
  }
}

/** Alguém pediu para parar (botão Parar em Execuções ou "para" no WhatsApp). */
export class GuardStopped extends Error {
  constructor() {
    super("Parada a pedido");
  }
}

/**
 * Travas de uma execução, compartilhadas pelo CTO e por todo o time: prazo máximo e número de ações.
 * Perto do fim do prazo o time é avisado para responder com o que já tem; no prazo, tudo que
 * estiver em andamento (LLM, ferramentas) é cancelado.
 */
export class Guard {
  readonly deadline: number;
  readonly minutes: number;
  readonly maxToolCalls: number;
  /** ações contadas para a execução inteira (o prazo de um especialista divide o mesmo contador) */
  private counter: { n: number };
  private controller = new AbortController();
  private timer: NodeJS.Timeout;
  /** duração desta trava (a execução inteira ou o prazo de um especialista) */
  private windowMs: number;

  constructor(opts: { maxExecutionMinutes: number; maxToolCalls: number; deadline?: number; counter?: { n: number }; reason?: string }) {
    this.minutes = opts.maxExecutionMinutes;
    this.maxToolCalls = opts.maxToolCalls;
    this.counter = opts.counter ?? { n: 0 };
    const ms = Math.max(1000, opts.deadline != null ? opts.deadline - Date.now() : opts.maxExecutionMinutes * 60_000);
    this.deadline = Date.now() + ms;
    this.windowMs = ms;
    this.timer = setTimeout(() => this.controller.abort(new GuardTimeout(this.minutes, opts.reason)), ms);
    this.timer.unref();
  }

  static fromSettings(s: AgentSettings) {
    return new Guard({ maxExecutionMinutes: s.maxExecutionMinutes, maxToolCalls: s.maxToolCalls });
  }

  get toolCalls() {
    return this.counter.n;
  }
  set toolCalls(n: number) {
    this.counter.n = n;
  }

  /**
   * Prazo de um especialista: termina `reserveMs` antes do prazo da execução, para quem chamou ainda ter tempo
   * de ler o relatório e responder, e nunca dura mais que `maxMs`. Cai junto se a execução inteira cair.
   */
  sub(reserveMs: number, maxMs = Infinity) {
    const left = this.remainingMs;
    const deadline = Date.now() + Math.min(maxMs, Math.max(Math.min(left, 15_000), left - reserveMs));
    const child = new Guard({
      maxExecutionMinutes: this.minutes,
      maxToolCalls: this.maxToolCalls,
      deadline,
      counter: this.counter,
      reason: "Tempo do especialista acabou: devolveu o que tinha",
    });
    const onAbort = () => child.controller.abort(this.signal.reason);
    if (this.expired) onAbort();
    else this.signal.addEventListener("abort", onAbort, { once: true });
    return child;
  }

  get signal() {
    return this.controller.signal;
  }
  /** parou porque pediram, não por tempo */
  get stopped() {
    return this.signal.reason instanceof GuardStopped;
  }
  /** Cancela tudo agora (LLM, ferramentas, especialistas: os prazos filhos caem junto). */
  stop() {
    if (!this.expired) this.controller.abort(new GuardStopped());
  }
  get expired() {
    return this.signal.aborted;
  }
  get remainingMs() {
    return this.deadline - Date.now();
  }
  /** hora de parar de chamar ferramentas e responder */
  get wrapUp() {
    // relativo à própria janela: um especialista com 80 s fecha nos últimos ~25 s, não nos últimos 45
    return this.remainingMs < Math.min(WRAP_UP_MS, this.windowMs * 0.3) || this.toolCalls >= this.maxToolCalls;
  }

  /** Roda algo que termina sozinho no prazo (a promessa original segue, mas ninguém espera por ela). */
  race<T>(p: Promise<T>): Promise<T> {
    if (this.expired) return Promise.reject(this.signal.reason);
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
      p.then(resolve, reject).finally(() => this.signal.removeEventListener("abort", onAbort));
    });
  }

  dispose() {
    clearTimeout(this.timer);
  }
}

const SECRET_PATTERNS = [
  /\bsk-(?:or-v1-|proj-|live_|test_)?[A-Za-z0-9_-]{20,}/g,
  /\brk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bntn_[A-Za-z0-9]{20,}/g,
  /\bsecret_[A-Za-z0-9]{30,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/g,
  /\blin_api_[A-Za-z0-9]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAPP_USR-[0-9a-f-]{20,}/g,
  /\btvly-[A-Za-z0-9-]{16,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\b1\/\/0[A-Za-z0-9_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** Última barreira antes do WhatsApp: nenhuma chave de API sai numa mensagem, mesmo que o modelo seja enganado. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[chave oculta]");
  return out;
}

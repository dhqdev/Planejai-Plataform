import type { Page } from "puppeteer-core";
import { BrowserSession } from "./browser.js";

/**
 * Robô do m.uber.com (Uber pelo WhatsApp, beta). Código fixo, sem o modelo clicar: acha campos e botões pelo texto,
 * pelo rótulo e pelo placeholder (não por classe CSS, que a Uber troca toda hora), então gasta zero token por tela.
 * Nunca digita senha nem cartão (a trava do browser.ts continua) e nunca mexe na forma de pagamento: vale a que já está na Uber.
 * Ponto fraco: foi escrito sem acesso ao site de verdade, então tela que ele não reconhece volta como UberScreenError
 * com o texto da página (vai para Execuções) para ajustar.
 */

/** Página inicial do robô; os testes trocam por uma página falsa local. */
export const UBER = { base: "https://m.uber.com/go/home" };

export interface UberCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface UberOption {
  n: number;
  name: string;
  price_cents: number | null;
  price_max_cents: number | null;
  price_text: string;
  eta: string | null;
}

export interface RobotIO {
  /** a Uber pediu um código: avisa a pessoa e espera (null = não chegou a tempo) */
  waitCode(kind: "sms" | "email", attempt: number): Promise<string | null>;
  /** registra o que o robô viu (Execuções) */
  note(name: string, data?: unknown): Promise<void>;
}

export type ScreenKind = "home" | "phone" | "code" | "password" | "captcha" | "continue" | "unknown";

/** Tela que o robô não sabe passar: login com senha, captcha, site mudou. */
export class UberScreenError extends Error {
  constructor(
    readonly reason: "captcha" | "password" | "code" | "unknown" | "route" | "options" | "request",
    message: string,
    readonly pageText = "",
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** pausa de gente entre um passo e outro (a Uber desconfia de clique instantâneo) */
const human = () => sleep(600 + Math.random() * 700);

/** "R$ 23,40" -> 2340; "R$ 20,50-25,90" -> [2050, 2590] */
export function parsePrice(text: string): { min: number; max: number | null } | null {
  const m = text.match(/R\$\s*([\d.]+(?:,\d{2})?)(?:\s*[-–a]\s*(?:R\$\s*)?([\d.]+(?:,\d{2})?))?/);
  if (!m) return null;
  const cents = (v: string) => Math.round(Number(v.replace(/\./g, "").replace(",", ".")) * 100);
  const min = cents(m[1]!);
  if (!Number.isFinite(min) || min <= 0) return null;
  const max = m[2] ? cents(m[2]) : null;
  return { min, max: max && max > min ? max : null };
}

/** Código de 4 a 6 dígitos numa mensagem ("Seu código Uber é 1234", "1234"). */
export function extractCode(text: string): string | null {
  const t = String(text ?? "");
  const near = t.match(/(?:c[oó]digo|code)\D{0,30}(\d{4,6})\b/i);
  if (near) return near[1]!;
  const all = t.match(/(?<![\d,.])\d{4,6}(?![\d,.])/g) ?? [];
  // ano ("2026") não é código quando há outro número
  const pick = all.filter((d) => !/^(19|20)\d{2}$/.test(d));
  return pick[0] ?? all[0] ?? null;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Opção que a pessoa escolheu: número da lista ou nome ("o comfort", "uberx"). */
export function pickOption(options: UberOption[], choice: string | number): UberOption | null {
  const c = norm(String(choice)).replace(/^(o|a|opcao|opção|numero)\s+/, "");
  const n = Number(c.match(/^\d+$/)?.[0]);
  if (n) return options.find((o) => o.n === n) ?? null;
  const exact = options.find((o) => norm(o.name) === c);
  if (exact) return exact;
  const has = options.filter((o) => norm(o.name).includes(c) || c.includes(norm(o.name)));
  return has.length === 1 ? has[0]! : (has.sort((a, b) => a.name.length - b.name.length)[0] ?? null);
}

export class UberRobot {
  private constructor(private s: BrowserSession) {}

  get page(): Page {
    return this.s.page;
  }

  /** Abre o Chrome leve (sem imagem/fonte), no jeito de celular, com os cookies salvos da pessoa. */
  static async open(cookies: UberCookie[] | null): Promise<UberRobot> {
    const s = await BrowserSession.open(false, { device: "mobile", lite: true });
    const r = new UberRobot(s);
    if (cookies?.length) {
      const cdp = await s.page.createCDPSession();
      await cdp.send("Network.setCookies", { cookies }).catch(() => {});
      await cdp.detach().catch(() => {});
    }
    return r;
  }

  /** Cookies da Uber para guardar (cifrados) e entrar de novo sem código. */
  async cookies(): Promise<UberCookie[]> {
    const cdp = await this.page.createCDPSession();
    try {
      const { cookies } = (await cdp.send("Network.getAllCookies")) as { cookies: any[] };
      return cookies
        .filter((c) => /(^|\.)uber\.com$/.test(String(c.domain).replace(/^\./, "")) || UBER.base.includes(String(c.domain).replace(/^\./, "")))
        .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires > 0 ? c.expires : undefined, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite }));
    } finally {
      await cdp.detach().catch(() => {});
    }
  }

  async close() {
    await this.s.close();
  }

  /** Print da tela (sem imagens, que o modo leve não baixa) para entender onde o robô parou. */
  async screenshot(): Promise<string | null> {
    return (await this.page.screenshot({ type: "jpeg", quality: 60, encoding: "base64" }).catch(() => null)) as string | null;
  }

  async text(max = 1500) {
    return (await this.page.evaluate(() => document.body?.innerText ?? "").catch(() => "")).replace(/\s+\n/g, "\n").slice(0, max);
  }

  private async settle(ms = 6000) {
    await this.page.waitForNetworkIdle({ idleTime: 500, timeout: ms }).catch(() => {});
  }

  /** O que está na tela agora. */
  async screen(): Promise<ScreenKind> {
    return this.page
      .evaluate(() => {
        const vis = (el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          const st = getComputedStyle(el as HTMLElement);
          return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
        };
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>("input, textarea")).filter(vis);
        const label = (el: HTMLInputElement) => `${el.placeholder} ${el.getAttribute("aria-label") ?? ""} ${el.name} ${el.id} ${el.autocomplete}`.toLowerCase();
        const text = (document.body?.innerText ?? "").toLowerCase();
        // o login da Uber carrega o script do captcha (invisível) em toda página: só conta desafio que aparece de verdade na tela
        const challenge = Array.from(document.querySelectorAll('iframe[src*="captcha" i], iframe[src*="arkose" i], iframe[src*="funcaptcha" i], iframe[title*="captcha" i], iframe[title*="desafio" i], iframe[title*="challenge" i]')).some((f) => {
          const r = f.getBoundingClientRect();
          return vis(f) && r.width >= 120 && r.height >= 60;
        });
        if (challenge || /não sou um robô|verify you are human|i'm not a robot|prove you're human|resolva (o|este) (desafio|quebra-cabe[cç]a)|solve (the|this) puzzle/.test(text)) return "captcha";
        if (inputs.some((i) => i.type === "password")) return "password";
        const otp = inputs.filter((i) => i.autocomplete === "one-time-code" || i.maxLength === 1 || /code|c[oó]digo|otp|verification/.test(label(i)));
        if (otp.length) return "code";
        if (inputs.some((i) => /para onde|where to|destino|dropoff|drop-off|destination/.test(label(i)))) return "home";
        if (inputs.some((i) => i.type === "tel" || /phone|telefone|celular|e-?mail|PHONE_NUMBER/i.test(label(i)))) return "phone";
        const buttons = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a')).filter(vis);
        if (buttons.some((b) => /^(continuar|continue|próximo|avançar|next|sim, sou eu|yes|it's me|sou eu)$/i.test((b.innerText || "").trim()))) return "continue";
        return "unknown";
      })
      .catch(() => "unknown" as ScreenKind);
  }

  /** Clica no primeiro botão/link visível cujo texto bate. */
  async click(re: RegExp): Promise<boolean> {
    const handle = await this.page.evaluateHandle((src: string, flags: string) => {
      const rx = new RegExp(src, flags);
      const vis = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      return (
        Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a, [role="option"], li[tabindex], div[tabindex]'))
          .filter(vis)
          .find((el) => rx.test(((el.innerText || el.getAttribute("aria-label") || "") as string).replace(/\s+/g, " ").trim())) ?? null
      );
    }, re.source, re.flags);
    const el = handle.asElement() as import("puppeteer-core").ElementHandle<Element> | null;
    if (!el) return false;
    await human();
    await el.click().catch(() => {});
    await this.settle();
    return true;
  }

  /** Campo de texto visível cujo rótulo/placeholder bate. */
  private async field(re: RegExp) {
    const handle = await this.page.evaluateHandle((src: string, flags: string) => {
      const rx = new RegExp(src, flags);
      const vis = (el: Element) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const labelOf = (el: HTMLInputElement) => {
        const byFor = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : "";
        return `${el.placeholder} ${el.getAttribute("aria-label") ?? ""} ${el.name} ${el.id} ${byFor ?? ""} ${el.closest("label")?.textContent ?? ""}`;
      };
      return Array.from(document.querySelectorAll<HTMLInputElement>("input:not([type=hidden]), textarea")).filter(vis).find((el) => rx.test(labelOf(el))) ?? null;
    }, re.source, re.flags);
    return handle.asElement() as import("puppeteer-core").ElementHandle<HTMLInputElement> | null;
  }

  private async typeInto(el: import("puppeteer-core").ElementHandle<HTMLInputElement>, text: string) {
    await el.click({ count: 3 }).catch(() => {});
    await el.evaluate((i) => {
      i.value = "";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await el.type(text, { delay: 60 + Math.random() * 60 });
  }

  /** Abre a Uber e, se precisar, entra pelo número da pessoa (códigos por SMS/e-mail via io). */
  async ensureLogin(phone: string, io: RobotIO): Promise<"sessao" | "login"> {
    await this.s.goto(UBER.base);
    await this.settle(10_000);
    let didLogin = false;
    let typedPhone = false;
    let codes = 0;
    for (let round = 0; round < 12; round++) {
      const kind = await this.screen();
      if (kind === "home") return didLogin ? "login" : "sessao";
      didLogin = true;
      if (kind === "captcha") throw new UberScreenError("captcha", "A Uber pediu para provar que não é robô", await this.text());
      if (kind === "password") {
        // conta com senha: a Uber costuma oferecer entrar por código; senha a gente nunca digita
        if (await this.click(/mais op[cç][oõ]es|more options|enviar c[oó]digo|send (me )?(a )?code|usar c[oó]digo|receber c[oó]digo|text me|sms/i)) continue;
        throw new UberScreenError("password", "A Uber pediu a senha da conta", await this.text());
      }
      if (kind === "phone") {
        if (typedPhone) throw new UberScreenError("unknown", "A Uber voltou para o número de celular", await this.text());
        const f = await this.field(/phone|telefone|celular|e-?mail|PHONE_NUMBER/i);
        if (!f) throw new UberScreenError("unknown", "Não achei o campo do celular", await this.text());
        await this.typeInto(f, `+${phone.replace(/\D/g, "")}`);
        typedPhone = true;
        await human();
        if (!(await this.click(/^(continuar|continue|próximo|avançar|next|entrar|log ?in)$/i))) await this.page.keyboard.press("Enter");
        await this.settle(10_000);
        continue;
      }
      if (kind === "code") {
        const page = (await this.text(800)).toLowerCase();
        const by: "sms" | "email" = /e-?mail/.test(page) && !/sms|mensagem de texto|text message|whatsapp/.test(page) ? "email" : "sms";
        if (codes >= 3) throw new UberScreenError("code", "Três códigos não passaram", await this.text());
        const code = await io.waitCode(by, codes);
        codes++;
        if (!code) throw new UberScreenError("code", "O código não chegou a tempo");
        await io.note(`código por ${by === "email" ? "e-mail" : "SMS"} digitado`);
        await this.typeCode(code);
        await this.settle(10_000);
        continue;
      }
      if (kind === "continue") {
        await this.click(/^(continuar|continue|próximo|avançar|next|sim, sou eu|yes|it's me|sou eu)$/i);
        continue;
      }
      // tela sem campo conhecido: botão de entrar da página inicial, senão desiste com o texto para ajustar
      if (round === 0 && (await this.click(/^(entrar|fazer login|log ?in|sign ?in|login)$/i))) continue;
      throw new UberScreenError("unknown", "Tela da Uber que eu não conheço", await this.text());
    }
    throw new UberScreenError("unknown", "O login da Uber não terminou", await this.text());
  }

  private async typeCode(code: string) {
    const boxes = await this.page.$$('input[autocomplete="one-time-code"], input[maxlength="1"]');
    const first = boxes[0] ?? (await this.field(/code|c[oó]digo|otp|verification/i));
    if (!first) throw new UberScreenError("code", "Não achei onde digitar o código", await this.text());
    await first.click().catch(() => {});
    // nas caixinhas de um dígito o foco anda sozinho; num campo só, entra tudo junto
    await this.page.keyboard.type(code, { delay: 120 });
    await human();
    await this.click(/^(continuar|continue|próximo|verificar|verify|confirmar|next|enviar)$/i);
  }

  /** Preenche origem e destino com a primeira sugestão da Uber; devolve como ela entendeu. */
  async setRoute(pickup: string, dropoff: string): Promise<{ pickup: string; dropoff: string }> {
    const pick = await this.fillPlace(/partida|origem|embarque|pickup|pick-up|local de partida|onde você está|start/i, pickup);
    const drop = await this.fillPlace(/para onde|destino|dropoff|drop-off|where to|destination/i, dropoff);
    await this.click(/^(ver pre[cç]os|see prices|pesquisar|search|buscar|confirmar|done|concluir)$/i);
    await this.settle(12_000);
    return { pickup: pick, dropoff: drop };
  }

  private async fillPlace(re: RegExp, text: string): Promise<string> {
    let f = await this.field(re);
    if (!f) {
      // na home às vezes o campo é um botão "Para onde?" que abre a busca
      await this.click(re);
      f = await this.field(re);
    }
    if (!f) throw new UberScreenError("route", `Não achei o campo de ${/destino|para onde/.test(re.source) ? "destino" : "partida"}`, await this.text());
    await this.typeInto(f, text);
    await sleep(1800);
    await this.settle(5000);
    const chosen = await this.page.evaluate(() => {
      const vis = (el: Element) => (el as HTMLElement).getBoundingClientRect().height > 0;
      const opt =
        Array.from(document.querySelectorAll<HTMLElement>('[role="option"], [role="listbox"] li, ul[role="listbox"] > *, [data-testid*="suggestion" i], [data-baseweb="menu"] li')).filter(vis)[0] ?? null;
      if (!opt) return null;
      const label = opt.innerText.replace(/\s+/g, " ").trim();
      opt.click();
      return label;
    });
    if (!chosen) {
      await this.page.keyboard.press("ArrowDown");
      await this.page.keyboard.press("Enter");
    }
    await human();
    await this.settle(6000);
    return chosen ?? text;
  }

  /** Lê as opções de corrida com preço e tempo (marca cada uma para clicar depois). */
  async readOptions(): Promise<UberOption[]> {
    for (let i = 0; i < 6; i++) {
      const raw = await this.page.evaluate(() => {
        document.querySelectorAll("[data-pj-uber]").forEach((el) => el.removeAttribute("data-pj-uber"));
        const PRICE = /R\$\s*[\d.]+(,\d{2})?/;
        const own = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter(
          (el) => el.childElementCount === 0 && !el.closest("script, style, noscript, template") && el.getBoundingClientRect().height > 0 && PRICE.test(el.textContent ?? ""),
        );
        const out: { name: string; price: string; eta: string | null }[] = [];
        const seen = new Set<HTMLElement>();
        for (const p of own) {
          // sobe até o cartão da opção: o maior pai que ainda tem um preço só
          let box: HTMLElement = p;
          for (let k = 0; k < 7 && box.parentElement; k++) {
            const up = box.parentElement;
            // pai com o preço de outra opção já é a lista inteira
            if (own.filter((o) => o !== p && up.contains(o)).length) break;
            box = up;
            if (box.matches('li, [role="option"], [role="radio"], button, [data-testid*="product" i]')) break;
          }
          if (seen.has(box)) continue;
          seen.add(box);
          const lines = box.innerText.split("\n").map((l) => l.trim()).filter(Boolean);
          const price = lines.find((l) => PRICE.test(l)) ?? "";
          const name = lines.find((l) => !PRICE.test(l) && !/^\d+\s*min|^\d{1,2}:\d{2}|^•|promo|desconto|%|lugares|seats|^\d+$/i.test(l) && l.length <= 40) ?? "";
          const eta =
            lines.map((l) => l.match(/(\d+)\s*min(?!\w)/i)?.[0] ?? l.match(/\b\d{1,2}:\d{2}\b/)?.[0] ?? null).find(Boolean) ?? null;
          if (!name) continue;
          box.setAttribute("data-pj-uber", String(out.length + 1));
          out.push({ name, price, eta });
          if (out.length >= 6) break;
        }
        return out;
      });
      if (raw.length) {
        return raw.map((r, idx) => {
          const p = parsePrice(r.price);
          return { n: idx + 1, name: r.name, price_cents: p?.min ?? null, price_max_cents: p?.max ?? null, price_text: r.price, eta: r.eta };
        });
      }
      await sleep(2000);
    }
    throw new UberScreenError("options", "A Uber não mostrou as opções de corrida", await this.text());
  }

  /** Escolhe a opção e pede. Devolve o motorista se ele aparecer em até ~45 s. */
  async request(option: UberOption): Promise<{ requested: boolean; driver: Record<string, string> | null }> {
    const ok = await this.page.evaluate((n: number) => {
      const el = document.querySelector<HTMLElement>(`[data-pj-uber="${n}"]`);
      if (!el) return false;
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    }, option.n);
    if (!ok) throw new UberScreenError("request", "A opção sumiu da tela", await this.text());
    await human();
    const name = option.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const clicked =
      (await this.click(new RegExp(`^(escolher|confirmar|solicitar|pedir|request|choose|confirm)\\s+${name}$`, "i"))) ||
      (await this.click(/^(escolher|confirmar|solicitar|pedir|request|choose|confirm)( (a )?(corrida|viagem|uber|ride))?$/i));
    if (!clicked) throw new UberScreenError("request", "Não achei o botão de pedir", await this.text());
    // passo opcional de confirmar o ponto de embarque
    for (let i = 0; i < 3; i++) {
      await this.settle(6000);
      const t = (await this.text(2000)).toLowerCase();
      if (/procurando|buscando|looking for|finding|conectando|connecting|a caminho|on the way|chega em|arriving|motorista|driver/.test(t)) break;
      if (!(await this.click(/^(confirmar (o )?(local|ponto) de (embarque|partida)|confirm pickup|confirmar|confirm)$/i))) break;
    }
    const t = (await this.text(3000)).toLowerCase();
    const requested = /procurando|buscando|looking for|finding|conectando|connecting|a caminho|on the way|chega em|arriving|motorista|driver|cancelar (a )?(corrida|viagem)|cancel (ride|trip)/.test(t);
    if (!requested) throw new UberScreenError("request", "Não vi a confirmação da Uber depois de pedir", await this.text());
    let driver: Record<string, string> | null = null;
    for (let i = 0; i < 9 && !driver; i++) {
      driver = await this.page.evaluate(() => {
        const text = document.body?.innerText ?? "";
        const plate = text.match(/\b[A-Z]{3}[- ]?\d[A-Z0-9]\d{2}\b/)?.[0];
        if (!plate) return null;
        const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
        const at = lines.findIndex((l) => l.includes(plate));
        const near = lines.slice(Math.max(0, at - 4), at + 4);
        const eta = text.match(/(\d+)\s*min(?!\w)/i)?.[0] ?? "";
        return { plate, car: near.find((l) => l !== plate && /[a-z]/i.test(l) && l.length < 40 && !/min\b/i.test(l)) ?? "", eta, info: near.join(" · ").slice(0, 200) };
      });
      if (!driver) await sleep(5000);
    }
    return { requested, driver };
  }
}

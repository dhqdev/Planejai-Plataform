import { checkedUrl, isPublicHost } from "../net.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Browser, CDPSession, HTTPRequest, Page } from "puppeteer-core";
import { config } from "../config.js";
import { getCredentials } from "../integrations/registry.js";

const run = promisify(execFile);
const MAX_FRAMES = 900;
const SNAPSHOT_TEXT = 2500;
const MAX_ELEMENTS = 40;

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  elements: string;
}

/**
 * "Computador" dos agentes: um navegador de verdade (browserless da stack, ou Chrome local em dev)
 * que o Pesquisador controla passo a passo (abrir, clicar, digitar, rolar) enquanto tudo é gravado
 * em vídeo. Para economizar tokens, o agente recebe só o texto da página e a lista numerada de
 * elementos clicáveis, nunca a imagem.
 */
/** Tamanho da tela de cada aparelho (o painel mostra a tela da loja do jeito que a pessoa está vendo). */
export const DEVICES = {
  desktop: { width: 1280, height: 800, isMobile: false, hasTouch: false },
  mobile: { width: 390, height: 780, isMobile: true, hasTouch: true },
} as const;

/**
 * O Chrome sem tela se anuncia como "HeadlessChrome" e com navigator.webdriver ligado, e várias lojas (Mercado Livre,
 * Shopee) respondem com página de erro ou em espanhol. Aqui ele se apresenta como um Chrome comum, em português e no
 * fuso de São Paulo, no tamanho do aparelho de quem está usando. Não burla captcha nem login: só não parece robô à toa.
 */
async function passAsPerson(page: Page, version: string, device: keyof typeof DEVICES) {
  const major = version.match(/(\d+)\./)?.[1] ?? "130";
  const mobile = device === "mobile";
  const ua = mobile
    ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
    : `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const brands = [
    { brand: "Chromium", version: major },
    { brand: "Google Chrome", version: major },
    { brand: "Not?A_Brand", version: "99" },
  ];
  await page
    .setUserAgent(ua, { brands, fullVersion: `${major}.0.0.0`, platform: mobile ? "Android" : "Windows", platformVersion: mobile ? "14.0.0" : "10.0.0", architecture: mobile ? "" : "x86", model: mobile ? "Pixel 8" : "", mobile })
    .catch(() => {});
  await page.emulateTimezone("America/Sao_Paulo").catch(() => {});
  await page.setViewport({ ...DEVICES[device], deviceScaleFactor: 1 });
  await page
    .evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["pt-BR", "pt", "en-US"] });
    })
    .catch(() => {});
}

export interface BrowserAct {
  action: string;
  ref?: number;
  text?: string;
  url?: string;
  key?: string;
  direction?: string;
  /** aperta Enter depois de digitar (busca, "digite para entrar") */
  submit?: boolean;
  /** fill: vários campos de uma vez */
  fields?: { ref: number; text: string }[];
}

/** O navegador recusou a ação por segurança ou porque a opção não existe: volta para o agente como erro, com a página atual. */
export class BrowserRefusal extends Error {}

/** Botão que gasta dinheiro. O "sim" não segura o navegador aberto até a pessoa responder, então quem conclui é ela. */
const PAY_BUTTON =
  /^(pagar|pagar agora|comprar)$|finalizar (a )?(compra|pedido)|comprar agora|confirmar (o )?(pagamento|pedido|compra)|efetuar (o )?pagamento|fazer (o )?pedido|concluir (a )?(compra|pedido|pagamento)|assinar agora|place order|pay now|buy now/i;

const KEY_ALIAS: Record<string, string> = { ctrl: "Control", control: "Control", cmd: "Meta", meta: "Meta", alt: "Alt", shift: "Shift", enter: "Enter", esc: "Escape", tab: "Tab" };

/** Número de cartão (13 a 19 dígitos que passam no Luhn). */
export function looksLikeCard(text: string) {
  const d = text.replace(/[\s.-]/g, "");
  if (!/^\d{13,19}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d[d.length - 1 - i]);
    if (i % 2) n = n * 2 > 9 ? n * 2 - 9 : n * 2;
    sum += n;
  }
  return sum % 10 === 0;
}

const LITE_SKIP = new Set(["image", "media", "font"]);

export class BrowserSession {
  private frames: { data: Buffer; ts: number }[] = [];
  private cdp: CDPSession | null = null;
  recording = false;
  /** a pessoa pediu para receber a gravação */
  sendRecording = false;
  actions: string[] = [];
  readonly openedAt = Date.now();

  private constructor(private browser: Browser, readonly page: Page) {}

  /** lite: não baixa imagem, vídeo nem fonte (o robô da Uber só lê texto e gasta bem menos memória e banda) */
  static async open(record: boolean, opts: { device?: "desktop" | "mobile"; lite?: boolean } = {}): Promise<BrowserSession> {
    const puppeteer = (await import("puppeteer-core")).default;
    const b = await getCredentials("browserless");
    let browser: Browser;
    if (b?.url) {
      const ws = b.url.replace(/^http/, "ws").replace(/\/$/, "");
      const qs = new URLSearchParams({ timeout: "300000" });
      if (b.token) qs.set("token", b.token);
      browser = await puppeteer.connect({ browserWSEndpoint: `${ws}?${qs}`, defaultViewport: { width: 1280, height: 800 } });
    } else if (config.CHROME_PATH) {
      browser = await puppeteer.launch({
        executablePath: config.CHROME_PATH,
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        defaultViewport: { width: 1280, height: 800 },
      });
    } else {
      throw new Error("Navegador não configurado: conecte o Browserless (já vem na stack) ou defina CHROME_PATH.");
    }
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    await passAsPerson(page, await browser.version(), opts.device ?? "desktop");
    // nenhum pedido da página (link, redirecionamento, script, imagem) pode ir para a rede interna da stack
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (req.isInterceptResolutionHandled()) return;
      let u: URL;
      try {
        u = new URL(req.url());
      } catch {
        return void req.abort("blockedbyclient").catch(() => {});
      }
      if (opts.lite && LITE_SKIP.has(req.resourceType())) return void req.abort("blockedbyclient").catch(() => {});
      if (u.protocol === "data:" || u.protocol === "blob:" || u.protocol === "about:") return void req.continue().catch(() => {});
      if (u.protocol !== "http:" && u.protocol !== "https:") return void req.abort("blockedbyclient").catch(() => {});
      void isPublicHost(u.hostname).then(
        (ok) => (ok ? req.continue() : req.abort("blockedbyclient")).catch(() => {}),
        () => req.abort("blockedbyclient").catch(() => {}),
      );
    });
    const s = new BrowserSession(browser, page);
    if (record) await s.startRecording();
    return s;
  }

  private async startRecording() {
    this.cdp = await this.page.createCDPSession();
    this.cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp?: number } }) => {
      if (this.frames.length < MAX_FRAMES) this.frames.push({ data: Buffer.from(f.data, "base64"), ts: (f.metadata.timestamp ?? Date.now() / 1000) * 1000 });
      void this.cdp?.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1280, maxHeight: 800, everyNthFrame: 1 });
    this.recording = true;
  }

  get frameCount() {
    return this.frames.length;
  }

  async snapshot(): Promise<Snapshot> {
    await this.page.waitForNetworkIdle({ idleTime: 500, timeout: 8000 }).catch(() => {});
    const data = await this.page.evaluate(
      (maxEls: number, maxText: number) => {
        document.querySelectorAll("[data-pj-ref]").forEach((el) => el.removeAttribute("data-pj-ref"));
        const FIELD =
          'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="image"]), select, textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="searchbox"], [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"]';
        const CLICK =
          'a[href], button, input[type="submit"], input[type="button"], input[type="image"], summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [aria-haspopup]:not([aria-haspopup="false"]), [onclick]';
        const LAYER = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"], [role="menu"], [role="listbox"]';
        const clean = (t: string | null | undefined, n = 70) => (t ?? "").replace(/\s+/g, " ").trim().slice(0, n);
        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight * 2.5) return false;
          const st = getComputedStyle(el);
          return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
        };
        // janela, menu ou lista de sugestões aberta na frente: o que está nela vem primeiro (aviso de cookies, menu, "digite para entrar")
        const layers = Array.from(document.querySelectorAll(LAYER)).filter(visible);
        const labelOf = (el: HTMLElement) => {
          const by = el.getAttribute("aria-labelledby");
          const fromIds = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.innerText ?? "").join(" ") : "";
          const labels = (el as HTMLInputElement).labels;
          let fromLabel = "";
          if (labels && labels.length) {
            // o texto do <label> sem o campo de dentro (senão a lista viria com todas as opções no nome)
            const c = labels[0]!.cloneNode(true) as HTMLElement;
            c.querySelectorAll("input, select, textarea").forEach((x) => x.remove());
            fromLabel = c.textContent ?? "";
          }
          return clean(el.getAttribute("aria-label") || fromIds || fromLabel || (el as HTMLInputElement).placeholder || el.getAttribute("title") || el.getAttribute("name"));
        };
        // senha e cartão: o modelo não vê o valor e não digita (a pessoa digita ela mesma)
        const sensitive = (el: HTMLElement) => {
          const i = el as HTMLInputElement;
          if (i.type === "password" || el.hasAttribute("data-pj-secret")) return "senha";
          const hint = `${i.autocomplete ?? ""} ${i.name ?? ""} ${el.id} ${labelOf(el)}`;
          return /\bcc-|cart[aã]o|card|cvv|cvc|c[oó]digo de seguran[cç]a|validade/i.test(hint) && el.matches("input") ? "cartão" : "";
        };
        const seen = new Set<Element>();
        const cands: { el: HTMLElement; line: string; rank: number }[] = [];
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(`${FIELD}, ${CLICK}`))) {
          if (seen.has(el) || cands.length >= 400 || !visible(el)) continue;
          seen.add(el);
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute("role") ?? "";
          const isField = el.matches(FIELD);
          const secret = isField ? sensitive(el) : "";
          let type: string;
          let label: string;
          const extra: string[] = [];
          if (isField) {
            const i = el as HTMLInputElement;
            const t = tag === "input" ? i.type : "";
            type =
              secret ? `campo ${secret}`
              : t === "checkbox" || role === "checkbox" || role === "switch" ? "caixa de marcar"
              : t === "radio" || role === "radio" ? "opção"
              : tag === "select" || role === "combobox" ? "lista"
              : tag === "input" ? `campo ${t}`
              : "campo texto";
            label = labelOf(el) || clean(el.innerText);
            const checked = t === "checkbox" || t === "radio" ? i.checked : el.getAttribute("aria-checked") === "true";
            if (/caixa|opção/.test(type)) extra.push(checked ? "(marcado)" : "(desmarcado)");
            else if (tag === "select") {
              const sel = el as unknown as HTMLSelectElement;
              const opts = Array.from(sel.options).map((o) => clean(o.text, 30)).filter(Boolean);
              extra.push(`= "${clean(sel.selectedOptions[0]?.text, 40)}"`, `(opções: ${opts.slice(0, 8).join(", ")}${opts.length > 8 ? `, +${opts.length - 8}` : ""})`);
            } else if (secret) {
              if (i.value) extra.push("(preenchido)");
            } else {
              const v = clean(tag === "input" || tag === "textarea" ? i.value : el.innerText, 60);
              if (v && v !== label) extra.push(`= "${v}"`);
            }
            if (i.required || el.getAttribute("aria-required") === "true") extra.push("(obrigatório)");
            if (i.disabled) extra.push("(bloqueado)");
          } else {
            type =
              role === "menuitem" || role === "menuitemcheckbox" || role === "menuitemradio" ? "item de menu"
              : role === "option" ? "opção da lista"
              : role === "tab" ? "aba"
              : tag === "a" || role === "link" ? "link"
              : "botão";
            label = clean(el.getAttribute("aria-label") || el.innerText || el.getAttribute("title") || (el as HTMLInputElement).value);
            if (!label) continue;
            const exp = el.getAttribute("aria-expanded");
            if (exp === "true") extra.push("(aberto)");
            else if (exp === "false" || (el.hasAttribute("aria-haspopup") && el.getAttribute("aria-haspopup") !== "false")) extra.push("(abre menu)");
            if (el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-current")) extra.push("(atual)");
          }
          if (document.activeElement === el) extra.push("(cursor aqui)");
          const inLayer = layers.some((l) => l.contains(el));
          cands.push({ el, line: `${type}: ${label || "(sem rótulo)"}${extra.length ? ` ${extra.join(" ")}` : ""}`, rank: inLayer ? 0 : isField || el.closest("form") ? 1 : el.hasAttribute("aria-expanded") || el.hasAttribute("aria-haspopup") ? 1.5 : 2 });
        }
        // o que está aberto na frente, campos e botões de menu vêm primeiro: numa página cheia de links o formulário não some do fim da lista
        cands.sort((a, b) => a.rank - b.rank);
        const out: string[] = [];
        cands.slice(0, maxEls).forEach((c, i) => {
          c.el.setAttribute("data-pj-ref", String(i + 1));
          out.push(`[${i + 1}] ${c.line}`);
        });
        if (cands.length > maxEls) out.push(`(+${cands.length - maxEls} itens mais abaixo: role a página para ver)`);
        const layerName = layers.length ? clean(layers[0]!.getAttribute("aria-label") || (layers[0] as HTMLElement).innerText, 50) : "";
        if (layerName) out.unshift(`(aberto na frente: "${layerName}"; os itens dele vêm primeiro)`);
        const raw = document.body?.innerText ?? "";
        // rolou a página: o texto começa onde a pessoa está olhando, senão o modelo só veria o topo de novo
        let view = raw;
        if (window.scrollY > 200) {
          const parts: string[] = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let last: Element | null = null;
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const t = node.textContent?.trim();
            const parent = node.parentElement;
            if (!t || !parent || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(parent.tagName)) continue;
            const r = parent.getBoundingClientRect();
            if (r.bottom < -40 || r.top > window.innerHeight * 2.5 || (r.width === 0 && r.height === 0)) continue;
            parts.push(parent === last ? ` ${t}` : `\n${t}`);
            last = parent;
          }
          view = `(página rolada; texto a partir daqui)\n${parts.join("")}`;
        }
        const text = view.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, maxText);
        return { title: document.title, text, elements: out.join("\n") };
      },
      MAX_ELEMENTS,
      SNAPSHOT_TEXT,
    );
    return { url: this.page.url(), ...data };
  }

  private async highlight(ref: string) {
    // destaca o que vai ser clicado, para a gravação mostrar o "mouse" do agente
    await this.page
      .evaluate((r: string) => {
        const el = document.querySelector<HTMLElement>(`[data-pj-ref="${r}"]`);
        if (!el) return;
        el.scrollIntoView({ block: "center" });
        el.style.outline = "3px solid #ff6d5a";
        el.style.outlineOffset = "2px";
      }, ref)
      .catch(() => {});
    await new Promise((r) => setTimeout(r, 350));
  }

  async goto(url: string) {
    url = await checkedUrl(url);
    this.actions.push(`abrir ${url}`);
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await this.dismissCookies();
  }

  /** Aviso de cookies/LGPD tapando a página: aceita sozinho (não gasta ação nem token do agente). */
  private async dismissCookies() {
    await this.page.waitForNetworkIdle({ idleTime: 400, timeout: 4000 }).catch(() => {});
    const done = await this.page
      .evaluate(() => {
        const OK = /^(aceitar( todos)?( os)?( cookies)?|aceito|concordo|ok|entendi|prosseguir|continuar|accept( all)?( cookies)?|allow all|i agree|got it)$/i;
        for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a[href="#"], input[type="button"], input[type="submit"]'))) {
          const label = (el.innerText || (el as HTMLInputElement).value || el.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
          if (!OK.test(label) || !el.getBoundingClientRect().width) continue;
          let box: HTMLElement | null = el;
          for (let i = 0; i < 6 && box; i++, box = box.parentElement) {
            if (/cookie|lgpd|privacidade|privacy/i.test(box.innerText ?? "")) {
              el.click();
              return true;
            }
          }
        }
        return false;
      })
      .catch(() => false);
    if (done) {
      this.actions.push("aceitar aviso de cookies");
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  /** O que tem no elemento antes de mexer: senha/cartão (a pessoa digita), botão de pagar (a pessoa conclui). */
  private async inspect(target: string) {
    const info = await this.page.$eval(target, (el) => {
      const i = el as HTMLInputElement;
      const name = ((el.getAttribute("aria-label") || (el as HTMLElement).innerText || i.value || "") as string).replace(/\s+/g, " ").trim();
      const hint = `${i.autocomplete ?? ""} ${i.name ?? ""} ${el.id} ${i.labels?.[0]?.innerText ?? ""} ${i.placeholder ?? ""} ${el.getAttribute("aria-label") ?? ""}`;
      return {
        tag: el.tagName.toLowerCase(),
        name: el.matches("input:not([type=submit]):not([type=button]), textarea, select") ? "" : name.slice(0, 80),
        secret: i.type === "password" || el.hasAttribute("data-pj-secret") || (el.matches("input") && /\bcc-|cart[aã]o|card|cvv|cvc|c[oó]digo de seguran[cç]a|validade/i.test(hint)),
      };
    });
    return { ...info, pay: PAY_BUTTON.test(info.name) };
  }

  private async typeInto(ref: number, text: string) {
    const target = `[data-pj-ref="${ref}"]`;
    const info = await this.inspect(target);
    if (info.secret) throw new BrowserRefusal("Senha e dados de cartão quem digita é a pessoa: não preencha. Diga a ela o que falta e mande o link.");
    if (looksLikeCard(text)) throw new BrowserRefusal("Isso parece número de cartão: não digite. Quem preenche cartão é a pessoa.");
    await this.highlight(String(ref));
    this.actions.push(`digitar "${text}" em [${ref}]`);
    await this.page.click(target).catch(() => {});
    // apaga o que já estava escrito (campo de busca com texto antigo, valor padrão) antes de digitar
    await this.page
      .$eval(target, (el) => {
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
        else document.getSelection()?.selectAllChildren(el);
      })
      .catch(() => {});
    await this.page.keyboard.press("Backspace");
    await this.page.keyboard.type(text, { delay: 35 });
  }

  async act(a: BrowserAct) {
    const target = a.ref != null ? `[data-pj-ref="${a.ref}"]` : null;
    // espera a página nova só se o clique/tecla abriu uma (antes todo clique em menu ou caixa esperava 8 s à toa)
    const nav = async () => {
      let started = false;
      const onReq = (r: HTTPRequest) => {
        if (r.isNavigationRequest() && r.frame() === this.page.mainFrame()) started = true;
      };
      this.page.on("request", onReq);
      const done = this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
      await Promise.race([done, new Promise((r) => setTimeout(r, 800)).then(() => (started ? done : undefined))]);
      this.page.off("request", onReq);
    };
    const settle = () => new Promise((r) => setTimeout(r, 400));
    const submit = async () => {
      this.actions.push("tecla Enter");
      await Promise.all([nav(), this.page.keyboard.press("Enter")]);
    };
    switch (a.action) {
      case "goto":
        if (!a.url) throw new Error("url obrigatória");
        await this.goto(a.url);
        break;
      case "click": {
        if (!target) throw new Error("ref obrigatório");
        if ((await this.inspect(target)).pay) {
          throw new BrowserRefusal("Esse botão paga ou fecha compra: quem conclui é a pessoa. Pare aqui e mande o link com o que já está preenchido.");
        }
        await this.highlight(String(a.ref));
        this.actions.push(`clicar [${a.ref}]`);
        await Promise.all([nav(), this.page.click(target)]);
        await settle();
        break;
      }
      case "hover": {
        // menu que abre ao passar o mouse
        if (!target) throw new Error("ref obrigatório");
        await this.highlight(String(a.ref));
        this.actions.push(`passar o mouse em [${a.ref}]`);
        await this.page.hover(target);
        await settle();
        break;
      }
      case "type": {
        if (a.ref == null) throw new Error("ref obrigatório");
        await this.typeInto(a.ref, a.text ?? "");
        if (a.submit) await submit();
        else await settle(); // sugestões do campo (autocompletar) aparecem na lista nova
        break;
      }
      case "fill": {
        // vários campos do mesmo formulário numa ação só
        if (!a.fields?.length) throw new Error("fields obrigatório: [{ref, text}]");
        for (const f of a.fields.slice(0, 12)) {
          const t = `[data-pj-ref="${f.ref}"]`;
          const tag = await this.page.$eval(t, (el) => el.tagName.toLowerCase());
          if (tag === "select") await this.act({ action: "select", ref: f.ref, text: f.text });
          else await this.typeInto(f.ref, f.text);
        }
        if (a.submit) await submit();
        else await settle();
        break;
      }
      case "press": {
        if (target) await this.page.focus(target).catch(() => {});
        // aceita atalho: "Control+K", "Ctrl+L", "Shift+Tab"
        const keys = (a.key ?? "Enter").split("+").map((k) => KEY_ALIAS[k.trim().toLowerCase()] ?? k.trim());
        this.actions.push(`tecla ${keys.join("+")}`);
        const last = keys.pop()!;
        for (const k of keys) await this.page.keyboard.down(k as any);
        await Promise.all([nav(), this.page.keyboard.press(last as any)]);
        for (const k of keys.reverse()) await this.page.keyboard.up(k as any);
        await settle();
        break;
      }
      case "scroll":
        this.actions.push(`rolar ${a.direction ?? "down"}`);
        await this.page.evaluate((d: string) => window.scrollBy({ top: d === "up" ? -700 : 700, behavior: "smooth" }), a.direction ?? "down");
        await new Promise((r) => setTimeout(r, 700));
        break;
      case "back":
        this.actions.push("voltar");
        await this.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 }).catch(() => {});
        break;
      case "select": {
        if (!target) throw new Error("ref obrigatório");
        this.actions.push(`escolher "${a.text ?? ""}" em [${a.ref}]`);
        const want = a.text ?? "";
        if ((await this.inspect(target)).tag === "select") {
          // aceita o valor ou o texto da opção
          const value = await this.page.$eval(
            target,
            (el, w) => {
              const opts = Array.from((el as HTMLSelectElement).options ?? []);
              const low = String(w).toLowerCase();
              return (opts.find((o) => o.value === w) ?? opts.find((o) => o.text.trim().toLowerCase() === low) ?? opts.find((o) => o.text.toLowerCase().includes(low)))?.value ?? null;
            },
            want,
          );
          if (value == null) throw new BrowserRefusal("Essa opção não existe nessa lista. Veja as opções na lista abaixo.");
          await this.page.select(target, value);
          break;
        }
        // lista feita com div (combobox, menu): abre e clica na opção pelo texto
        await this.highlight(String(a.ref));
        await this.page.click(target);
        await settle();
        const found = await this.page.evaluate((w: string) => {
          document.querySelectorAll("[data-pj-pick]").forEach((el) => el.removeAttribute("data-pj-pick"));
          const low = w.toLowerCase().trim();
          const opts = Array.from(
            document.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="listbox"] li, [role="menu"] li, ul li'),
          ).filter((el) => el.getBoundingClientRect().width > 0 && getComputedStyle(el).visibility !== "hidden");
          const text = (el: HTMLElement) => (el.innerText ?? "").replace(/\s+/g, " ").trim().toLowerCase();
          const hit = opts.find((el) => text(el) === low) ?? opts.find((el) => text(el).includes(low));
          hit?.setAttribute("data-pj-pick", "1");
          return Boolean(hit);
        }, want);
        if (!found) throw new BrowserRefusal(`Abri a lista, mas não achei "${want}". Veja as opções na lista abaixo.`);
        await Promise.all([nav(), this.page.click("[data-pj-pick]")]);
        await settle();
        break;
      }
      case "wait":
        await new Promise((r) => setTimeout(r, Math.min(Number(a.text ?? 2000) || 2000, 10_000)));
        break;
      default:
        throw new Error(`ação desconhecida: ${a.action}`);
    }
  }

  async screenshot(): Promise<string> {
    return Buffer.from(await this.page.screenshot({ type: "jpeg", quality: 70 })).toString("base64");
  }

  /** Para a gravação e devolve um MP4 (H.264) pronto para o WhatsApp, ou null se não houver quadros/ffmpeg. */
  async stopRecording(): Promise<Buffer | null> {
    if (!this.recording) return null;
    this.recording = false;
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
    // segura o último quadro na tela por um instante
    if (this.frames.length) this.frames.push({ data: this.frames.at(-1)!.data, ts: this.frames.at(-1)!.ts + 1200 });
    if (this.frames.length < 2) return null;
    return encodeMp4(this.frames);
  }

  async close() {
    await this.stopRecording().catch(() => null);
    await this.browser.close().catch(() => {});
  }
}

/** Junta quadros com horário (screencast do Chrome só manda quadro quando a tela muda) num MP4. */
export async function encodeMp4(frames: { data: Buffer; ts: number }[]): Promise<Buffer | null> {
  const dir = await mkdtemp(join(tmpdir(), "pj-rec-"));
  try {
    const lines: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const file = join(dir, `f${String(i).padStart(4, "0")}.jpg`);
      await writeFile(file, frames[i]!.data);
      const next = frames[i + 1];
      const dur = next ? Math.min(Math.max((next.ts - frames[i]!.ts) / 1000, 0.04), 4) : 0.5;
      lines.push(`file '${file}'`, `duration ${dur.toFixed(3)}`);
    }
    lines.push(`file '${join(dir, `f${String(frames.length - 1).padStart(4, "0")}.jpg`)}'`);
    await writeFile(join(dir, "list.txt"), lines.join("\n"));
    const out = join(dir, "out.mp4");
    await run(
      "ffmpeg",
      ["-v", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "list.txt"), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=12,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-movflags", "+faststart", out],
      { timeout: 120_000 },
    );
    return await readFile(out);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

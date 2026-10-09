import { checkedUrl, isPublicHost } from "../net.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Browser, CDPSession, Page } from "puppeteer-core";
import { config } from "../config.js";
import { getCredentials } from "../integrations/registry.js";

const run = promisify(execFile);
const MAX_FRAMES = 900;
const SNAPSHOT_TEXT = 2500;
const MAX_ELEMENTS = 40;

/** Cookie guardado do login da pessoa numa loja (formato do Chrome DevTools). */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

export interface Snapshot {
  url: string;
  title: string;
  text: string;
  elements: string;
  /** códigos Pix copia e cola achados na página (texto ou campo), inteiros */
  pix?: string[];
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

export class BrowserSession {
  private frames: { data: Buffer; ts: number }[] = [];
  private cdp: CDPSession | null = null;
  recording = false;
  /** a pessoa pediu para receber a gravação */
  sendRecording = false;
  actions: string[] = [];
  /** loja em que entrou com o login da pessoa (para guardar os cookies renovados no fim) */
  store: string | null = null;
  /** guardar os cookies da loja no fim: entrou já logada ou fez login nesta navegação */
  saveLogin = false;
  readonly openedAt = Date.now();

  private constructor(private browser: Browser, readonly page: Page) {}

  static async open(record: boolean, opts: { cookies?: StoredCookie[]; device?: "desktop" | "mobile" } = {}): Promise<BrowserSession> {
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
    // login da pessoa numa loja (feito por ela no painel): entra já logada
    if (opts.cookies?.length) await page.setCookie(...(opts.cookies as any[])).catch(() => {});
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
        const sel = 'a[href], button, input:not([type="hidden"]), select, textarea, [role="button"], [role="link"], [role="tab"], [onclick]';
        const out: string[] = [];
        let n = 0;
        for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
          if (n >= maxEls) break;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > window.innerHeight * 2.5) continue;
          const st = getComputedStyle(el);
          if (st.visibility === "hidden" || st.display === "none") continue;
          // senha e o que o servidor digitou como segredo nunca aparecem para o modelo
          const secret = (el as HTMLInputElement).type === "password" || el.hasAttribute("data-pj-secret");
          const label = (el.getAttribute("aria-label") || el.innerText || (el as HTMLInputElement).placeholder || (secret ? "" : (el as HTMLInputElement).value) || el.getAttribute("title") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 70);
          const tag = el.tagName.toLowerCase();
          const type = tag === "a" ? "link" : tag === "input" ? `campo ${(el as HTMLInputElement).type}` : tag === "select" ? "lista" : tag === "textarea" ? "campo texto" : "botão";
          if (!label && tag !== "input" && tag !== "textarea") continue;
          n++;
          el.setAttribute("data-pj-ref", String(n));
          out.push(`[${n}] ${type}: ${label || "(sem rótulo)"}`);
        }
        const raw = document.body?.innerText ?? "";
        const text = raw.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim().slice(0, maxText);
        // Pix do checkout: o código passa do tamanho do texto e dos rótulos, então vem à parte e inteiro
        const sources = [raw, ...Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")).map((el) => el.value || "")];
        const pix = new Set<string>();
        for (const src of sources) for (const m of src.matchAll(/000201\S{30,600}?6304[0-9A-Fa-f]{4}/g)) pix.add(m[0]);
        return { title: document.title, text, elements: out.join("\n"), pix: [...pix].slice(0, 3) };
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
  }

  async act(a: { action: string; ref?: number; text?: string; url?: string; key?: string; direction?: string }) {
    const target = a.ref != null ? `[data-pj-ref="${a.ref}"]` : null;
    const nav = () => this.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {});
    switch (a.action) {
      case "goto":
        if (!a.url) throw new Error("url obrigatória");
        await this.goto(a.url);
        break;
      case "click": {
        if (!target) throw new Error("ref obrigatório");
        await this.highlight(String(a.ref));
        this.actions.push(`clicar [${a.ref}]`);
        await Promise.all([nav(), this.page.click(target)]);
        break;
      }
      case "type": {
        if (!target) throw new Error("ref obrigatório");
        await this.highlight(String(a.ref));
        this.actions.push(`digitar "${a.text ?? ""}" em [${a.ref}]`);
        await this.page.click(target, { count: 3 } as any).catch(() => {});
        await this.page.type(target, a.text ?? "", { delay: 40 });
        break;
      }
      case "press":
        this.actions.push(`tecla ${a.key ?? "Enter"}`);
        await Promise.all([nav(), this.page.keyboard.press((a.key ?? "Enter") as any)]);
        break;
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
        // aceita o valor ou o texto da opção
        const value = await this.page.$eval(
          target,
          (el, want) => {
            const opts = Array.from((el as HTMLSelectElement).options ?? []);
            const w = String(want).toLowerCase();
            return (opts.find((o) => o.value === want) ?? opts.find((o) => o.text.toLowerCase().includes(w)))?.value ?? null;
          },
          a.text ?? "",
        );
        if (value == null) throw new Error("opção não encontrada nessa lista");
        await this.page.select(target, value);
        break;
      }
      case "wait":
        await new Promise((r) => setTimeout(r, Math.min(Number(a.text ?? 2000) || 2000, 10_000)));
        break;
      default:
        throw new Error(`ação desconhecida: ${a.action}`);
    }
  }

  /** Digita um segredo (senha, código do e-mail) sem registrar o texto nas ações nem mostrar o valor na página para o modelo. */
  async fillSecret(ref: number, value: string, label: string) {
    const target = `[data-pj-ref="${ref}"]`;
    await this.highlight(String(ref));
    this.actions.push(`digitar ${label} em [${ref}]`);
    await this.page.$eval(target, (el) => el.setAttribute("data-pj-secret", "1"));
    await this.page.click(target, { count: 3 } as any).catch(() => {});
    await this.page.type(target, value, { delay: 40 });
  }

  /** Cookies dos domínios pedidos (para guardar o login da loja). */
  async cookiesFor(domains: string[]): Promise<StoredCookie[]> {
    const cdp = await this.page.createCDPSession();
    try {
      const { cookies } = (await cdp.send("Network.getAllCookies")) as { cookies: any[] };
      return cookies
        .filter((c) => domains.some((d) => c.domain.replace(/^\./, "") === d || c.domain.endsWith(`.${d}`)))
        .map((c) => ({ name: c.name, value: c.value, domain: c.domain, path: c.path, expires: c.expires, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite }));
    } finally {
      await cdp.detach().catch(() => {});
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

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { CampoSenha } from "../CampoSenha";
import { Icon } from "../icons";
import { haptic } from "../touch";
import { Mascote, type Mood } from "../mascote/Mascote";
import { MASCOTE } from "../mascote/nome";
import "../styles/cadastro-chat.css";

/**
 * Cadastro em forma de conversa (pedido do David em 2026-11-11: "ao invés de telas, um chat que o cliente vai
 * respondendo"). O roteiro é uma função assíncrona que fala (`say`), pergunta (`ask`) e oferece botões (`pick`);
 * a tela só desenha as mensagens e a caixa de resposta que a pergunta da vez pediu. Sem IA: texto fixo, pouco token.
 * Usado no cadastro (`SignupChat`) e na primeira conversa depois do login (`OnboardingFlow`).
 */

export type InputKind = "text" | "name" | "email" | "tel" | "password" | "code" | "otp";
export interface Choice {
  id: string;
  label: string;
  /** botão roxo (a resposta esperada) */
  main?: boolean;
}
export type Prompt =
  | { kind: "input"; input: InputKind; placeholder: string; initial?: string; actions?: Choice[] }
  | { kind: "pick"; options: Choice[]; many?: boolean; done?: string; actions?: Choice[]; initial?: string[] };
/** O que a pessoa respondeu: texto digitado, opções marcadas ou um dos botões de ação. */
export interface Reply {
  value: string;
  values: string[];
  action?: string;
}

interface Msg {
  id: number;
  from: "bot" | "me";
  text?: string;
  node?: ReactNode;
  error?: boolean;
}

class Cancelled extends Error {}

/** WhatsApp como a pessoa reconhece: (19) 99999-9999. */
export const telFmt = (raw: string) => {
  const d = raw.replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  const m = d.match(/^(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : raw;
};

const calm = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Foco automático só com mouse: no celular abriria o teclado sem a pessoa pedir. */
const desk = () => typeof matchMedia !== "undefined" && !matchMedia("(pointer: coarse)").matches;

export interface Chat {
  /** fala do Bolinho, com os três pontinhos antes (mais longo = digita mais) */
  say(text: string, opts?: { node?: ReactNode; error?: boolean; quick?: boolean }): Promise<void>;
  /** só o enfeite (cartão, cena) numa bolha sem texto */
  show(node: ReactNode): Promise<void>;
  /** espera a resposta da pessoa; o que ela mandou aparece na conversa como balão dela */
  ask(p: Prompt): Promise<Reply>;
  /** "digitando…" enquanto o servidor trabalha */
  working<T>(job: Promise<T>): Promise<T>;
  /** barrinha de progresso do topo, de 0 a 1 */
  progress(p: number): void;
  /** algo para a pessoa ver ao lado (cara do Bolinho) */
  mood(m: Mood | null): void;
}

/**
 * Roda um roteiro uma vez. Se a tela sai (ou o React monta duas vezes em desenvolvimento), o roteiro antigo para
 * no próximo passo sem mexer em nada.
 */
export function useChatScript(script: (c: Chat) => Promise<void>) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [typing, setTyping] = useState(false);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [progress, setProgress] = useState(0);
  const [mood, setMood] = useState<Mood | null>(null);
  const answer = useRef<((r: Reply) => void) | null>(null);
  const seq = useRef(0);
  const scriptRef = useRef(script);
  scriptRef.current = script;

  useEffect(() => {
    let live = true;
    const check = () => {
      if (!live) throw new Cancelled();
    };
    const push = (m: Omit<Msg, "id">) => setMsgs((list) => [...list, { ...m, id: ++seq.current }]);
    const chat: Chat = {
      async say(text, opts) {
        check();
        if (!calm()) {
          setTyping(true);
          await sleep(opts?.quick ? 260 : Math.min(1150, 380 + text.length * 11));
          check();
        }
        setTyping(false);
        push({ from: "bot", text, node: opts?.node, error: opts?.error });
      },
      async show(node) {
        check();
        push({ from: "bot", node });
        await sleep(calm() ? 0 : 200);
      },
      ask(p) {
        check();
        setPrompt(p);
        return new Promise<Reply>((resolve) => {
          answer.current = (r) => {
            if (!live) return;
            setPrompt(null);
            resolve(r);
          };
        }).then((r) => {
          check();
          // o balão da pessoa: o texto digitado (senha vira bolinhas) ou o rótulo do que ela tocou
          const all = [...(p.actions ?? []), ...(p.kind === "pick" ? p.options : [])];
          const said = r.action
            ? all.find((c) => c.id === r.action)?.label
            : p.kind === "pick"
              ? r.values.map((v) => p.options.find((o) => o.id === v)?.label ?? v).join(", ")
              : p.input === "password"
                ? "•".repeat(Math.min(12, r.value.length))
                : p.input === "tel"
                  ? telFmt(r.value)
                  : r.value;
          if (said) push({ from: "me", text: said });
          return r;
        });
      },
      async working(job) {
        check();
        setTyping(true);
        try {
          return await job;
        } finally {
          if (live) setTyping(false);
        }
      },
      progress: (n) => live && setProgress(Math.max(0, Math.min(1, n))),
      mood: (m) => live && setMood(m),
    };
    setMsgs([]);
    setPrompt(null);
    setTyping(false);
    scriptRef.current(chat).catch((e) => {
      if (e instanceof Cancelled) return;
      if (live) push({ from: "bot", text: "Opa, algo deu errado aqui. Recarrega a página e tenta de novo?", error: true });
    });
    return () => {
      live = false;
      answer.current = null;
    };
  }, []);

  const reply = useCallback((r: Reply) => {
    haptic(8);
    answer.current?.(r);
  }, []);
  return { msgs, typing, prompt, progress, mood, reply };
}

/* ---------- a tela ---------- */

const INPUT: Record<InputKind, { type: string; mode?: "text" | "email" | "tel" | "numeric"; auto?: string; cap?: string }> = {
  text: { type: "text" },
  name: { type: "text", auto: "name", cap: "words" },
  email: { type: "email", mode: "email", auto: "email", cap: "none" },
  tel: { type: "tel", mode: "tel", auto: "tel" },
  password: { type: "password", auto: "new-password", cap: "none" },
  code: { type: "text", auto: "off", cap: "characters" },
  otp: { type: "text", mode: "numeric", auto: "one-time-code" },
};

function clean(kind: InputKind, v: string) {
  if (kind === "otp") return v.replace(/\D/g, "").slice(0, 6);
  if (kind === "code") return v.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 8);
  return v;
}

/** Caixa de escrever: fica montada entre uma pergunta e outra para o teclado do celular não fechar e abrir. */
function Composer({ p, waiting, onSend }: { p: Extract<Prompt, { kind: "input" }>; waiting: boolean; onSend: (v: string) => void }) {
  const [value, setValue] = useState(p.initial ?? "");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    setValue(p.initial ?? "");
    const el = ref.current;
    if (!el) return;
    // celular: só devolve o foco se o teclado já estava aberto (a pessoa acabou de mandar a resposta anterior)
    if (desk() || document.documentElement.classList.contains("pj-kb")) el.focus({ preventScroll: true });
  }, [p]);
  const spec = INPUT[p.input];
  const v = value.trim();
  const ok = !waiting && (p.input === "otp" ? v.length === 6 : v.length > 0);
  const send = () => {
    if (!ok) return;
    onSend(v);
    setValue("");
  };
  const props = {
    ref,
    className: `cad-input ${p.input}`,
    value,
    placeholder: p.placeholder,
    inputMode: spec.mode,
    autoComplete: spec.auto,
    autoCapitalize: spec.cap,
    autoCorrect: "off",
    spellCheck: false,
    enterKeyHint: "send" as const,
    "aria-label": p.placeholder,
    maxLength: p.input === "otp" ? 6 : p.input === "code" ? 8 : 120,
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => setValue(clean(p.input, e.target.value)),
  };
  return (
    <form
      className="cad-composer"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      {p.input === "password" ? <CampoSenha {...props} /> : <input {...props} type={spec.type} />}
      <button className="cad-send" aria-label="Enviar" disabled={!ok} onMouseDown={(e) => e.preventDefault()}>
        <Icon name="arrow-up" size={20} />
      </button>
    </form>
  );
}

/** Opções em botões: uma toca e já vai; várias marca e manda no "Pronto". */
function Picker({ p, onSend }: { p: Extract<Prompt, { kind: "pick" }>; onSend: (r: Reply) => void }) {
  const [on, setOn] = useState<string[]>(p.initial ?? []);
  useEffect(() => setOn(p.initial ?? []), [p]);
  const toggle = (id: string) => {
    haptic(6);
    setOn((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]));
  };
  return (
    <div className="cad-pick">
      <div className={`cad-options${p.many ? " many" : ""}`} role={p.many ? "group" : undefined}>
        {p.options.map((o, n) =>
          p.many ? (
            <button
              key={o.id}
              type="button"
              role="checkbox"
              aria-checked={on.includes(o.id)}
              className={on.includes(o.id) ? "cad-chip on" : "cad-chip"}
              style={{ ["--n" as string]: n } as CSSProperties}
              onClick={() => toggle(o.id)}
            >
              <i className="cad-check" aria-hidden="true">{on.includes(o.id) && <Icon name="check" size={12} />}</i>
              {o.label}
            </button>
          ) : (
            <button
              key={o.id}
              type="button"
              className={o.main ? "cad-chip main" : "cad-chip"}
              style={{ ["--n" as string]: n } as CSSProperties}
              onClick={() => onSend({ value: o.id, values: [o.id] })}
            >
              {o.label}
            </button>
          ),
        )}
      </div>
      {p.many && (
        <button type="button" className="cad-done" disabled={!on.length} onClick={() => onSend({ value: on.join(","), values: p.options.map((o) => o.id).filter((id) => on.includes(id)) })}>
          {p.done ?? "Pronto"}
          {on.length > 0 && <span className="cad-done-n">{on.length}</span>}
        </button>
      )}
    </div>
  );
}

export function ChatView({
  chat,
  left,
  right,
  sub,
  className = "",
}: {
  chat: ReturnType<typeof useChatScript>;
  left?: ReactNode;
  right?: ReactNode;
  /** linha embaixo do nome do Bolinho (quando não está digitando) */
  sub?: string;
  className?: string;
}) {
  const { msgs, typing, prompt, progress, mood, reply } = chat;
  const list = useRef<HTMLDivElement>(null);
  const dock = useRef<HTMLDivElement>(null);
  const [dockH, setDockH] = useState(96);

  // a última mensagem sempre à vista (e a folga de baixo acompanha a altura da caixa/botões)
  useLayoutEffect(() => {
    const el = dock.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDockH(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: calm() || msgs.length < 2 ? "auto" : "smooth" });
  }, [msgs.length, typing, prompt, dockH]);

  const last = msgs[msgs.length - 1];
  const face: Mood =
    mood ??
    (typing
      ? "thinking"
      : last?.error
        ? "error"
        : prompt?.kind === "input" && prompt.input === "password"
          ? "shy"
          : prompt?.kind === "input" && prompt.input === "otp"
            ? "searching"
            : prompt
              ? "curious"
              : "happy");
  const actions = prompt?.actions ?? [];
  // entre uma pergunta escrita e a próxima a caixa continua ali (o teclado do celular não fecha e abre de novo)
  const [held, setHeld] = useState<Extract<Prompt, { kind: "input" }> | null>(null);
  useEffect(() => {
    if (prompt?.kind === "input") setHeld(prompt);
    else if (prompt) setHeld(null);
  }, [prompt]);
  const input = prompt?.kind === "input" ? prompt : prompt ? null : held;

  return (
    <div className={`cad ${className}`} style={{ ["--cad-dock" as string]: `${dockH}px` } as CSSProperties}>
      <header className="cad-top">
        <div className="cad-side">{left}</div>
        <div className="cad-who">
          <span className="cad-who-face">
            <Mascote size={44} crop mood={face} />
          </span>
          <span className="cad-who-txt">
            <strong>{MASCOTE}</strong>
            <small aria-live="polite">{typing ? "digitando…" : (sub ?? "Planejai")}</small>
          </span>
        </div>
        <div className="cad-side end">{right}</div>
        <div className="cad-progress" aria-hidden="true">
          <span style={{ transform: `scaleX(${progress})` }} />
        </div>
      </header>

      <div className="cad-list" ref={list} role="log" aria-live="polite">
        <div className="cad-col">
          {msgs.map((m, i) => {
            const head = m.from === "bot" && msgs[i - 1]?.from !== "bot";
            const turn = i > 0 && msgs[i - 1]!.from !== m.from;
            if (m.from === "me")
              return (
                <div key={m.id} className={`cad-row me${turn ? " turn" : ""}`}>
                  <div className="cad-bubble">{m.text}</div>
                </div>
              );
            return (
              <div key={m.id} className={`cad-row bot${turn ? " turn" : ""}`}>
                <span className="cad-av">{head && <Mascote size={30} crop still mood="happy" />}</span>
                <div className="cad-body">
                  {m.text && <div className={m.error ? "cad-bubble err" : "cad-bubble"}>{m.text}</div>}
                  {m.node && <div className="cad-node">{m.node}</div>}
                </div>
              </div>
            );
          })}
          {typing && (
            <div className={`cad-row bot${last?.from !== "bot" ? " turn" : ""}`}>
              <span className="cad-av">{last?.from !== "bot" && <Mascote size={30} crop still mood="thinking" />}</span>
              <div className="cad-body">
                <div className="cad-bubble cad-typing" aria-label="digitando">
                  <i />
                  <i />
                  <i />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="cad-dock" ref={dock}>
        <div className="cad-col">
          {actions.length > 0 && (
            <div className="cad-actions">
              {actions.map((a) => (
                <button key={a.id} type="button" className="cad-action" onClick={() => reply({ value: "", values: [], action: a.id })}>
                  {a.label}
                </button>
              ))}
            </div>
          )}
          {prompt?.kind === "pick" && <Picker p={prompt} onSend={reply} />}
          {input && <Composer p={input} waiting={!prompt} onSend={(v) => reply({ value: v, values: [v] })} />}
        </div>
      </div>
    </div>
  );
}

/* ---------- perguntas de boas-vindas, iguais no cadastro e na primeira conversa ---------- */

export interface WelcomeQuestion {
  id: string;
  text: string;
  hint?: string;
  kind: "one" | "many" | "text";
  options?: { id: string; label: string }[];
  when?: { q: string; any: string[] };
}
export type WelcomeAnswers = Record<string, string | string[]>;

/** Mesma regra do servidor (`onboarding.ts`): a pergunta condicional só vale se a "mãe" teve uma das respostas. */
export function activeQuestions(questions: WelcomeQuestion[], answers: WelcomeAnswers) {
  return questions.filter((q) => {
    if (!q.when) return true;
    const a = answers[q.when.q];
    return (Array.isArray(a) ? a : a ? [a] : []).some((p) => q.when!.any.includes(p));
  });
}

/**
 * Faz as perguntas uma por uma, cada resposta já decide as próximas. Devolve as respostas (ou o que deu tempo
 * de responder, se a pessoa tocar em "Pular as perguntas").
 */
export async function askWelcome(c: Chat, questions: WelcomeQuestion[], start: WelcomeAnswers = {}, base = 0, span = 1) {
  const answers: WelcomeAnswers = { ...start };
  const done = new Set<string>();
  for (;;) {
    const list = activeQuestions(questions, answers);
    const q = list.find((x) => !done.has(x.id));
    if (!q) return answers;
    c.progress(base + span * (done.size / Math.max(list.length, 1)));
    done.add(q.id);
    await c.say(q.hint ? `${q.text} ${q.hint}` : q.text);
    const skip = { id: "skip", label: "Pular esta" };
    if (q.kind === "text") {
      const r = await c.ask({ kind: "input", input: "text", placeholder: "Escreva do seu jeito", initial: typeof start[q.id] === "string" ? (start[q.id] as string) : "", actions: [skip] });
      if (!r.action) answers[q.id] = r.value;
      continue;
    }
    const prev = start[q.id];
    const r = await c.ask({
      kind: "pick",
      many: q.kind === "many",
      options: q.options ?? [],
      initial: Array.isArray(prev) ? prev : prev ? [prev] : [],
      actions: [skip],
    });
    if (r.action) delete answers[q.id];
    else answers[q.id] = q.kind === "many" ? r.values : r.values[0]!;
  }
}

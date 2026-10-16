import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api } from "../api";
import { alarmsPossible, enableAlarmsHere } from "../Alarms";
import { useMedia } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";
import { Mascote, type Mood, type Outfit } from "../mascote/Mascote";
import { MASCOTE, MASCOTES } from "../mascote/nome";
import { useOutfit } from "../mascote/state";

/**
 * Primeira conversa com o mascote (pedido do David em 2026-10-16, no jeito do Kody): um mascote só no meio da
 * tela, balão de fala em cima explicando cada etapa e um botão grande escuro no pé com a resposta da pessoa.
 * Junta o tour do primeiro login (como o Planejai funciona) e as perguntas de boas-vindas (`/api/me/onboarding`).
 * Notebook: cartão alto no meio do painel desfocado; celular: tela cheia. Arrastar para o lado, setas e Esc funcionam.
 */

interface Question {
  id: string;
  text: string;
  hint?: string;
  kind: "one" | "many" | "text";
  options?: { id: string; label: string }[];
  when?: { q: string; any: string[] };
}
type Answers = Record<string, string | string[]>;
export interface Onboarding {
  questions: Question[];
  due: boolean;
  answers: Answers;
  summary: string;
  /** tour animado do painel ainda não visto por esta conta */
  tour?: boolean;
}

/** Mesma regra do servidor: a pergunta condicional só vale se a "mãe" teve uma das respostas. */
function active(questions: Question[], answers: Answers) {
  return questions.filter((q) => {
    if (!q.when) return true;
    const a = answers[q.when.q];
    return (Array.isArray(a) ? a : a ? [a] : []).some((p) => q.when!.any.includes(p));
  });
}

const d = (s: number) => ({ ["--d" as string]: `${s}s` }) as CSSProperties;

/* ---------- cenas que aparecem embaixo do mascote ---------- */

function Bubble({ me, at, children }: { me?: boolean; at: number; children: ReactNode }) {
  return (
    <span className={me ? "tour-bubble me" : "tour-bubble"} style={d(at)}>
      {children}
    </span>
  );
}

function ChatScene() {
  return (
    <div className="tour-chat">
      <Bubble me at={0.5}>gastei 42 no mercado</Bubble>
      <span className="tour-typing" style={d(1)} aria-hidden="true"><i /><i /><i /></span>
      <Bubble at={1.6}>Anotei <b>R$ 42,00</b> em Mercado</Bubble>
      <Bubble me at={2.3}>me lembra amanhã às 9h do dentista</Bubble>
      <Bubble at={3}>Combinado! Te aviso amanhã às 9h</Bubble>
    </div>
  );
}

const BARS = [38, 62, 46, 80, 54, 70];
function PanelScene() {
  return (
    <div className="tour-panel">
      <div className="tour-tile tour-cal" style={d(0.4)}>
        <span className="tour-tile-h"><Icon name="calendar" size={14} /> Agenda</span>
        <div className="tour-cal-grid" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <i key={i} className={i === 9 ? "today" : undefined} />
          ))}
        </div>
        <span className="tour-event" style={d(1.2)}>9:00 · Dentista</span>
      </div>
      <div className="tour-tile tour-money" style={d(0.6)}>
        <span className="tour-tile-h"><Icon name="wallet" size={14} /> Finanças</span>
        <div className="tour-bars" aria-hidden="true">
          {BARS.map((h, i) => (
            <i key={i} style={{ ...d(0.8 + i * 0.08), height: `${h}%` }} />
          ))}
        </div>
      </div>
      <div className="tour-tile tour-row" style={d(1.7)}>
        <span className="tour-row-ico"><Icon name="cart" size={15} /></span>
        <span className="tour-row-t">Mercado<small>agora há pouco</small></span>
        <b>R$ 42,00</b>
      </div>
    </div>
  );
}

const TEAM: { outfit: Outfit; label: string }[] = [
  { outfit: { eyes: "glasses", neck: "bowtie" }, label: "Finanças" },
  { outfit: { head: "headphones" }, label: "Agenda" },
  { outfit: { head: "cap", eyes: "sunglasses" }, label: "Pesquisa" },
  { outfit: { head: "beanie", neck: "scarf" }, label: "Recados" },
];
function TeamScene({ small }: { small: boolean }) {
  return (
    <div className="tour-team">
      <div className="tour-team-row">
        {TEAM.map((m, i) => (
          <span key={m.label} className="tour-team-one" style={d(0.45 + i * 0.16)}>
            <span className="tour-team-hop" style={d(1.4 + i * 0.3)}>
              <Mascote size={small ? 54 : 62} outfit={m.outfit} mood={i % 2 ? "happy" : "curious"} />
            </span>
            <small>{m.label}</small>
          </span>
        ))}
      </div>
      <span className="tour-link" style={d(1.2)} aria-hidden="true" />
      <span className="tour-note" style={d(2.2)}>“Conferi com a Agenda: dia 12 você já tem compromisso.”</span>
    </div>
  );
}

function YesScene() {
  return (
    <div className="tour-yes">
      <Bubble at={0.45}>
        Mando pra <b>Ana</b>: “chego às 19h”?
      </Bubble>
      <div className="tour-yes-btns" style={d(0.9)}>
        <span className="tour-yes-btn sim">Sim</span>
        <span className="tour-yes-btn">Não</span>
        <span className="tour-finger" style={d(1.4)} aria-hidden="true" />
      </div>
      <span className="tour-sent" style={d(2.2)}>
        <Icon name="check" size={14} /> Enviado para Ana
      </span>
    </div>
  );
}

const RAIL = ["home", "calendar", "wallet", "eye", "send", "users", "file"];
function WhereScene({ phone }: { phone: boolean }) {
  if (phone)
    return (
      <div className="tour-where phone">
        <div className="tour-mini-screen" aria-hidden="true">
          <i style={d(0.5)} /><i style={d(0.6)} /><i className="short" style={d(0.7)} />
        </div>
        <div className="tour-mini-bar" aria-hidden="true">
          {["home", "calendar", "wallet", "more"].map((n, i) => (
            <span key={n} style={d(1 + i * 0.35)}><Icon name={n} size={16} /></span>
          ))}
        </div>
      </div>
    );
  return (
    <div className="tour-where">
      <div className="tour-mini-rail" aria-hidden="true">
        <span className="tour-mini-brand" />
        {RAIL.map((n, i) => (
          <span key={n} className="tour-mini-ico" style={d(0.8 + i * 0.2)}><Icon name={n} size={15} /></span>
        ))}
        <span className="tour-mini-gap" />
        <span className="tour-mini-ico" style={d(0.8 + RAIL.length * 0.2)}><Icon name="bell" size={15} /></span>
        <span className="tour-mini-me" style={d(1 + RAIL.length * 0.2)} />
      </div>
      <div className="tour-mini-screen" aria-hidden="true">
        <i style={d(0.5)} /><i style={d(0.6)} /><i className="short" style={d(0.7)} />
      </div>
    </div>
  );
}

/* ---------- a conversa ---------- */

/** Fala do mascote: as palavras entram uma atrás da outra, como quem está falando. */
function Say({ text, hint }: { text: string; hint?: string }) {
  const words = text.split(" ");
  return (
    <div className="onb-say" aria-live="polite">
      <p id="onb-say">
        {words.map((w, n) => (
          <span key={n} style={{ ["--w" as string]: n } as CSSProperties}>
            {w}{n < words.length - 1 ? " " : ""}
          </span>
        ))}
      </p>
      {hint && <small style={{ ["--w" as string]: words.length } as CSSProperties}>{hint}</small>}
    </div>
  );
}

type Step =
  | { id: string; kind: "talk"; say: string; mood: Mood; reply: string; scene?: ReactNode; invite?: boolean; alarm?: boolean }
  | { id: string; kind: "ask"; q: Question };

export function OnboardingFlow({
  data,
  tour,
  name,
  onDone,
}: {
  /** perguntas de boas-vindas (null = só o tour) */
  data: Onboarding | null;
  /** mostrar como o Planejai funciona */
  tour: boolean;
  name?: string | null;
  onDone: (answered: boolean) => void;
}) {
  const phone = useMedia("(max-width: 599px)");
  const narrow = useMedia("(max-width: 767px)");
  const [outfit] = useOutfit();
  const [answers, setAnswers] = useState<Answers>(data?.answers ?? {});
  const [asking, setAsking] = useState(!!data);
  const [saved, setSaved] = useState(false);
  const [i, setI] = useState(0);
  const [dir, setDir] = useState<"next" | "prev">("next");
  const [react, setReact] = useState<Mood | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const hop = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ x: number; y: number; id: number; on: boolean } | null>(null);
  const dragged = useRef(false);
  const first = (name ?? "").trim().split(/\s+/)[0];
  const oi = first ? `, ${first}` : "";

  const steps = useMemo<Step[]>(() => {
    const list: Step[] = [];
    if (tour) {
      list.push(
        { id: "oi", kind: "talk", say: `Oi${oi}! Eu sou o ${MASCOTE}.`, mood: "greeting", reply: `Oi, ${MASCOTE}!` },
        {
          id: "chat",
          kind: "talk",
          say: "Eu moro no seu WhatsApp. Manda texto, áudio ou foto do jeito que mandaria pra um amigo.",
          mood: "happy",
          reply: "Que prático",
          scene: <ChatScene />,
        },
        { id: "painel", kind: "talk", say: "Tudo o que a gente combina aparece aqui no painel, arrumadinho.", mood: "curious", reply: "Gostei", scene: <PanelScene /> },
        {
          id: "time",
          kind: "talk",
          say: `Não trabalho sozinho: tenho um time de ${MASCOTES}, cada um cuidando de um assunto.`,
          mood: "wink",
          reply: "Que time!",
          scene: <TeamScene small={phone} />,
        },
        { id: "sim", kind: "talk", say: "Mandar mensagem, pagar ou apagar alguma coisa? Só depois do seu sim.", mood: "happy", reply: "Combinado", scene: <YesScene /> },
      );
    } else if (data) {
      list.push({ id: "oi", kind: "talk", say: `Oi de novo${oi}! Vamos atualizar o que eu sei de você?`, mood: "greeting", reply: "Vamos" });
    }
    if (data && asking) {
      if (tour) list.push({ id: "convite", kind: "talk", say: "Agora quero te conhecer. São umas perguntinhas rápidas. Topa?", mood: "curious", reply: "Vamos nessa!", invite: true });
      for (const q of active(data.questions, answers)) list.push({ id: `q-${q.id}`, kind: "ask", q });
    }
    if (tour)
      list.push({
        id: "onde",
        kind: "talk",
        say: narrow ? "As telas principais ficam na barra de baixo. O resto mora em Conta, no último botão." : "O menu fica aqui à esquerda. Avisos e a sua conta ficam no pé dele.",
        mood: "wink",
        reply: "Beleza",
        scene: <WhereScene phone={narrow} />,
      });
    // alarme: a confirmação fica aqui, no fim da primeira conversa, em vez de um botão em Minha conta
    if (tour && alarmsPossible())
      list.push({
        id: "alarme",
        kind: "talk",
        say: "Última coisa: quando você pedir um alarme (\"me acorda às 7h\"), posso tocar aqui no aparelho, como uma ligação?",
        mood: "curious",
        reply: "Pode tocar aqui",
        alarm: true,
      });
    list.push({
      id: "fim",
      kind: "talk",
      say: saved ? `Prontinho${oi}! Já sei por onde começar. Me chama no WhatsApp quando quiser.` : "É isso! Qualquer coisa, é só me chamar no WhatsApp.",
      mood: "laughing",
      reply: "Começar",
    });
    return list;
  }, [tour, data, asking, answers, saved, oi, phone, narrow]);

  const at = Math.min(i, steps.length - 1);
  const step = steps[at]!;
  const lastAsk = steps.findLastIndex((s) => s.kind === "ask");
  const q = step.kind === "ask" ? step.q : null;
  const value = q ? answers[q.id] : undefined;
  const picked = Array.isArray(value) ? value : value ? [value] : [];
  const answered = q ? (q.kind === "text" ? typeof value === "string" && !!value.trim() : picked.length > 0) : true;

  const mood: Mood = busy ? "working" : error ? "error" : (react ?? (step.kind === "ask" ? (q!.kind === "text" ? "curious" : "thinking") : step.mood));
  const look = Object.keys(outfit).length ? outfit : at === 0 || step.id === "fim" ? { head: "party" } : {};

  // a cada etapa o mascote dá um pulinho (Web Animations, sem remontar o desenho)
  useEffect(() => {
    setReact(null);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    hop.current?.animate(
      [
        { transform: "translateY(0) scale(1)" },
        { transform: "translateY(2px) scale(1.06, .92)", offset: 0.15 },
        { transform: "translateY(-16px) scale(.96, 1.05)", offset: 0.45 },
        { transform: "translateY(0) scale(1.04, .95)", offset: 0.75 },
        { transform: "translateY(0) scale(1)" },
      ],
      { duration: 560, easing: "ease-out" },
    );
  }, [step.id]);
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);

  const save = async (skip: boolean, final = answers) => {
    if (!data) return true;
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/onboarding", { method: "PUT", json: skip && !Object.keys(final).length ? { skip: true } : { answers: final } });
      setBusy(false);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não deu para salvar agora");
      setBusy(false);
      return false;
    }
  };

  const close = async () => {
    if (leaving || busy) return;
    // pular no meio das perguntas guarda o que já respondeu (ou marca como pulado)
    if (data && asking && !saved && !(await save(true))) return;
    setLeaving(true);
    if (tour) void api("/api/me/tour", { method: "PUT" }).catch(() => {});
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(() => onDone(!!data && asking), calm ? 0 : 260);
  };

  const go = async (to: number, a = answers) => {
    if (busy || leaving || to < 0 || to === at) return;
    if (to >= steps.length) return close();
    // "Pode tocar aqui": pede a permissão dentro do próprio toque; negar não trava a conversa
    if (to > at && step.kind === "talk" && step.alarm) {
      setBusy(true);
      await enableAlarmsHere().catch(() => false);
      setBusy(false);
    }
    // saindo da última pergunta: grava as respostas antes de seguir
    if (to > at && at === lastAsk) {
      if (!(await save(false, a))) return;
      setSaved(true);
    }
    haptic();
    setError(null);
    setDir(to > at ? "next" : "prev");
    setI(to);
  };

  const goRef = useRef(go);
  goRef.current = go;

  const notNow = async () => {
    if (!(await save(true, {}))) return;
    haptic();
    setDir("next");
    setAsking(false); // as perguntas saem da lista: o índice atual passa a ser a etapa seguinte
  };

  const choose = (id: string) => {
    if (!q || busy) return;
    haptic();
    setReact(Math.random() < 0.5 ? "happy" : "wink");
    if (q.kind === "one") {
      const a = { ...answers, [q.id]: id };
      setAnswers(a);
      const from = at;
      // a lista pode mudar com a resposta (abre ou fecha perguntas filhas): segue pela versão nova dela
      setTimeout(() => void goRef.current(from + 1, a), 380);
      return;
    }
    const set = new Set(picked);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    setAnswers({ ...answers, [q.id]: [...set] });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return void close();
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      if (e.key === "ArrowRight") void goRef.current(at + 1);
      else if (e.key === "ArrowLeft") void goRef.current(at - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // arrastar para o lado: o palco segue o dedo; soltou longe, troca de etapa; perto, volta com mola
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, on: false };
    dragged.current = false;
  };
  const onMove = (e: React.PointerEvent) => {
    const s = drag.current;
    const el = stage.current;
    if (!s || !el || s.id !== e.pointerId) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!s.on) {
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.3) return;
      if ((e.target as HTMLElement)?.tagName === "TEXTAREA") return void (drag.current = null);
      s.on = true;
      dragged.current = true;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    }
    // nas pontas (primeira etapa para trás) o arraste pesa mais, como borracha
    const edge = (dx > 0 && at === 0) || busy;
    const x = edge ? dx * 0.18 : dx * 0.55;
    el.style.transition = "none";
    el.style.transform = `translateX(${x}px) rotate(${x * 0.012}deg)`;
    el.style.opacity = String(1 - Math.min(0.45, Math.abs(x) / 600));
  };
  const onUp = (e: React.PointerEvent) => {
    const s = drag.current;
    drag.current = null;
    const el = stage.current;
    if (!s?.on || !el) return;
    const dx = e.clientX - s.x;
    el.style.transition = "transform .42s var(--spring), opacity .3s ease-out";
    el.style.transform = "";
    el.style.opacity = "";
    if (dx < -70) void go(at + 1);
    else if (dx > 70) void go(at - 1);
  };
  const onCancel = () => {
    drag.current = null;
    const el = stage.current;
    if (!el) return;
    el.style.transition = "transform .42s var(--spring), opacity .3s ease-out";
    el.style.transform = "";
    el.style.opacity = "";
  };

  const sayText = q ? q.text : step.kind === "talk" ? step.say : "";
  const goLabel = busy ? "Salvando…" : q ? (answered ? "Continuar" : "Pular esta") : step.kind === "talk" ? step.reply : "Continuar";
  const progress = (at + 1) / steps.length;

  return (
    <div
      ref={root}
      tabIndex={-1}
      className={leaving ? "onb out" : "onb"}
      role="dialog"
      aria-modal="true"
      aria-labelledby="onb-say"
      onClickCapture={(e) => {
        // um arraste não vira toque no botão em que o dedo soltou
        if (dragged.current) {
          e.stopPropagation();
          e.preventDefault();
          dragged.current = false;
        }
      }}
    >
      <div className="onb-card" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onCancel}>
        <div className="onb-top">
          <button className="onb-icon" onClick={() => void go(at - 1)} disabled={at === 0 || busy} aria-label="Voltar">
            <Icon name="chevron-left" size={22} />
          </button>
          <div className="onb-progress" aria-hidden="true">
            <span style={{ transform: `scaleX(${progress})` }} />
          </div>
          <button className="onb-skip" onClick={() => void close()} disabled={busy}>
            Pular
          </button>
        </div>

        <div ref={stage} className="onb-stage">
          <div className={`onb-talk ${q ? "asking" : ""} ${step.kind === "talk" && step.scene ? "with-scene" : ""}`}>
            <div className={`onb-say-wrap ${dir}`} key={`say-${step.id}`}>
              <Say text={error ?? sayText} hint={error ? undefined : q?.hint} />
            </div>
            <span ref={hop} className="onb-mascote">
              <Mascote size={q ? (phone ? 92 : 104) : step.kind === "talk" && step.scene ? (phone ? 100 : 112) : phone ? 150 : 168} outfit={look} mood={mood} />
            </span>
          </div>

          <div className={`onb-below ${dir}`} key={`below-${step.id}`}>
            {step.kind === "talk" && step.scene && <div className="onb-scene">{step.scene}</div>}
            {q && q.kind === "text" && (
              <textarea
                className="textarea onb-text"
                autoFocus={!phone}
                rows={3}
                maxLength={300}
                placeholder="Escreva do seu jeito"
                value={typeof value === "string" ? value : ""}
                onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
              />
            )}
            {q && q.kind !== "text" && (
              <div className={`onb-options n${q.options!.length}`} role={q.kind === "one" ? "radiogroup" : "group"} aria-labelledby="onb-say">
                {q.options!.map((o, n) => (
                  <button
                    key={o.id}
                    role={q.kind === "one" ? "radio" : "checkbox"}
                    aria-checked={picked.includes(o.id)}
                    className={picked.includes(o.id) ? "onb-option on" : "onb-option"}
                    style={{ ["--n" as string]: n } as CSSProperties}
                    onClick={() => choose(o.id)}
                    disabled={busy}
                  >
                    <span>{o.label}</span>
                    {q.kind === "many" && <i className="onb-check" aria-hidden="true">{picked.includes(o.id) && <Icon name="check" size={13} />}</i>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="onb-foot">
          <button className="onb-go" onClick={() => void go(at + 1)} disabled={busy}>
            {goLabel}
          </button>
          {step.kind === "talk" && step.alarm && (
            <button className="onb-later" onClick={() => { haptic(); setDir("next"); setI(at + 1); }} disabled={busy}>
              Agora não
            </button>
          )}
          {step.kind === "talk" && step.invite && (
            <button className="onb-later" onClick={() => void notNow()} disabled={busy}>
              Agora não
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

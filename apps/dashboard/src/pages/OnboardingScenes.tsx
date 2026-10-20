import { useEffect, useState, type CSSProperties } from "react";
import { brl } from "../api";
import { Icon } from "../icons";
import { Glyph } from "./LandingApps";
import "../styles/onboarding-cenas.css";

/**
 * Cenas maiores da primeira conversa (pedido do David em 2026-10-20: "mostre o calendário de finanças, as conexões,
 * com motion"): o calendário de gastos de Finanças se enchendo, os apps ligando um por um e, no fim das perguntas,
 * o painel montado com o que a pessoa respondeu. Só enfeite com dados de exemplo; nada aqui grava nada.
 */

const d = (s: number) => ({ ["--d" as string]: `${s}s` }) as CSSProperties;
const calm = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Número que sobe do zero até o valor (em centavos, para não somar de cabeça), depois de `delay` ms. */
function useCount(cents: number, delay: number, ms = 900) {
  const [v, setV] = useState(() => (calm() ? cents : 0));
  useEffect(() => {
    if (calm()) return setV(cents);
    let raf = 0;
    const t = setTimeout(() => {
      const start = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - start) / ms);
        const e = 1 - (1 - p) ** 3;
        setV(Math.round(cents * e));
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }, delay);
    return () => (clearTimeout(t), cancelAnimationFrame(raf));
  }, [cents, delay, ms]);
  return v / 100;
}

/* ---------- Finanças: o calendário de gastos do mês ---------- */

/** Nível de gasto de cada dia do exemplo (0 = nada, 1 pouco ... 4 muito). Dias depois de hoje ficam vazios. */
const LEVELS = [2, 1, 0, 3, 1, 2, 0, 1, 4, 2, 1, 0, 2, 1, 1, 3, 0, 2, 1, 2];
const TODAY = 20;
const TAP = 9;
const WD = ["S", "T", "Q", "Q", "S", "S", "D"];

export function FinanceScene() {
  const inc = useCount(520000, 350);
  const out = useCount(231840, 500);
  const bal = useCount(288160, 650);
  return (
    <div className="ob-fin">
      <div className="ob-fin-sum" style={d(0.25)}>
        <div><small><i className="in" />Entradas</small><strong>{brl(inc)}</strong></div>
        <div><small><i className="out" />Saídas</small><strong>{brl(out)}</strong></div>
        <div><small><i className="bal" />Saldo</small><strong>{brl(bal)}</strong></div>
      </div>
      <div className="ob-fin-grid" aria-hidden="true">
        {WD.map((w, i) => <span key={i} className="ob-fin-wd">{w}</span>)}
        {Array.from({ length: 28 }, (_, i) => {
          const day = i + 1;
          const lv = day <= LEVELS.length ? LEVELS[day - 1]! : 0;
          const cls = `ob-day l${lv}${day === TODAY ? " today" : ""}${day > TODAY ? " future" : ""}${day === TAP ? " tap" : ""}`;
          return (
            <span key={day} className={cls} style={d(0.55 + i * 0.035)}>
              {day}
              {day === TAP && <i className="ob-fin-finger" style={d(2.1)} />}
            </span>
          );
        })}
      </div>
      <span className="ob-fin-pop" style={d(2.5)}>
        <b>Dia 9</b> Aluguel <em>{brl(1450)}</em>
      </span>
    </div>
  );
}

/* ---------- Conexões: os apps ligando um por um ---------- */

const APPS = [
  { id: "agenda", name: "Google Agenda", what: "seus compromissos" },
  { id: "gmail", name: "Gmail", what: "e-mails importantes" },
  { id: "notion", name: "Notion", what: "notas e páginas" },
  { id: "mpago", name: "Mercado Pago", what: "o que entrou e saiu" },
  { id: "slack", name: "Slack", what: "recados do trabalho" },
  { id: "github", name: "GitHub", what: "tarefas e PRs" },
];

export function ConnectScene({ small }: { small: boolean }) {
  const list = small ? APPS.slice(0, 4) : APPS;
  return (
    <div className="ob-con">
      {list.map((a, i) => (
        <span key={a.id} className="ob-con-app" style={d(0.4 + i * 0.12)}>
          <span className="ob-con-ico"><Glyph id={a.id} /></span>
          <span className="ob-con-t">
            {a.name}
            <small>{a.what}</small>
          </span>
          <span className="ob-con-sw" style={d(1.2 + i * 0.28)} aria-hidden="true"><i /></span>
        </span>
      ))}
    </div>
  );
}

/* ---------- O painel montado com as respostas ---------- */

type Answers = Record<string, string | string[]>;
const pick = (a: Answers, id: string) => {
  const v = a[id];
  return Array.isArray(v) ? v : v ? [v] : [];
};

const HABIT: Record<string, string> = { exercise: "Exercício", water: "Beber água", reading: "Leitura", sleep: "Dormir mais cedo", meditate: "Meditar" };
const MONEY_GOAL: Record<string, string> = { reserve: "ter uma reserva", trip: "juntar pra algo", invest: "começar a investir", control: "saber pra onde vai" };
const FORGET: Record<string, string> = { bills: "contas", meetings: "compromissos", birthdays: "aniversários", meds: "remédios", tasks: "tarefas do dia" };
const TONE: Record<string, string> = { short: "direto e curto", detail: "com explicação", fun: "descontraído" };

interface Card {
  id: string;
  icon: string;
  title: string;
  text: string;
  art?: "bars" | "dots" | "ring";
}

/** O que entra no painel de quem respondeu: no máximo quatro cartões, na ordem do que a pessoa escolheu. */
export function personalCards(a: Answers): Card[] {
  const goals = pick(a, "goal");
  const out: Card[] = [];
  if (goals.includes("money")) {
    const goal = pick(a, "money_goal")[0] ?? "";
    const g = MONEY_GOAL[goal];
    const debt = goal === "debt";
    out.push({
      id: "money",
      icon: "wallet",
      title: "Finanças",
      text: debt ? "Calendário de gastos e um plano pra sair das dívidas" : g ? `Calendário de gastos e a meta: ${g}` : "Calendário de gastos e limite do mês",
      art: "bars",
    });
  }
  if (goals.includes("agenda") || pick(a, "forget").length) {
    const f = pick(a, "forget").map((x) => FORGET[x]).filter(Boolean);
    out.push({ id: "agenda", icon: "calendar", title: "Agenda", text: f.length ? `Lembretes de ${f.slice(0, 2).join(" e ")}` : "Compromissos e lembretes no WhatsApp", art: "dots" });
  }
  if (goals.includes("habits")) {
    const h = pick(a, "habit").map((x) => HABIT[x]).filter(Boolean);
    out.push({ id: "habits", icon: "repeat", title: "Hábitos", text: h.length ? `${h.slice(0, 2).join(" e ")}, um dia de cada vez` : "Rotina com lembrete na hora certa", art: "ring" });
  }
  if (goals.includes("work")) {
    out.push({ id: "work", icon: "briefcase", title: "Trabalho", text: "Tarefas, reuniões e recados do trabalho" });
  }
  if (goals.includes("study")) out.push({ id: "study", icon: "book", title: "Estudos", text: "Resumos, mapas mentais e revisão" });
  const tone = TONE[pick(a, "tone")[0] ?? ""];
  if (tone) out.push({ id: "tone", icon: "sparkle", title: "Do seu jeito", text: `Vou falar ${tone} com você` });
  return out.slice(0, 4);
}

export function PersonalScene({ answers }: { answers: Answers }) {
  const cards = personalCards(answers);
  if (!cards.length) return null;
  return (
    <div className="ob-me">
      {cards.map((c, i) => (
        <span key={c.id} className="ob-me-card" style={d(0.45 + i * 0.22)}>
          <span className="ob-me-ico"><Icon name={c.icon} size={17} /></span>
          <span className="ob-me-t">
            {c.title}
            <small>{c.text}</small>
          </span>
          {c.art === "bars" && <span className="ob-me-art bars" aria-hidden="true">{[40, 70, 52, 90].map((h, n) => <i key={n} style={{ height: `${h}%`, ...d(0.8 + i * 0.22 + n * 0.07) }} />)}</span>}
          {c.art === "dots" && <span className="ob-me-art dots" aria-hidden="true">{[0, 1, 2, 3, 4, 5].map((n) => <i key={n} className={n === 3 ? "on" : ""} style={d(0.8 + i * 0.22 + n * 0.05)} />)}</span>}
          {c.art === "ring" && (
            <svg className="ob-me-art ring" viewBox="0 0 36 36" aria-hidden="true">
              <circle cx="18" cy="18" r="14" />
              <circle cx="18" cy="18" r="14" className="fill" style={d(0.9 + i * 0.22)} />
            </svg>
          )}
          <span className="ob-me-check" style={d(1 + i * 0.22)} aria-hidden="true"><Icon name="check" size={12} /></span>
        </span>
      ))}
    </div>
  );
}

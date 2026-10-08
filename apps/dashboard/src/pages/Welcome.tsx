import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { haptic } from "../touch";
import { FloatingMochis, StageMochi, lookAt } from "../mochi/Parade";

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
}

/** Mesma regra do servidor: a pergunta condicional só vale se a "mãe" teve uma das respostas. */
function active(questions: Question[], answers: Answers) {
  return questions.filter((q) => {
    if (!q.when) return true;
    const a = answers[q.when.q];
    return (Array.isArray(a) ? a : a ? [a] : []).some((p) => q.when!.any.includes(p));
  });
}

/** Perguntas de boas-vindas: uma por tela, cada resposta pode abrir outras. O Mochi guarda o resumo para a conversa no WhatsApp. */
export function Welcome({ data, name, onDone }: { data: Onboarding; name?: string | null; onDone: () => void }) {
  const [answers, setAnswers] = useState<Answers>(data.answers ?? {});
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useMemo(() => active(data.questions, answers), [data.questions, answers]);
  const q = list[Math.min(step, list.length - 1)];
  const value = answers[q.id];
  const picked = Array.isArray(value) ? value : value ? [value] : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && finish(true);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const finish = async (skip = false, final = answers) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/me/onboarding", { method: "PUT", json: skip && !Object.keys(final).length ? { skip: true } : { answers: final } });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não deu para salvar agora");
      setBusy(false);
    }
  };

  const next = (a = answers) => {
    const after = active(data.questions, a);
    const at = after.findIndex((x) => x.id === q.id);
    if (at + 1 >= after.length) return finish(false, a);
    setStep(at + 1);
  };

  const choose = (id: string) => {
    haptic();
    if (q.kind === "one") {
      const a = { ...answers, [q.id]: id };
      setAnswers(a);
      setTimeout(() => next(a), 160);
      return;
    }
    const set = new Set(picked);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    setAnswers({ ...answers, [q.id]: [...set] });
  };

  const first = (name ?? "").trim().split(/\s+/)[0];
  return (
    <div className="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-q">
      <FloatingMochis className="welcome-float" />
      <div className="welcome-top">
        <div className="welcome-progress" aria-hidden="true">
          <span style={{ width: `${((step + 1) / list.length) * 100}%` }} />
        </div>
        <button className="link-btn" onClick={() => finish(true)} disabled={busy}>
          Pular
        </button>
      </div>
      <div className="welcome-body" key={q.id}>
        <div className="welcome-stage">
          <StageMochi step={q.id} look={lookAt(step)} mood={busy ? "working" : error ? "error" : undefined} size={step === 0 ? 92 : 76} />
          {step === 0 && (
            <p className="muted welcome-hello">{first ? `Oi, ${first}! ` : "Oi! "}Umas perguntas rápidas pra eu já te conhecer quando a gente conversar no WhatsApp.</p>
          )}
        </div>
        <h1 id="welcome-q">{q.text}</h1>
        {q.hint && <p className="muted welcome-hint">{q.hint}</p>}
        {q.kind === "text" ? (
          <textarea
            className="textarea welcome-text"
            rows={4}
            maxLength={300}
            autoFocus
            placeholder="Escreva do seu jeito"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
          />
        ) : (
          <div className="welcome-options" role={q.kind === "one" ? "radiogroup" : "group"} aria-labelledby="welcome-q">
            {q.options!.map((o) => (
              <button
                key={o.id}
                role={q.kind === "one" ? "radio" : "checkbox"}
                aria-checked={picked.includes(o.id)}
                className={picked.includes(o.id) ? "welcome-option on" : "welcome-option"}
                onClick={() => choose(o.id)}
                disabled={busy}
              >
                {o.label}
              </button>
            ))}
          </div>
        )}
        {error && <p className="welcome-error">{error}</p>}
      </div>
      <div className="welcome-actions">
        {step > 0 ? (
          <button className="btn" onClick={() => setStep(step - 1)} disabled={busy}>
            Voltar
          </button>
        ) : (
          <span />
        )}
        {q.kind !== "one" && (
          <button className="btn btn-brand" onClick={() => next()} disabled={busy}>
            {list.indexOf(q) === list.length - 1 ? (busy ? "Salvando…" : "Concluir") : picked.length || value ? "Continuar" : "Pular esta"}
          </button>
        )}
      </div>
    </div>
  );
}

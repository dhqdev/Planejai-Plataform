import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { useMedia } from "../hooks";
import { MASCOTE } from "../mascote/nome";
import { ChatView, askWelcome, useChatScript, type Chat, type WelcomeAnswers, type WelcomeQuestion } from "./ChatCadastro";
import { ConnectScene, FinanceScene, PersonalScene, personalCards } from "./OnboardingScenes";

/**
 * Primeira conversa com o Bolinho depois do login, em forma de chat (David, 2026-11-11: o cadastro virou conversa).
 * Quem se cadastra pelo chat já responde tudo lá e não vê esta tela. Ela fica para quem entra sem ter passado pelo
 * cadastro (login criado pelo dono, convite antigo), para `?tour=1`/`pj:tour` (só o "como funciona") e para
 * `pj:welcome` em Minha conta (só as perguntas). Notebook: cartão por cima do painel desfocado; celular: tela cheia.
 */

export interface Onboarding {
  questions: WelcomeQuestion[];
  due: boolean;
  answers: WelcomeAnswers;
  summary: string;
  /** tour do painel ainda não visto por esta conta */
  tour?: boolean;
}

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
  const [leaving, setLeaving] = useState(false);
  const state = useRef({ answers: (data?.answers ?? {}) as WelcomeAnswers, saved: !data, answered: false, closing: false });
  const first = (name ?? "").trim().split(/\s+/)[0];
  const oi = first ? `, ${first}` : "";

  const save = async (answers: WelcomeAnswers) => {
    const s = state.current;
    if (!data || s.saved) return;
    s.saved = true;
    await api("/api/me/onboarding", { method: "PUT", json: Object.keys(answers).length ? { answers } : { skip: true } }).catch(() => {
      s.saved = false;
    });
  };

  const close = async () => {
    const s = state.current;
    if (s.closing) return;
    s.closing = true;
    // sair no meio guarda o que já respondeu (ou marca como pulado), como antes
    await save(s.answers);
    if (tour) {
      void api("/api/me/tour", { method: "PUT" }).catch(() => {});
      // fim da primeira conversa: oi no WhatsApp da pessoa (o servidor manda uma vez só, e só para conta nova)
      void api("/api/me/welcome", { method: "POST" }).catch(() => {});
    }
    setLeaving(true);
    const calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
    setTimeout(() => onDone(!!data && s.answered), calm ? 0 : 260);
  };
  const closeRef = useRef(close);
  closeRef.current = close;

  const chat = useChatScript(async (c: Chat) => {
    const s = state.current;
    const next = (label: string) => c.ask({ kind: "pick", options: [{ id: "ok", label, main: true }] });
    let steps = (tour ? 5 : 1) + (data ? 4 : 0);
    let at = 0;
    const tick = () => c.progress(++at / steps);

    if (tour) {
      await c.say(`Oi${oi}! Eu sou o ${MASCOTE} 👋`);
      await c.say("Eu moro no seu WhatsApp. Manda texto, áudio ou foto do jeito que mandaria pra um amigo, que eu resolvo.");
      tick();
      await next("Que prático");
      await c.say("Cada gasto vira um quadradinho no seu calendário de Finanças. A cor mostra quando o dia pesou.", { node: <FinanceScene /> });
      tick();
      await next("Gostei");
      await c.say("Também converso com os apps que você já usa. É só ligar em Conexões, na sua conta.", { node: <ConnectScene small={phone} /> });
      tick();
      await next("Show");
      await c.say("E uma regra minha: mandar mensagem pra alguém, pagar ou apagar alguma coisa só sai depois do seu sim.");
      tick();
      await next("Combinado");
    } else if (data) {
      await c.say(`Oi de novo${oi}! Vamos atualizar o que eu sei de você?`);
      tick();
    }

    if (data) {
      let go = true;
      if (tour) {
        await c.say("Agora quero te conhecer. São umas perguntinhas rápidas. Topa?");
        const r = await c.ask({
          kind: "pick",
          options: [
            { id: "yes", label: "Vamos nessa!", main: true },
            { id: "no", label: "Agora não" },
          ],
        });
        go = r.value === "yes";
      }
      if (go) {
        steps = at + 4;
        s.answers = await askWelcome(c, data.questions, data.answers, at / steps, (steps - at - 1) / steps);
        s.answered = true;
      } else s.answers = {};
      await c.working(save(s.answers));
    }

    c.progress(1);
    const cards = data && s.answered && personalCards(s.answers).length > 0;
    if (tour) {
      if (cards) await c.say(`Prontinho${oi}! Montei o seu Planejai com o que você me contou:`, { node: <PersonalScene answers={s.answers} /> });
      else await c.say(`Prontinho${oi}!`);
      await c.say("Te mandei um oi no WhatsApp. É só responder por lá 💬");
    } else if (cards) await c.say(`Prontinho${oi}! Já atualizei o que eu sei de você:`, { node: <PersonalScene answers={s.answers} /> });
    else await c.say(`Prontinho${oi}! Já atualizei o que eu sei de você.`);
    await next("Começar");
    await closeRef.current();
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className={leaving ? "cadf out" : "cadf"} role="dialog" aria-modal="true" aria-label={`Conversa com o ${MASCOTE}`}>
      <ChatView
        chat={chat}
        sub={tour ? "primeira conversa" : "suas preferências"}
        right={
          <button type="button" className="cad-link" onClick={() => void close()}>
            Pular
          </button>
        }
      />
    </div>
  );
}

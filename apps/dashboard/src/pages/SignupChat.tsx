import { Suspense, lazy, useState } from "react";
import { api, phoneFmt } from "../api";
import type { Me } from "../App";
import { Modal } from "../components";
import { Icon } from "../icons";
import { isStandalone } from "../touch";
import { MASCOTE } from "../mascote/nome";
import { ChatView, askWelcome, telFmt, useChatScript, type Chat, type WelcomeAnswers, type WelcomeQuestion } from "./ChatCadastro";
import { PersonalScene, personalCards } from "./OnboardingScenes";

/**
 * Cadastro como conversa com o Bolinho (David, 2026-11-11). Mesmas regras de antes, só que perguntadas uma de cada
 * vez: convite (quando o cadastro é só por convite), nome e sobrenome, WhatsApp com DDD (vem do convite quando ele
 * tem número), e-mail, senha, aceite dos termos e o código que chega no WhatsApp. Com a conta criada, a conversa
 * segue com as perguntas de boas-vindas e o resumo do que foi montado; aí abre o painel, já sem o tour antigo.
 */

interface Invite {
  name: string | null;
  email: string | null;
  phone: string | null;
  inviter: string | null;
  used: boolean;
}
interface Welcome {
  questions: WelcomeQuestion[];
  due: boolean;
  answers: WelcomeAnswers;
}

const PrivacyPage = lazy(() => import("./Privacy").then((m) => ({ default: m.PrivacyPage })));

/** Rascunho na aba (sem a senha): recarregar a página não apaga o que já foi respondido. */
const DRAFT = "planejai.cadastro";
type Draft = { name?: string; email?: string; phone?: string };
const readDraft = (): Draft => {
  try {
    return JSON.parse(sessionStorage.getItem(DRAFT) ?? "{}") as Draft;
  } catch {
    return {};
  }
};
const writeDraft = (d: Draft) => {
  try {
    sessionStorage.setItem(DRAFT, JSON.stringify(d));
  } catch {
    /* aba privada sem armazenamento */
  }
};
const clearDraft = () => {
  try {
    sessionStorage.removeItem(DRAFT);
  } catch {
    /* sem armazenamento */
  }
};

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const first = (name: string) => name.trim().split(/\s+/)[0] ?? "";
const localPhone = telFmt;

type Step = "code" | "name" | "phone" | "email" | "password" | "terms" | "send" | "otp";
const ORDER: Step[] = ["code", "name", "phone", "email", "password", "terms", "otp"];

/** Para onde voltar quando o servidor recusa: a pergunta do campo que ele apontou. */
function stepFor(error: string): Step | null {
  if (/convite/i.test(error)) return "code";
  if (/e-?mail/i.test(error)) return "email";
  if (/whats|ddd|n[úu]mero/i.test(error)) return "phone";
  if (/senha/i.test(error)) return "password";
  if (/nome/i.test(error)) return "name";
  if (/termos/i.test(error)) return "terms";
  return null;
}

export function SignupChat({ initialCode, onLogin, onEnter }: { initialCode: string | null; onLogin: (me: Me) => void; onEnter: () => void }) {
  const [terms, setTerms] = useState<((ok: boolean) => void) | null>(null);
  const readTerms = () => new Promise<boolean>((resolve) => setTerms(() => resolve));

  const chat = useChatScript(async (c: Chat) => {
    const draft = readDraft();
    const form = { name: draft.name ?? "", email: draft.email ?? "", phone: draft.phone ?? "", password: "" };
    let code = initialCode;
    let invite: Invite | null = null;

    const config = await c.working(api<{ signupMode: string }>("/api/auth/config").catch(() => ({ signupMode: "invite" })));
    if (config.signupMode === "closed") {
      await c.say("Oi! Os cadastros estão fechados agora. Se você já tem conta, é só entrar.");
      await c.ask({ kind: "pick", options: [{ id: "enter", label: "Entrar", main: true }] });
      return onEnter();
    }
    if (code) {
      try {
        invite = await c.working(api<Invite>(`/api/invite/${code}`));
        if (invite.used) {
          await c.say("Esse convite já foi usado para criar uma conta. Se ela é sua, é só entrar.");
          await c.ask({ kind: "pick", options: [{ id: "enter", label: "Entrar", main: true }] });
          return onEnter();
        }
        form.name ||= invite.name ?? "";
        form.email ||= invite.email ?? "";
      } catch (e) {
        invite = null;
        code = null;
        await c.say((e as Error).message, { error: true });
      }
    }

    await c.say(`Oi! Eu sou o ${MASCOTE}, do Planejai 👋`);
    if (invite?.inviter) await c.say(`${invite.inviter} te convidou. Que bom ter você por aqui!`);
    await c.say("Vou fazer o seu cadastro por aqui mesmo, rapidinho. É só ir me respondendo.");

    const needsCode = config.signupMode === "invite";
    const steps = ORDER.filter((s) => (s === "code" ? needsCode && !code : true));
    let step: Step = needsCode && !code ? "code" : "name";
    let challenge: { id: string; to: string } | null = null;
    let me: Me | null = null;
    const save = () => writeDraft({ name: form.name, email: form.email, phone: invite?.phone ? "" : form.phone });

    while (!me) {
      c.progress(Math.max(0, steps.indexOf(step === "send" ? "terms" : step)) / steps.length * 0.7);
      c.mood(null);
      if (step === "code") {
        await c.say("Pra começar, me passa o código do seu convite. São 6 letras e números.");
        for (;;) {
          const r = await c.ask({ kind: "input", input: "code", placeholder: "Código do convite", actions: [{ id: "enter", label: "Já tenho conta" }] });
          if (r.action) return onEnter();
          if (r.value.length < 6) {
            await c.say("Hmm, o código tem 6 letras e números. Confere de novo?", { error: true });
            continue;
          }
          try {
            invite = await c.working(api<Invite>(`/api/invite/${r.value}`));
            if (invite.used) {
              await c.say("Esse convite já foi usado. Peça um novo a quem te convidou, ou entre se a conta é sua.", { error: true });
              continue;
            }
            code = r.value;
            history.replaceState(null, "", `/convite/${code}`);
            form.name ||= invite.name ?? "";
            form.email ||= invite.email ?? "";
            c.mood("surprised");
            await c.say(invite.inviter ? `Achei! Convite de ${invite.inviter} 🎉` : "Achei seu convite! 🎉", { quick: true });
            break;
          } catch (e) {
            await c.say((e as Error).message, { error: true });
          }
        }
        step = "name";
        continue;
      }
      if (step === "name") {
        await c.say(invite?.name ? `Seu nome é ${invite.name}? Se quiser, ajusta aqui.` : "Como você se chama? Nome e sobrenome, por favor.");
        for (;;) {
          const r = await c.ask({ kind: "input", input: "name", placeholder: "Nome e sobrenome", initial: form.name });
          const name = r.value.replace(/\s+/g, " ").trim();
          if (name.split(" ").length < 2) {
            await c.say("Me fala o sobrenome também? É assim que vai aparecer na sua conta.", { error: true });
            continue;
          }
          form.name = name;
          break;
        }
        save();
        step = invite?.phone ? "email" : "phone";
        if (invite?.phone) {
          form.phone = invite.phone;
          await c.say(`Prazer, ${first(form.name)}! Vou falar com você no WhatsApp ${localPhone(invite.phone)}, o número que veio no convite.`);
        }
        continue;
      }
      if (step === "phone") {
        await c.say(`Prazer, ${first(form.name)}! Qual é o seu WhatsApp com DDD? É por ele que a gente vai conversar.`);
        for (;;) {
          const r = await c.ask({ kind: "input", input: "tel", placeholder: "(19) 99999-9999", initial: form.phone });
          const d = r.value.replace(/\D/g, "");
          if (d.length < 10 || d.length > 13) {
            await c.say("Esse número não parece certo. Manda com o DDD, tipo (19) 99999-9999.", { error: true });
            continue;
          }
          form.phone = r.value;
          break;
        }
        save();
        step = "email";
        continue;
      }
      if (step === "email") {
        await c.say("Anotado! E o seu e-mail? É com ele que você entra no app.");
        for (;;) {
          const r = await c.ask({ kind: "input", input: "email", placeholder: "voce@email.com", initial: form.email });
          if (!EMAIL.test(r.value)) {
            await c.say("Acho que faltou alguma coisa nesse e-mail. Confere pra mim?", { error: true });
            continue;
          }
          form.email = r.value.toLowerCase();
          break;
        }
        save();
        step = "password";
        continue;
      }
      if (step === "password") {
        await c.say("Agora cria uma senha com pelo menos 8 caracteres. Prometo não olhar 🙈");
        for (;;) {
          const r = await c.ask({ kind: "input", input: "password", placeholder: "Sua senha" });
          if (r.value.length < 8) {
            await c.say(`Essa tem ${r.value.length} ${r.value.length === 1 ? "caractere" : "caracteres"}. Precisa de pelo menos 8.`, { error: true });
            continue;
          }
          form.password = r.value;
          break;
        }
        step = "terms";
        continue;
      }
      if (step === "terms") {
        await c.say("Última coisa: você aceita os termos de uso e a política de privacidade? Eles contam o que eu guardo e como cuido dos seus dados.");
        for (;;) {
          const r = await c.ask({
            kind: "pick",
            options: [
              { id: "yes", label: "Li e aceito", main: true },
              { id: "read", label: "Ler os termos" },
            ],
          });
          if (r.value === "yes") break;
          if (await readTerms()) {
            await c.say("Valeu por ler! 💜", { quick: true });
            break;
          }
          await c.say("Sem pressa. Quando quiser, é só tocar em Li e aceito.");
        }
        step = "send";
        continue;
      }
      if (step === "send") {
        try {
          const r = await c.working(api("/api/auth/register", { method: "POST", json: { ...form, code: code ?? undefined, accept_terms: true } }));
          if (r.needs_code) {
            challenge = { id: r.challenge, to: r.to ?? localPhone(form.phone) };
            step = "otp";
            continue;
          }
          if (r.pending) {
            clearDraft();
            await c.say(r.message ?? "Recebi seu cadastro! Assim que ele for aprovado, te aviso no WhatsApp.");
            await c.ask({ kind: "pick", options: [{ id: "enter", label: "Voltar para o login", main: true }] });
            return onEnter();
          }
          me = r as Me;
        } catch (e) {
          const msg = (e as Error).message;
          await c.say(msg, { error: true });
          const back = stepFor(msg);
          if (back === "phone" && invite?.phone) step = "email";
          else if (back === "code" && !needsCode) step = "name";
          else if (back) step = back;
          else {
            await c.ask({ kind: "pick", options: [{ id: "again", label: "Tentar de novo", main: true }] });
          }
        }
        continue;
      }
      if (step === "otp" && challenge) {
        c.progress(0.66);
        await c.say(`Pra confirmar que o número é seu, mandei um código de 6 dígitos no WhatsApp ${challenge.to.startsWith("+") ? phoneFmt(challenge.to) : challenge.to}. Me passa ele aqui?`);
        for (;;) {
          const r = await c.ask({
            kind: "input",
            input: "otp",
            placeholder: "000000",
            actions: [
              { id: "again", label: "Mandar outro código" },
              ...(invite?.phone ? [] : [{ id: "phone", label: "Trocar o número" }]),
            ],
          });
          if (r.action === "phone") {
            step = "phone";
            break;
          }
          if (r.action === "again") {
            step = "send";
            break;
          }
          try {
            const res = await c.working(
              api("/api/auth/register", { method: "POST", json: { ...form, code: code ?? undefined, accept_terms: true, challenge: challenge.id, verify_code: r.value } }),
            );
            if (res.pending) {
              clearDraft();
              await c.say(res.message ?? "Recebi seu cadastro! Assim que ele for aprovado, te aviso no WhatsApp.");
              await c.ask({ kind: "pick", options: [{ id: "enter", label: "Voltar para o login", main: true }] });
              return onEnter();
            }
            me = res as Me;
            break;
          } catch (e) {
            const msg = (e as Error).message;
            await c.say(msg, { error: true });
            const back = stepFor(msg);
            if (back && back !== "phone") {
              step = back;
              break;
            }
          }
        }
        continue;
      }
      step = "send";
    }

    // conta criada: daqui em diante a pessoa já está logada
    clearDraft();
    form.password = "";
    if (code) history.replaceState(null, "", "/");
    c.progress(0.72);
    c.mood("laughing");
    await c.say(`Conta criada, ${first(form.name)}! 🎉`);
    c.mood(null);

    const welcome = await c.working(api<Welcome>("/api/me/onboarding").catch(() => null));
    let answers: WelcomeAnswers = {};
    if (welcome?.due && welcome.questions.length) {
      await c.say("Agora quero te conhecer um pouquinho, pra já começar do seu jeito. São só umas perguntinhas.");
      const go = await c.ask({
        kind: "pick",
        options: [
          { id: "yes", label: "Bora!", main: true },
          { id: "no", label: "Agora não" },
        ],
      });
      if (go.value === "yes") answers = await askWelcome(c, welcome.questions, welcome.answers, 0.75, 0.2);
      await c
        .working(api("/api/me/onboarding", { method: "PUT", json: Object.keys(answers).length ? { answers } : { skip: true } }))
        .catch(() => {});
    }
    // já respondeu aqui: o tour antigo não abre por cima do painel
    void api("/api/me/tour", { method: "PUT" }).catch(() => {});
    void api("/api/me/welcome", { method: "POST" }).catch(() => {});

    c.progress(1);
    if (personalCards(answers).length) await c.say("Prontinho! Montei o seu Planejai com o que você me contou:", { node: <PersonalScene answers={answers} /> });
    else await c.say("Prontinho! Seu Planejai está no ar.");
    await c.say("Eu moro no seu WhatsApp: manda texto, áudio ou foto do jeito que mandaria pra um amigo. Acabei de te mandar um oi por lá 👋");
    await c.say("E uma regra minha: mandar mensagem pra alguém, pagar ou apagar alguma coisa só sai depois do seu sim.");
    c.mood("happy");
    await c.ask({ kind: "pick", options: [{ id: "go", label: "Abrir meu Planejai", main: true }] });
    onLogin(me);
  });

  return (
    <>
      <ChatView
        chat={chat}
        className="cad-signup"
        sub="seu cadastro"
        left={
          !isStandalone() ? (
            <a className="cad-icon" href="/" aria-label="Voltar para a página inicial" title="Voltar">
              <Icon name="chevron-left" size={22} />
            </a>
          ) : null
        }
        right={
          <button type="button" className="cad-link" onClick={onEnter}>
            Entrar
          </button>
        }
      />
      {terms && (
        <Modal
          title="Termos de uso e privacidade"
          wide
          onClose={() => {
            terms(false);
            setTerms(null);
          }}
          footer={(close) => (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => {
                terms(true);
                close();
              }}
            >
              Li e aceito
            </button>
          )}
        >
          <Suspense fallback={<p className="muted">Carregando…</p>}>
            <PrivacyPage embedded />
          </Suspense>
        </Modal>
      )}
    </>
  );
}

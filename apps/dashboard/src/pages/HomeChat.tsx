import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api, brl } from "../api";
import type { Me } from "../App";
import { Modal } from "../components";
import { AgentFace, CORE_FACES, type Face } from "../faces";
import { useApi } from "../hooks";
import { liveOn, onLive } from "../live";
import { Icon } from "../icons";
import { haptic } from "../touch";
import { useKeyboardShell } from "../teclado";
import { ChatCard, type ChatCardData } from "./ChatCards";
import { InviteForm } from "./Invites";
import { liquidGlass } from "../vidro-liquido";
import "../styles/chat-inicio.css";

/**
 * Início no celular: em vez dos painéis, uma conversa com o time (o mesmo motor, as mesmas ferramentas e o
 * mesmo "sim" do WhatsApp, rota /api/chat). Ao abrir, cada agente manda a sua primeira mensagem com o que
 * importa hoje (agenda, gastos, o que está de olho), sem IA. Os agentes ficam no topo, em fila, para chamar
 * qualquer um com um toque.
 */

interface MsgMedia {
  kind: string;
  mimetype: string;
  fileName?: string | null;
  seconds?: number | null;
  gif?: boolean;
  url?: string | null;
}
interface Msg {
  id: number;
  role: "user" | "assistant" | "team";
  text: string | null;
  /** role "team": quem falou com quem ({ from, to, kind }) */
  media: (MsgMedia & { from?: string; to?: string }) | null;
  reaction?: string | null;
  /** calendário e mini painel que o servidor montou para a rodada (sem texto do modelo) */
  cards?: ChatCardData[];
  at: string;
  local?: "sending" | "failed";
  /** o que mandar de novo se falhou */
  retry?: Outgoing;
}
interface Hello {
  name: string | null;
  hour: number;
  today: { title: string; at: string }[];
  spent_month: string;
  spent_today: string;
  watches: string[];
  errands_waiting: number;
}
interface ChatState {
  ready: boolean;
  reason?: string;
  messages: Msg[];
  reactions?: { id: number; reaction: string }[];
  typing?: string | null;
  working?: boolean;
  more?: boolean;
  hello?: Hello;
}
interface Agent {
  id: string;
  persona: string;
  name: string;
  role: string;
  face?: Face | null;
  kind: "cto" | "specialist" | "client";
}
interface Outgoing {
  text?: string;
  media?: { base64: string; mimetype: string; fileName?: string; seconds?: number };
  preview?: MsgMedia;
}
type Chip = { label: string; text: string; send?: boolean };
type Opener = { agent: Agent; text: string };

/** O que pedir para cada agente do time fixo (os da loja usam o próprio foco). */
const ASKS: Record<string, Chip[]> = {
  cto: [
    { label: "O que você consegue fazer?", text: "O que você e o time conseguem fazer por mim?", send: true },
    { label: "Organiza minha semana", text: "Me ajuda a organizar minha semana", send: true },
  ],
  pesquisador: [
    { label: "Pesquisar um preço", text: "Pesquisa o menor preço de " },
    { label: "Previsão do tempo", text: "Como vai estar o tempo amanhã?", send: true },
  ],
  agenda: [
    { label: "O que tenho amanhã?", text: "O que eu tenho amanhã?", send: true },
    { label: "Criar um lembrete", text: "Me lembra de " },
  ],
  financeiro: [
    { label: "Quanto gastei no mês?", text: "Quanto eu gastei este mês?", send: true },
    { label: "Anotar um gasto", text: "Gastei " },
  ],
  comunicacao: [
    { label: "E-mails importantes", text: "Tem algum e-mail importante pra mim hoje?", send: true },
    { label: "Escrever um e-mail", text: "Escreve um e-mail para " },
  ],
  produtividade: [
    { label: "Lista de tarefas", text: "Cria uma lista de tarefas para hoje com ", },
    { label: "Anotar uma ideia", text: "Anota essa ideia: " },
  ],
  anotacoes: [
    { label: "Anotar em tópicos", text: "Anota em tópicos: " },
    { label: "Minhas anotações", text: "Quais anotações eu tenho?", send: true },
  ],
  recados: [
    { label: "Marcar um horário", text: "Marca um horário pra mim no " },
    { label: "Mandar um recado", text: "Manda uma mensagem pra " },
  ],
};

const START_CHIPS: Chip[] = [
  { label: "🗓️ O que tenho amanhã?", text: "O que eu tenho amanhã?", send: true },
  { label: "💸 Anotar um gasto", text: "Gastei " },
  { label: "⏰ Me lembra de…", text: "Me lembra de " },
  { label: "🔎 Pesquisar um preço", text: "Pesquisa o menor preço de " },
  { label: "📊 Gastos do mês", text: "Quanto eu gastei este mês?", send: true },
];

const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const hm = (iso: string) => new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (dayKey(d) === dayKey(today)) return "Hoje";
  if (dayKey(d) === dayKey(y)) return "Ontem";
  return d.toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
};
const isYesQuestion = (t: string | null) => !!t && /responda\s+\*?sim\*?/i.test(t);
const firstName = (s: string | null | undefined) => (s ?? "").trim().split(/\s+/)[0] ?? "";

/** Negrito, itálico, riscado e mono do WhatsApp, links clicáveis; sem HTML cru. */
function rich(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|```[\s\S]+?```|`[^`\n]+`|https?:\/\/[^\s<>()]+[^\s<>().,!?;:])/g;
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const t = m[0];
    if (t.startsWith("```")) out.push(<code key={k++} className="hc-code">{t.slice(3, -3)}</code>);
    else if (t.startsWith("`")) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("*")) out.push(<strong key={k++}>{t.slice(1, -1)}</strong>);
    else if (t.startsWith("_")) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    else if (t.startsWith("~")) out.push(<s key={k++}>{t.slice(1, -1)}</s>);
    else {
      let host = t;
      try {
        host = new URL(t).hostname.replace(/^www\./, "");
      } catch {
        /* fica o texto */
      }
      out.push(<a key={k++} href={t} target="_blank" rel="noopener noreferrer">{host}</a>);
    }
    last = i + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function RichText({ text }: { text: string }) {
  // "👉 Responda *sim* para ..." vira botões embaixo; o texto continua para dar contexto
  return (
    <>
      {text.split("\n").map((line, i) => (
        <p key={i} className={line.startsWith("• ") ? "hc-li" : line.trim() ? undefined : "hc-gap"}>
          {line.startsWith("• ") ? <><span aria-hidden>•</span><span>{rich(line.slice(2))}</span></> : rich(line)}
        </p>
      ))}
    </>
  );
}

function AudioBubble({ src, seconds }: { src: string; seconds?: number | null }) {
  const el = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [p, setP] = useState(0);
  const [dur, setDur] = useState(seconds ?? 0);
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return (
    <div className="hc-audio">
      <button
        className="hc-audio-btn"
        aria-label={playing ? "Pausar" : "Ouvir"}
        onClick={() => {
          const a = el.current;
          if (!a) return;
          if (a.paused) void a.play();
          else a.pause();
        }}
      >
        <Icon name={playing ? "pause" : "play"} size={18} />
      </button>
      <span className="hc-audio-bar"><i style={{ transform: `scaleX(${p})` }} /></span>
      <span className="hc-audio-time">{fmt(playing || p ? (el.current?.currentTime ?? 0) : dur)}</span>
      <audio
        ref={el}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => (setPlaying(false), setP(0))}
        onLoadedMetadata={(e) => Number.isFinite(e.currentTarget.duration) && setDur(e.currentTarget.duration)}
        onTimeUpdate={(e) => setP(e.currentTarget.duration ? e.currentTarget.currentTime / e.currentTarget.duration : 0)}
      />
    </div>
  );
}

function MediaView({ m }: { m: MsgMedia }) {
  if (!m.url) return <div className="hc-file"><Icon name="file" size={18} /><span>{m.fileName ?? "Arquivo"}</span></div>;
  if (m.kind === "sticker") return <img className="hc-sticker" src={m.url} alt="figurinha" loading="lazy" />;
  if (m.kind === "image") return <a href={m.url} target="_blank" rel="noopener noreferrer"><img className="hc-img" src={m.url} alt={m.fileName ?? "imagem"} loading="lazy" /></a>;
  if (m.kind === "video") return <video className="hc-img" src={m.url} controls={!m.gif} autoPlay={m.gif} loop={m.gif} muted={m.gif} playsInline />;
  if (m.kind === "audio") return <AudioBubble src={m.url} seconds={m.seconds} />;
  return (
    <a className="hc-file" href={m.url} target="_blank" rel="noopener noreferrer">
      <span className="hc-file-ico"><Icon name="file" size={18} /></span>
      <span className="hc-file-name">{m.fileName ?? "Documento"}</span>
      <Icon name="download" size={16} />
    </a>
  );
}

function Typing({ label }: { label?: string }) {
  return (
    <div className="hc-typing" role="status" aria-label={label ?? "digitando"}>
      <span /><span /><span />
    </div>
  );
}

/** Foto do celular vira JPEG de até 1600 px (cabe rápido e a IA lê igual). */
async function shrinkImage(file: File): Promise<{ base64: string; mimetype: string }> {
  const raw = await readBase64(file);
  if (!/^image\/(jpeg|png|webp|heic|heif)/.test(file.type)) return { base64: raw, mimetype: file.type || "application/octet-stream" };
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL("image/jpeg", 0.86);
    return { base64: url.slice(url.indexOf(",") + 1), mimetype: "image/jpeg" };
  } catch {
    return { base64: raw, mimetype: file.type };
  }
}
function readBase64(blob: Blob): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      res(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });
}

function useRecorder(onDone: (o: Outgoing) => void) {
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const started = useRef(0);
  const cancelled = useRef(false);
  const [secs, setSecs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (secs === null) return;
    const t = setInterval(() => setSecs(Math.floor((Date.now() - started.current) / 1000)), 250);
    return () => clearInterval(t);
  }, [secs === null]);
  useEffect(() => {
    if (secs !== null && secs >= 180) rec.current?.stop();
  }, [secs]);
  const start = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return setError("Este aparelho não grava áudio por aqui.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((t) => MediaRecorder.isTypeSupported?.(t));
      const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      chunks.current = [];
      cancelled.current = false;
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const seconds = Math.max(1, Math.round((Date.now() - started.current) / 1000));
        setSecs(null);
        if (cancelled.current || !chunks.current.length) return;
        const blob = new Blob(chunks.current, { type: r.mimeType || type || "audio/webm" });
        const base64 = await readBase64(blob);
        const mimetype = blob.type.split(";")[0] || "audio/webm";
        onDone({ media: { base64, mimetype, fileName: "audio", seconds }, preview: { kind: "audio", mimetype, seconds, url: URL.createObjectURL(blob) } });
      };
      rec.current = r;
      started.current = Date.now();
      r.start();
      setSecs(0);
      haptic(12);
    } catch {
      setError("Sem acesso ao microfone. Libere nas permissões do navegador.");
    }
  };
  const stop = (cancel = false) => {
    cancelled.current = cancel;
    rec.current?.stop();
    rec.current = null;
  };
  return { secs, error, start, stop, clearError: () => setError(null) };
}

/** `wide`: no notebook a conversa abre dentro da moldura (ao lado do trilho), numa coluna centralizada. */
export function HomeChat({ me, wide = false }: { me: Me; wide?: boolean }) {
  const nav = useNavigate();
  const team = useApi<{ core: Agent[]; mine: any[] }>("/api/me/team");
  const [state, setState] = useState<ChatState | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [sheet, setSheet] = useState<Agent | "team" | null>(null);
  const [attach, setAttach] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState(0);
  const [olderLoading, setOlderLoading] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  // quem mexeu por último na lista: a pessoa (dedo, roda, teclado) ou o próprio chat descendo até o fim
  const userAt = useRef(0);
  const autoAt = useRef(0);
  const touchY = useRef(0);
  const retry = useRef<ReturnType<typeof setTimeout>>(undefined);
  const older = useRef<{ top: number; h: number } | null>(null);
  const lastId = useRef(0);
  const busy = useRef(false);
  const sentRef = useRef(0);
  sentRef.current = sentAt;
  const dock = useRef<HTMLDivElement>(null);
  // teclado do celular: a tela acompanha a área visível e a caixa fica colada no teclado (teclado.ts)
  useKeyboardShell(!wide);
  // a lista termina acima da caixa de mensagem (que cresce com atalhos, Sim/Não e texto longo)
  useEffect(() => {
    const d = dock.current;
    if (!d || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      root.current?.style.setProperty("--hc-dock", `${d.offsetHeight + 12}px`);
      if (stick.current) toBottom(false);
    });
    ro.observe(d);
    return () => ro.disconnect();
  }, []);

  // a tela de conversa ocupa o lugar do cabeçalho do app (o sininho mora no topo do chat)
  useLayoutEffect(() => {
    document.documentElement.classList.add("pj-chat");
    return () => document.documentElement.classList.remove("pj-chat");
  }, []);

  const agents = useMemo<Agent[]>(() => {
    const core = team.data?.core ?? Object.entries(CORE_FACES).map(([id, f]) => ({ id, persona: f.persona, face: f.face, name: id, role: "", kind: id === "cto" ? "cto" : "specialist" }) as Agent);
    const mine = (team.data?.mine ?? []).map((a: any) => ({ id: `c_${a.slug}`, persona: a.persona ?? a.name, name: a.name, role: a.focus ?? "", face: a.face, kind: "client" }) as Agent);
    return [...core, ...mine];
  }, [team.data]);
  const cto = agents.find((a) => a.id === "cto") ?? agents[0]!;
  const byId = (id: string) => agents.find((a) => a.id === id);

  const merge = useCallback((incoming: Msg[]) => {
    if (!incoming.length) return;
    setMsgs((cur) => {
      const ids = new Set(cur.map((m) => m.id));
      const add = incoming.filter((m) => !ids.has(m.id));
      if (!add.length) return cur;
      return [...cur, ...add].sort((a, b) => (a.local ? 1 : 0) - (b.local ? 1 : 0) || a.id - b.id);
    });
    lastId.current = Math.max(lastId.current, ...incoming.map((m) => m.id));
  }, []);

  // primeira carga e depois só o que chegou (rápido enquanto o time trabalha, devagar parado)
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (first = false) => {
      try {
        const r = await api<ChatState>(first ? "/api/chat" : `/api/chat?after=${lastId.current}`);
        if (!alive) return;
        if (first) {
          setState(r);
          setMsgs(r.messages);
          lastId.current = Math.max(0, ...r.messages.map((m) => m.id));
        } else {
          merge(r.messages);
          setState((s) => (s ? { ...s, typing: r.typing, working: r.working, ready: r.ready } : r));
          if (r.reactions?.length) {
            const map = new Map(r.reactions.map((x) => [x.id, x.reaction]));
            setMsgs((cur) => (cur.some((m) => map.has(m.id) && m.reaction !== map.get(m.id)) ? cur.map((m) => (map.has(m.id) ? { ...m, reaction: map.get(m.id) } : m)) : cur));
          }
        }
        busy.current = Boolean(r.working || r.typing);
      } catch {
        /* sem rede: tenta de novo no próximo tique */
      }
      if (!alive) return;
      const fast = busy.current || Date.now() - sentRef.current < 90_000;
      // tempo real ligado: resposta e "digitando" chegam pelo aviso (app_chat/app_chat_state); a consulta vira segurança
      const wait = liveOn() ? (fast ? 4000 : 30_000) : fast ? 1000 : 7000;
      timer = setTimeout(() => (document.hidden ? (timer = setTimeout(() => tick(), 4000)) : tick()), wait);
    };
    void tick(true);
    const wake = () => !document.hidden && (clearTimeout(timer), tick());
    document.addEventListener("visibilitychange", wake);
    const offLive = onLive(["app_chat", "app_chat_state"], wake);
    return () => {
      alive = false;
      clearTimeout(timer);
      offLive();
      document.removeEventListener("visibilitychange", wake);
    };
  }, [merge]);

  // abertura sem IA: o time conversa entre si sobre o dia da pessoa (agenda, gastos, o que está de olho, recados).
  // Sai de mensagens prontas com os dados do GET /api/chat; a IA só entra quando a pessoa manda alguma coisa.
  const openers = useMemo<Opener[]>(() => {
    const h = state?.hello;
    if (!h || !agents.length) return [];
    return buildOpeners(h, h.name ?? firstName(me.name), cto, byId, !msgs.some((m) => !m.local));
  }, [state?.hello, agents, msgs.length > 0]);

  // toca a abertura digitando ao abrir o chat (de novo depois de umas horas longe); senão ela já está na tela
  const [opening] = useState(() => {
    try {
      const at = Number(localStorage.getItem(OPEN_KEY)) || 0;
      if (at && dayKey(new Date(at)) === dayKey(new Date()) && Date.now() - at < REPLAY_MS) return { at, replay: false };
    } catch {
      /* sem armazenamento: toca toda vez */
    }
    return { at: Date.now(), replay: true };
  });
  const [shown, setShown] = useState(opening.replay ? 0 : 99);
  useEffect(() => {
    if (!openers.length) return;
    if (shown >= openers.length) {
      try {
        if (opening.replay) localStorage.setItem(OPEN_KEY, String(opening.at));
      } catch {
        /* sem armazenamento */
      }
      return;
    }
    if (reduced()) return setShown(99);
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 450 : 600 + Math.min(1000, openers[shown - 1]!.text.length * 10));
    return () => clearTimeout(t);
  }, [openers, shown, opening]);

  // segue o fim da conversa enquanto a pessoa não rolou para ler o que passou
  // Nunca puxa para baixo com a pessoa mexendo na lista (o dedo subindo ou o embalo depois de soltar): espera
  // ela parar e só desce se ela ainda estiver no fim. Longe do fim pula direto, sem deslizar a conversa toda.
  const toBottom = (smooth = true) => {
    const el = list.current;
    if (!el || holding()) return;
    clearTimeout(retry.current);
    if (Date.now() - userAt.current < 700) {
      retry.current = setTimeout(() => stick.current && toBottom(smooth), 750);
      return;
    }
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight;
    autoAt.current = Date.now();
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !far && !reduced() ? "smooth" : "auto" });
  };
  useEffect(() => () => clearTimeout(retry.current), []);

  // Tocar na caixa com a pessoa lendo mensagens antigas: o teclado abre (ou fecha) e a conversa fica onde estava,
  // com as mesmas mensagens logo acima da caixa, em vez de pular para o fim (David, 2026-10-19).
  const hold = useRef<{ until: number; fromEnd: number } | null>(null);
  const holding = () => Boolean(hold.current && Date.now() < hold.current.until);
  const keepPlace = () => {
    const el = list.current;
    if (!el || stick.current) return void (hold.current = null);
    hold.current = { until: Date.now() + 1200, fromEnd: el.scrollHeight - el.scrollTop - el.clientHeight };
  };
  useEffect(() => {
    const el = list.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!holding()) return;
      el.scrollTop = el.scrollHeight - el.clientHeight - hold.current!.fromEnd;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const touched = () => {
    userAt.current = Date.now();
    clearTimeout(retry.current);
  };
  useLayoutEffect(() => {
    if (stick.current) toBottom(state !== null && msgs.length > 0);
  }, [msgs, shown, state?.working, state?.typing]);
  const first = useRef(true);
  useLayoutEffect(() => {
    if (state && first.current) {
      first.current = false;
      toBottom(false);
    }
  }, [state]);

  // mensagens antigas entram em cima sem mexer no que a pessoa está lendo (antes de pintar a tela)
  const loadingOlder = useRef(false);
  const loadOlder = async () => {
    if (loadingOlder.current || !state?.more || !msgs.length) return;
    loadingOlder.current = true;
    setOlderLoading(true);
    try {
      const r = await api<ChatState>(`/api/chat?before=${msgs[0]!.id}`);
      const el = list.current;
      if (el) older.current = { top: el.scrollTop, h: el.scrollHeight };
      setMsgs((cur) => [...r.messages.filter((m) => !cur.some((c) => c.id === m.id)), ...cur]);
      setState((s) => (s ? { ...s, more: r.messages.length === 60 } : s));
    } catch {
      /* sem rede: tenta de novo na próxima rolagem */
    } finally {
      loadingOlder.current = false;
      setOlderLoading(false);
    }
  };
  useLayoutEffect(() => {
    const el = list.current;
    const o = older.current;
    if (!el || !o) return;
    older.current = null;
    // o Chrome já segura a posição sozinho (scroll anchoring); o Safari não. Só corrige se precisar.
    const want = o.top + (el.scrollHeight - o.h);
    if (Math.abs(el.scrollTop - want) > 2) el.scrollTop = want;
  }, [msgs]);

  const send = async (o: Outgoing) => {
    setError(null);
    const tmp: Msg = { id: Date.now() * 1000, role: "user", text: o.text ?? null, media: o.preview ?? null, at: new Date().toISOString(), local: "sending" };
    stick.current = true;
    hold.current = null;
    userAt.current = 0;
    setMsgs((cur) => [...cur.filter((m) => m.retry !== o), tmp]);
    setSentAt(Date.now());
    haptic(8);
    try {
      const r = await api<{ message: Msg; queued: boolean; reason?: string }>("/api/chat", { method: "POST", json: { text: o.text, media: o.media }, headers: { "x-pj-quiet": "1" } });
      setMsgs((cur) => cur.filter((m) => m !== tmp));
      merge([o.preview?.url && r.message.media ? { ...r.message, media: { ...r.message.media, url: r.message.media.url ?? o.preview.url } } : r.message]);
      if (!r.queued && r.reason && !/duplicada/.test(r.reason)) setError(r.reason === "ritmo alto: resposta segurada" ? null : `Não deu para mandar agora (${r.reason}).`);
      else setState((s) => (s ? { ...s, working: true } : s));
    } catch (e) {
      setMsgs((cur) => cur.map((m) => (m === tmp ? { ...m, local: "failed", retry: o } : m)));
      setError((e as Error).message);
    }
  };

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    void send({ text: t });
    requestAnimationFrame(() => input.current?.focus());
  };

  const recorder = useRecorder((o) => void send(o));

  const pickFile = async (file: File | undefined) => {
    setAttach(false);
    if (!file) return;
    if (file.size > 15 * 1024 * 1024) return setError("Arquivo grande demais (até 15 MB).");
    const { base64, mimetype } = file.type.startsWith("image/") ? await shrinkImage(file) : { base64: await readBase64(file), mimetype: file.type || "application/octet-stream" };
    const kind = mimetype.startsWith("image/") ? "image" : mimetype.startsWith("video/") ? "video" : mimetype.startsWith("audio/") ? "audio" : "document";
    const caption = text.trim();
    setText("");
    void send({ text: caption || undefined, media: { base64, mimetype, fileName: file.name }, preview: { kind, mimetype, fileName: file.name, url: URL.createObjectURL(file) } });
  };

  const prefill = (c: Chip) => {
    setSheet(null);
    if (c.send) return void send({ text: c.text });
    setText(c.text);
    requestAnimationFrame(() => {
      const el = input.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(c.text.length, c.text.length);
    });
  };

  // o que veio antes da abertura, a abertura (quando o chat foi aberto) e o que veio depois
  const todayKey = dayKey(new Date());
  const earlier = msgs.filter((m) => !m.local && new Date(m.at).getTime() < opening.at);
  const today = msgs.filter((m) => m.local || new Date(m.at).getTime() >= opening.at);
  const earlierToday = earlier.some((m) => dayKey(new Date(m.at)) === todayKey);
  const last = [...msgs].reverse().find((m) => !m.local && m.role !== "team" && !(m.cards && !m.text));
  const working = Boolean(state?.working || state?.typing) && last?.role !== "assistant" ? true : Boolean(state?.typing);
  const askYes = !working && last?.role === "assistant" && isYesQuestion(last.text);
  const userToday = msgs.some((m) => m.role === "user" && dayKey(new Date(m.at)) === todayKey);
  // quem aparece digitando: o colega que o líder acabou de chamar, ou o próprio líder
  const lastUser = msgs.findLastIndex((m) => m.role === "user");
  const lastTalk = msgs.slice(lastUser + 1).findLast((m) => m.role === "team");
  const talker = (lastTalk?.media?.to && lastTalk.media.to !== "cto" && (lastTalk.media as any).kind === "ask" ? byId(lastTalk.media.to) : null) ?? cto;
  const visibleOpeners = openers.slice(0, shown);
  const openerTyping = shown < openers.length && shown > 0 ? openers[shown]?.agent : shown === 0 && openers.length ? openers[0]!.agent : null;
  const strip = agents.filter((a) => a.kind === "specialist").slice(0, 6);
  const left = strip.slice(0, Math.ceil(strip.length / 2));
  const right = strip.slice(Math.ceil(strip.length / 2));
  const status = recorder.secs !== null ? null : state?.typing === "recording" ? "gravando áudio…" : working ? "digitando…" : null;

  const renderMsg = (m: Msg, prev?: Msg) => {
    const gapTop = prev && prev.role !== m.role ? " hc-turn" : "";
    if (m.role === "user")
      return (
        <div key={m.id} className={`hc-row hc-me${gapTop}${m.local ? ` is-${m.local}` : ""}`}>
          <div className={`hc-bubble${m.media && !m.text && m.media.kind !== "audio" && m.media.kind !== "document" ? " bare" : ""}`}>
            {m.media && <MediaView m={m.media} />}
            {m.text && <div className="hc-text"><RichText text={m.text} /></div>}
            {m.reaction && <span className="hc-reaction" aria-label={`reagiu com ${m.reaction}`}>{m.reaction}</span>}
          </div>
          {m.local === "failed" && m.retry && (
            <button className="hc-retry" onClick={() => void send(m.retry!)}>
              <Icon name="refresh" size={13} /> Não foi. Tocar para mandar de novo
            </button>
          )}
        </div>
      );
    const head = !prev || prev.role !== "assistant";
    if (m.cards?.length && !m.text)
      return (
        <Fragment key={m.id}>
          {m.cards.map((c, i) => (
            <BotRow key={i} agent={byId(c.agent) ?? cto} head turn={Boolean(gapTop) || i > 0} bare>
              <ChatCard card={c} />
            </BotRow>
          ))}
        </Fragment>
      );
    return (
      <BotRow key={m.id} agent={cto} head={head} turn={Boolean(gapTop)}>
        {m.media && <MediaView m={m.media} />}
        {m.text && <div className="hc-text"><RichText text={m.text} /></div>}
      </BotRow>
    );
  };
  // o time conversando entre si enquanto trabalha: uma conversinha à parte, menor
  const renderTalk = (group: Msg[]) => (
    <div key={`t${group[0]!.id}`} className="hc-huddle" aria-label="Conversa do time">
      {group.map((m) => {
        const from = byId(m.media?.from ?? "") ?? cto;
        const to = byId(m.media?.to ?? "");
        return (
          <div key={m.id} className="hc-talk">
            <div className="hc-talk-top">
              <AgentFace face={from.face} agent={from.kind === "client" ? undefined : from.id} size={26} title={from.persona} />
              <span className="hc-talk-who">{from.persona}{to ? <> <i>para</i> {to.persona}</> : null}</span>
            </div>
            <span className="hc-talk-t">{m.text}</span>
          </div>
        );
      })}
    </div>
  );
  const renderList = (arr: Msg[], afterHeader = false) =>
    arr.map((m, i) => {
      const prev = arr[i - 1];
      if (m.role === "team" && prev?.role === "team") return null;
      const newDay = !(afterHeader && i === 0) && (!prev || dayKey(new Date(prev.at)) !== dayKey(new Date(m.at)));
      let group: Msg[] = [];
      if (m.role === "team") {
        let j = i;
        while (arr[j]?.role === "team") group.push(arr[j++]!);
      }
      return (
        <Fragment key={m.id}>
          {newDay && <div className="hc-day">{dayLabel(m.at)}</div>}
          {!newDay && prev && new Date(m.at).getTime() - new Date(prev.at).getTime() > 45 * 60_000 && <div className="hc-day">{hm(m.at)}</div>}
          {m.role === "team" ? renderTalk(group) : renderMsg(m, prev?.role === "team" ? undefined : prev)}
        </Fragment>
      );
    });

  const page = (
    <div className={`hc${wide ? " hc-wide" : ""}`} ref={root}>
      <header className="hc-top">
        <button className="hc-icon" ref={liquidGlass} aria-label="Ver painel" title="Ver painel" onClick={() => { haptic(); nav("/painel"); }}>
          <Icon name="layout" size={20} />
        </button>
        <div className="hc-crew">
          <div className="hc-side l">
            {left.map((a, i) => (
              <button key={a.id} className="hc-mini" style={{ ["--d" as any]: `${(left.length - i) * 60}ms` }} onClick={() => { haptic(); setSheet(a); }} aria-label={`Falar com ${a.persona}`}>
                <AgentFace face={a.face} agent={a.id} size={34} title={a.persona} />
              </button>
            ))}
          </div>
          <button className="hc-lead" onClick={() => { haptic(); setSheet("team"); }} aria-label={`Seu time, com ${cto?.persona}`}>
            <AgentFace face={cto?.face} size={60} title={cto?.persona} live />
            <span className="hc-name">
              <span className="hc-name-t">{cto?.persona}</span>
              <span className={`hc-name-s${status ? " on" : ""}`}>{status ?? "e o time"}</span>
            </span>
          </button>
          <div className="hc-side r">
            {right.map((a, i) => (
              <button key={a.id} className="hc-mini" style={{ ["--d" as any]: `${(i + 1) * 60}ms` }} onClick={() => { haptic(); setSheet(a); }} aria-label={`Falar com ${a.persona}`}>
                <AgentFace face={a.face} agent={a.id} size={34} title={a.persona} />
              </button>
            ))}
          </div>
        </div>
        {wide ? (
          <span />
        ) : (
          <button className="hc-icon" ref={liquidGlass} aria-label="Convidar alguém" title="Convidar alguém" onClick={() => { haptic(); setInviting(true); }}>
            <Icon name="user-plus" size={20} />
          </button>
        )}
      </header>

      <div
        className="hc-list"
        ref={list}
        data-no-ptr
        onWheel={(e) => {
          touched();
          if (e.deltaY < 0) stick.current = false;
        }}
        onTouchStart={(e) => {
          touched();
          touchY.current = e.touches[0]?.clientY ?? 0;
        }}
        onTouchMove={(e) => {
          touched();
          // dedo descendo = conversa subindo: a pessoa quer ler o que passou, para de seguir o fim na hora
          if ((e.touches[0]?.clientY ?? 0) > touchY.current + 4) stick.current = false;
        }}
        onTouchEnd={touched}
        onKeyDown={touched}
        onScroll={(e) => {
          const el = e.currentTarget;
          const now = Date.now();
          const mine = now - autoAt.current > 900 || now - userAt.current < 700;
          // a descida que o próprio chat faz não decide nada; o embalo depois de soltar o dedo conta como da pessoa
          if (mine && !holding()) {
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            if (now - autoAt.current > 900) userAt.current = Math.max(userAt.current, now - 400);
          }
          if (el.scrollTop < 500) void loadOlder();
        }}
      >
        {state && !state.ready ? (
          <div className="hc-empty">
            <AgentFace face={cto?.face} agent="cto" size={84} live />
            <p>{state.reason ?? "O chat ainda não está disponível para esta conta."}</p>
            <button className="btn" onClick={() => nav("/painel")}>Ver o painel</button>
          </div>
        ) : (
          <>
            {olderLoading && <div className="hc-older" aria-live="polite"><span>carregando…</span></div>}
            {renderList(earlier)}
            {state && <div className="hc-day">{earlierToday ? hm(new Date(opening.at).toISOString()) : "Hoje"}</div>}
            {visibleOpeners.map((o, i) => {
              const prevAgent = visibleOpeners[i - 1]?.agent.id;
              return (
                <BotRow key={`o${i}`} agent={o.agent} head={prevAgent !== o.agent.id} turn={prevAgent !== o.agent.id}>
                  <div className="hc-text"><RichText text={o.text} /></div>
                </BotRow>
              );
            })}
            {openerTyping && (
              <BotRow agent={openerTyping} head={visibleOpeners.at(-1)?.agent.id !== openerTyping.id} turn={visibleOpeners.at(-1)?.agent.id !== openerTyping.id}>
                <Typing />
              </BotRow>
            )}
            {renderList(today, true)}
            {working && shown >= openers.length && (
              <BotRow agent={talker} head turn>
                <Typing label={status ?? undefined} />
              </BotRow>
            )}
          </>
        )}
      </div>

      <div className="hc-dock" ref={dock} onFocusCapture={keepPlace} onBlurCapture={keepPlace}>
        {error && (
          <div className="hc-error" role="alert" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {recorder.error && (
          <div className="hc-error" role="alert" onClick={recorder.clearError}>
            {recorder.error}
          </div>
        )}
        {askYes ? (
          <div className="hc-chips yes">
            <button className="hc-chip hc-yes" onClick={() => void send({ text: "sim" })}><Icon name="check" size={15} /> Sim</button>
            <button className="hc-chip" onClick={() => void send({ text: "não" })}><Icon name="x" size={15} /> Não</button>
          </div>
        ) : (
          !userToday && shown >= openers.length && !text && state?.ready !== false && (
            <div className="hc-chips">
              {START_CHIPS.map((c) => (
                <button key={c.label} className="hc-chip" onClick={() => prefill(c)}>{c.label}</button>
              ))}
            </div>
          )
        )}
        <div className={`hc-composer${recorder.secs !== null ? " rec" : ""}`} ref={liquidGlass}>
          {recorder.secs !== null ? (
            <>
              <button className="hc-icon ghost" aria-label="Cancelar gravação" onClick={() => recorder.stop(true)}><Icon name="trash" size={20} /></button>
              <span className="hc-rec"><i /> {Math.floor(recorder.secs / 60)}:{String(recorder.secs % 60).padStart(2, "0")}</span>
              <button className="hc-send" aria-label="Mandar áudio" onClick={() => recorder.stop(false)}><Icon name="arrow-up" size={20} /></button>
            </>
          ) : (
            <>
              <button className={`hc-icon ghost${attach ? " on" : ""}`} aria-label="Anexar" aria-expanded={attach} onClick={() => { haptic(); setAttach((v) => !v); }}>
                <Icon name="plus" size={22} />
              </button>
              <textarea
                ref={input}
                rows={1}
                value={text}
                placeholder={`Mensagem para ${cto?.persona ?? "o time"}`}
                aria-label="Mensagem"
                enterKeyHint="send"
                disabled={state?.ready === false}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !("ontouchstart" in window)) {
                    e.preventDefault();
                    submit();
                  }
                }}
              />
              {text.trim() ? (
                <button className="hc-send" aria-label="Enviar" onClick={submit}><Icon name="arrow-up" size={20} /></button>
              ) : (
                <button className="hc-mic" aria-label="Gravar áudio" disabled={state?.ready === false} onClick={() => void recorder.start()}><MicIcon /></button>
              )}
            </>
          )}
          <input ref={fileRef} type="file" hidden onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} />
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { void pickFile(e.target.files?.[0]); e.target.value = ""; }} />
        </div>
      </div>

      {inviting && (
        <Modal title="Convidar alguém" icon={<Icon name="user-plus" />} onClose={() => setInviting(false)}>
          <InviteForm />
        </Modal>
      )}
      {attach && (
        <Modal title="Anexar" onClose={() => setAttach(false)} className="hc-sheet hc-attach-sheet">
          <div className="hc-attach">
            {(
              [
                ["camera", "Câmera", "Tirar uma foto agora", () => cameraRef.current?.click()],
                ["photo", "Fotos e vídeos", "Da galeria do celular", () => fileRef.current && ((fileRef.current.accept = "image/*,video/*"), fileRef.current.click())],
                ["file", "Arquivo", "PDF, planilha, documento", () => fileRef.current && ((fileRef.current.accept = ""), fileRef.current.click())],
              ] as const
            ).map(([icon, label, hint, open]) => (
              <button
                key={icon}
                className="hc-attach-row"
                onClick={() => {
                  haptic();
                  open();
                  setAttach(false);
                }}
              >
                <span className="hc-attach-ico"><AttachIcon name={icon} /></span>
                <span className="hc-team-txt">
                  <strong>{label}</strong>
                  <small>{hint}</small>
                </span>
              </button>
            ))}
          </div>
        </Modal>
      )}

      {sheet && (
        <Modal title={sheet === "team" ? "Seu time" : sheet.persona} onClose={() => setSheet(null)} className="hc-sheet">
          {sheet === "team" ? (
            <div className="hc-team">
              {agents.map((a) => (
                <button key={a.id} className="hc-team-row" onClick={() => setSheet(a)}>
                  <AgentFace face={a.face} agent={a.kind === "client" ? undefined : a.id} size={44} />
                  <span className="hc-team-txt">
                    <strong>{a.persona}</strong>
                    <small>{a.kind === "cto" ? "Lidera o time e fala com você" : a.kind === "client" ? a.role : a.name}</small>
                  </span>
                  <Icon name="chevron-right" size={16} />
                </button>
              ))}
            </div>
          ) : (
            <div className="hc-agent">
              <AgentFace face={sheet.face} agent={sheet.kind === "client" ? undefined : sheet.id} size={92} live />
              <p className="hc-agent-role">{sheet.kind === "cto" ? `${sheet.persona} conversa com você e chama o resto do time quando precisa.` : sheet.role || sheet.name}</p>
              <div className="hc-chips col">
                {(ASKS[sheet.id] ?? (sheet.role ? [{ label: `Pedir ajuda com ${sheet.role.toLowerCase()}`.slice(0, 60), text: `${sheet.persona}, me ajuda com ` }] : [])).map((c) => (
                  <button key={c.label} className="hc-chip" onClick={() => prefill(c)}>{c.label}</button>
                ))}
                {sheet.kind !== "cto" && (
                  <button className="hc-chip" onClick={() => prefill({ label: "", text: `${sheet.persona}, ` })}>
                    <Icon name="send" size={14} /> Chamar {sheet.persona} na conversa
                  </button>
                )}
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
  return createPortal(page, document.body);
}

/** Ícones do Anexar, todos no mesmo traço e no mesmo quadrado de 24 para alinharem. */
function AttachIcon({ name }: { name: "camera" | "photo" | "file" }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {name === "camera" ? (
        <>
          <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.4-2h5l1.4 2h1.6A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
          <circle cx="12" cy="12.5" r="3.5" />
        </>
      ) : name === "photo" ? (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
          <circle cx="9" cy="10" r="1.6" />
          <path d="m20.5 15.5-4.5-4.5-8.5 8.5" />
        </>
      ) : (
        <>
          <path d="M14 3.5H7.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8z" />
          <path d="M14 3.5V8h4.5M9 13h6M9 16.5h4" />
        </>
      )}
    </svg>
  );
}

/** Linha de um agente: a fotinha dele ao lado e, ao lado dela, a fala num cartão com o nome em cima da primeira. */
function BotRow({ agent, head, turn, bare, children }: { agent: Agent; head: boolean; turn: boolean; bare?: boolean; children: ReactNode }) {
  return (
    <div className={`hc-row hc-bot hc-av${turn ? " hc-turn" : ""}`}>
      <span className="hc-av-face">{head && <AgentFace face={agent.face} agent={agent.kind === "client" ? undefined : agent.id} size={34} title={agent.persona} />}</span>
      <div className="hc-av-body">
        <div className={bare ? "hc-bare" : "hc-sq"}>
          {head && !bare && <span className="hc-av-name">{agent.persona}</span>}
          {children}
        </div>
      </div>
    </div>
  );
}

const OPEN_KEY = "pj-chat-abertura";
/** Longe do chat por mais que isto (ou virou o dia): o time conversa de novo ao abrir. */
const REPLAY_MS = 3 * 60 * 60_000;

/** Escolhe uma das falas, a mesma o dia inteiro (não muda a cada abertura no mesmo dia). */
function pick<T>(list: T[], salt: number): T {
  const d = new Date();
  return list[(d.getDate() * 7 + d.getMonth() * 3 + salt) % list.length]!;
}

/**
 * A abertura do dia como uma conversa do time: o líder chama cada colega pelo nome, eles respondem um para o outro
 * com o que importa para a pessoa e o líder devolve a conversa para ela. Tudo pronto, sem IA.
 */
function buildOpeners(h: Hello, name: string, cto: Agent, byId: (id: string) => Agent | undefined, fresh: boolean): Opener[] {
  const greet = h.hour < 5 ? "Boa noite" : h.hour < 12 ? "Bom dia" : h.hour < 18 ? "Boa tarde" : "Boa noite";
  const oi = `${greet}${name ? `, ${name}` : ""}!`;
  const ela = name || "você";
  const out: Opener[] = [];
  const say = (agent: Agent | undefined, text: string) => agent && out.push({ agent, text });
  const ag = byId("agenda");
  const fin = byId("financeiro");
  const res = byId("pesquisador");
  const rec = byId("recados");
  const first = ag ?? fin;
  say(
    cto,
    fresh
      ? `${oi} 👋 Eu sou ${cto.persona} e esse é o seu time. Tudo o que a gente faz no WhatsApp dá pra fazer por aqui.${first ? ` ${first.persona}, conta como tá o dia?` : ""}`
      : `${oi} ${pick(["Juntei o time aqui rapidinho.", "Reuni a turma pra te atualizar.", "Passando com o time pra contar do dia."], 1)}${first ? ` ${first.persona}, começa você?` : ""}`,
  );
  if (ag) {
    const items = h.today.map((t) => `${hm(t.at)} ${t.title}`);
    say(
      ag,
      items.length
        ? `Claro, ${cto.persona}! Hoje ${name ? `${name} tem` : "você tem"} ${items.length === 1 ? "um compromisso" : `${items.length} compromissos`}:\n${items.map((i) => `• ${i}`).join("\n")}`
        : pick([`Agenda livre hoje, ${cto.persona} 🗓️ Se ${ela} quiser marcar algo, é comigo.`, `Nada marcado pra hoje por enquanto 🗓️ Tô a postos se precisar.`, `Dia tranquilo na agenda 🗓️ Quer que eu reserve um tempinho pra algo, ${ela}?`], 2),
    );
  }
  if (fin) {
    const today = Number(h.spent_today);
    const month = Number(h.spent_month);
    if (ag) say(cto, pick([`Valeu, ${ag.persona}! E as contas, ${fin.persona}?`, `Boa! ${fin.persona}, como tão os gastos?`, `E o dinheiro, ${fin.persona}?`], 3));
    say(
      fin,
      today > 0
        ? `Hoje já foram *${brl(h.spent_today)}*, e *${brl(h.spent_month)}* no mês.`
        : month > 0
          ? `No mês tá em *${brl(h.spent_month)}*. Hoje ainda nada anotado, é só me contar que eu registro 💸`
          : "Nada anotado ainda. Me manda tipo \"almoço 32 reais\" que eu cuido 💸",
    );
  }
  if (res && h.watches.length) say(res, `Ah, e eu sigo de olho em ${h.watches.map((w) => `*${w}*`).join(" e ")} 👀 Aviso se mudar.`);
  if (rec && h.errands_waiting > 0)
    say(rec, h.errands_waiting === 1 ? `${cto.persona}, tem um recado esperando resposta de ${ela}.` : `${cto.persona}, tem ${h.errands_waiting} recados esperando resposta de ${ela}.`);
  say(cto, pick([`É isso! Do que você precisa agora${name ? `, ${name}` : ""}?`, "Fala com a gente: do que você precisa agora?", "Bora? Me diz o que você precisa que eu chamo quem resolve."], 4));
  return out;
}

function MicIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ErrorBox, confirmDialog } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

/**
 * Secretária de reuniões: no notebook a pessoa escolhe a guia do Meet (com "Compartilhar áudio da guia"),
 * o microfone dela entra junto e o som vai em trechos de 2,5 min para o servidor transcrever. No fim sai a ata
 * em PDF (Documentos > Reuniões e WhatsApp). Cada trecho é um arquivo inteiro: o gravador para e recomeça.
 */

type Meet = { id: string; title: string; mode?: "painel" | "robo"; status: "entrando" | "gravando" | "resumindo" | "pronto" | "erro"; started_at: string; ended_at: string | null; document_id: string | null; error: string | null; chunks: number; overview?: string | null };
type MeetDetail = Meet & { parts: { seq: number; status: string; transcript: string | null }[] };

const SEGMENT_MS = 150_000;
const STATUS: Record<Meet["status"], string> = { entrando: "Esperando aceitarem a entrada", gravando: "Ouvindo", resumindo: "Escrevendo a ata", pronto: "Ata pronta", erro: "Não deu certo" };

const canCapture = () =>
  typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getDisplayMedia) && typeof MediaRecorder !== "undefined" && !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const pickMime = () => ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";

const toBase64 = (b: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

interface Live {
  id: string;
  streams: MediaStream[];
  audio: AudioContext;
  mixed: MediaStream;
  rec: MediaRecorder | null;
  seq: number;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  uploads: Promise<void>;
  lastStop: Promise<void>;
}

export function MeetRecorder() {
  const list = useApi<{ items: Meet[] }>("/api/meet");
  const busy = list.data?.items.some((m) => m.status === "entrando" || m.status === "gravando" || m.status === "resumindo");
  const [liveId, setLiveId] = useState<string | null>(null);
  const detail = useApi<MeetDetail>(liveId ? `/api/meet/${liveId}` : null, { poll: 15_000, live: ["meet_sessions"] });
  const [title, setTitle] = useState("");
  const [withMic, setWithMic] = useState(true);
  const [phase, setPhase] = useState<"idle" | "starting" | "live" | "stopping">("idle");
  const [sent, setSent] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const live = useRef<Live | null>(null);

  // enquanto a ata está sendo escrita, a lista se atualiza sozinha
  const reloadList = list.reload;
  useEffect(() => {
    if (!busy || phase === "live") return;
    const t = setInterval(() => void reloadList(), 8000);
    return () => clearInterval(t);
  }, [busy, phase, reloadList]);

  useEffect(() => {
    if (phase !== "live") return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    const leave = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", leave);
    return () => {
      clearInterval(t);
      window.removeEventListener("beforeunload", leave);
    };
  }, [phase]);

  // saiu da tela no meio: encerra e manda o que já foi ouvido
  useEffect(() => () => void (live.current?.running && stop()), []);

  const upload = async (l: Live, seq: number, blob: Blob) => {
    if (!blob.size) return;
    const base64 = await toBase64(blob);
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await api(`/api/meet/${l.id}/chunk`, { method: "POST", headers: { "x-pj-quiet": "1" }, json: { seq, mimetype: blob.type || "audio/webm", base64 } });
        setSent((n) => n + 1);
        return;
      } catch {
        await wait([2000, 5000, 10000, 20000][attempt]!);
      }
    }
    setNote("Um trecho não subiu (internet caiu). A ata sai com o resto.");
  };

  const segment = (l: Live) => {
    const mimeType = pickMime();
    const rec = new MediaRecorder(l.mixed, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
    const parts: Blob[] = [];
    const seq = l.seq++;
    rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
    l.lastStop = new Promise((resolve) => {
      rec.onstop = () => {
        const blob = new Blob(parts, { type: rec.mimeType || mimeType || "audio/webm" });
        l.uploads = l.uploads.then(() => upload(l, seq, blob));
        resolve();
      };
    });
    rec.start();
    l.rec = rec;
    l.timer = setTimeout(() => {
      if (!l.running) return;
      rec.stop();
      segment(l);
    }, SEGMENT_MS);
  };

  const release = (l: Live) => {
    l.streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    void l.audio.close().catch(() => {});
  };

  const start = async () => {
    haptic();
    setError(null);
    setNote(null);
    setPhase("starting");
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        // abre o seletor já nas guias, sem oferecer a própria aba do painel
        preferCurrentTab: false,
        selfBrowserSurface: "exclude",
        systemAudio: "include",
      } as DisplayMediaStreamOptions);
    } catch {
      setPhase("idle");
      return;
    }
    const tabAudio = display.getAudioTracks();
    if (!tabAudio.length) {
      display.getTracks().forEach((t) => t.stop());
      setError('Não veio som da guia. Escolha a guia do Meet e deixe ligado "Compartilhar áudio da guia".');
      setPhase("idle");
      return;
    }
    const streams = [display];
    if (withMic) {
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).catch(() => null);
      if (mic) streams.push(mic);
      else setNote("Sem o microfone: vou ouvir só o que vem da guia.");
    }
    const audio = new AudioContext();
    const dest = audio.createMediaStreamDestination();
    audio.createMediaStreamSource(new MediaStream(tabAudio)).connect(dest);
    if (streams[1]) audio.createMediaStreamSource(streams[1]).connect(dest);
    try {
      const s = await api<Meet>("/api/meet", { method: "POST", json: { title: title.trim() || undefined } });
      const l: Live = { id: s.id, streams, audio, mixed: dest.stream, rec: null, seq: 0, timer: null, running: true, uploads: Promise.resolve(), lastStop: Promise.resolve() };
      live.current = l;
      // parou de compartilhar pela barra do navegador: encerra a reunião
      tabAudio[0]!.addEventListener("ended", () => void stop());
      segment(l);
      setSent(0);
      setElapsed(0);
      setLiveId(s.id);
      setPhase("live");
      void list.reload();
    } catch (e) {
      streams.forEach((st) => st.getTracks().forEach((t) => t.stop()));
      void audio.close().catch(() => {});
      setError((e as Error).message);
      setPhase("idle");
    }
  };

  async function stop() {
    const l = live.current;
    if (!l?.running) return;
    l.running = false;
    setPhase("stopping");
    if (l.timer) clearTimeout(l.timer);
    if (l.rec?.state === "recording") l.rec.stop();
    await l.lastStop;
    await l.uploads;
    release(l);
    await api(`/api/meet/${l.id}/stop`, { method: "POST" }).catch((e) => setError((e as Error).message));
    live.current = null;
    setLiveId(null);
    setTitle("");
    setPhase("idle");
    void list.reload();
  }

  // Marlene entra sozinha pelo link: não precisa de notebook nem desta aba aberta
  const [link, setLink] = useState("");
  const [sending, setSending] = useState(false);
  const sendBot = async () => {
    haptic();
    setError(null);
    setSending(true);
    try {
      await api("/api/meet/robo", { method: "POST", json: { url: link.trim() } });
      setLink("");
      void list.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };
  const leaveBot = async (m: Meet) => {
    haptic();
    await api(`/api/meet/${m.id}/stop`, { method: "POST" }).catch((e) => setError((e as Error).message));
    void list.reload();
  };

  const remove = async (m: Meet) => {
    if (!(await confirmDialog({ title: "Apagar esta reunião?", body: `A transcrição de "${m.title}" some. O PDF da ata continua em Documentos.`, confirmLabel: "Apagar", danger: true }))) return;
    await api(`/api/meet/${m.id}`, { method: "DELETE" }).catch((e) => setError((e as Error).message));
    void list.reload();
  };

  const said = (detail.data?.parts ?? []).map((p) => p.transcript ?? "").filter(Boolean).join("\n");
  const items = (list.data?.items ?? []).filter((m) => m.id !== liveId);

  return (
    <>
      <ErrorBox error={error} />
      <section className="card meet-card">
        <h3>Mandar a Marlene para a reunião</h3>
        <p className="muted meet-help">Cole o link do Meet. Ela entra sozinha com o nome dela, mesmo sem você na reunião, e manda a ata no WhatsApp quando acabar. Alguém da reunião precisa aceitar a entrada dela.</p>
        <div className="meet-link">
          <input className="input" value={link} inputMode="url" placeholder="meet.google.com/abc-defg-hij" onChange={(e) => setLink(e.target.value)} />
          <button className="btn btn-primary" disabled={sending || !/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(link)} onClick={() => void sendBot()}>
            <Icon name="send" size={16} /> {sending ? "Enviando…" : "Mandar"}
          </button>
        </div>
      </section>
      <section className="card meet-card">
        <h3>Ouvir pelo notebook</h3>
        {phase === "live" || phase === "stopping" ? (
          <>
            <div className="meet-live" aria-live="polite">
              <span className="meet-dot" aria-hidden="true" />
              <strong>{phase === "stopping" ? "Encerrando" : "Ouvindo"}</strong>
              <span className="muted">{clock(elapsed)}</span>
              <span className="muted meet-sent">{sent === 1 ? "1 trecho enviado" : `${sent} trechos enviados`}</span>
            </div>
            <div className="meet-said">{said ? said.slice(-1600) : <span className="muted">O que for dito aparece aqui a cada poucos minutos.</span>}</div>
            {note && <p className="muted meet-note">{note}</p>}
            <button className="btn btn-primary" disabled={phase === "stopping"} onClick={() => void stop()}>
              <Icon name="stop" size={16} /> {phase === "stopping" ? "Enviando o último trecho…" : "Encerrar e fazer a ata"}
            </button>
            <p className="muted meet-help">Pode voltar para a guia do Meet. Deixe esta aba aberta até o fim.</p>
          </>
        ) : canCapture() ? (
          <>
            <input className="input" value={title} maxLength={120} placeholder="Nome da reunião (opcional)" onChange={(e) => setTitle(e.target.value)} />
            <label className="meet-check">
              <input type="checkbox" checked={withMic} onChange={(e) => setWithMic(e.target.checked)} />
              <span>Ouvir meu microfone também (para a sua fala entrar na ata)</span>
            </label>
            <button className="btn btn-primary" disabled={phase === "starting"} onClick={() => void start()}>
              <Icon name="play" size={16} /> {phase === "starting" ? "Escolha a guia do Meet…" : "Acompanhar reunião"}
            </button>
            <ol className="muted meet-help">
              <li>Abra a reunião do Meet em outra guia.</li>
              <li>Toque em Acompanhar reunião, escolha a guia do Meet e deixe ligado "Compartilhar áudio da guia".</li>
              <li>No fim, toque em Encerrar. A ata em PDF chega no WhatsApp e fica em Documentos.</li>
            </ol>
            {note && <p className="muted meet-note">{note}</p>}
          </>
        ) : (
          <p className="muted">Abra esta tela no notebook, pelo Chrome ou pelo Edge, para acompanhar a reunião do Meet. No celular dá para ver as atas abaixo.</p>
        )}
      </section>
      {items.length > 0 && (
        <section className="card meet-list">
          <h3>Reuniões</h3>
          <ul>
            {items.map((m) => (
              <li key={m.id}>
                <div className="meet-row">
                  <div>
                    <strong>{m.title}</strong>
                    <span className="muted">
                      {when(m.started_at)} · <span className={`meet-status s-${m.status}`}>{STATUS[m.status]}</span>
                    </span>
                    {m.status === "erro" && m.error && <span className="muted meet-err">{m.error}</span>}
                    {m.overview && <p>{m.overview.trim()}</p>}
                  </div>
                  <div className="meet-actions">
                    {m.document_id && (
                      <a className="btn" href={`/api/documents/${m.document_id}/file?inline=1`} target="_blank" rel="noopener" onClick={() => haptic(5)}>
                        <Icon name="file" size={16} /> Ata
                      </a>
                    )}
                    {m.mode === "robo" && (m.status === "entrando" || m.status === "gravando") && (
                      <button className="btn" onClick={() => void leaveBot(m)}>
                        <Icon name="stop" size={16} /> {m.status === "entrando" ? "Cancelar" : "Tirar da reunião"}
                      </button>
                    )}
                    {m.status !== "entrando" && m.status !== "gravando" && m.status !== "resumindo" && (
                      <button className="icon-btn" aria-label="Apagar reunião" onClick={() => void remove(m)}>
                        <Icon name="trash" size={16} />
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

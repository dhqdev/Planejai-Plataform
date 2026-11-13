import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { api } from "../api";
import { confirmDialog, Modal } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";
import { Avatar, mediaUrl, PeopleList, pickPhoto, profilePath, shortTime, STATUS_ALIGNS, STATUS_BGS, STATUS_FONTS, STATUS_MAX, statusFontSize, useRede, type Person, type PickedPhoto, type StatusGroup } from "./redeBase";

/**
 * Status da rede (somem em 24h): a fileira de bolinhas em cima do feed, a tela de assistir (barrinhas de progresso,
 * toque para passar, segurar para pausar, puxar para baixo para fechar) e o editor de criar (texto sobre cor, com letra
 * e alinhamento, ou foto com legenda). A tela de assistir nasce da bolinha tocada e volta para ela ao fechar.
 */

const STATUS_MS = 5200;
const quiet = { "x-pj-quiet": "1" };

const reduced = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
const OPEN_EASE = "cubic-bezier(.2, .9, .25, 1)";
const CLOSE_EASE = "cubic-bezier(.45, 0, .8, .35)";

export function StatusRow() {
  const { profile } = useRede();
  const list = useApi<StatusGroup[]>("/api/feed/status", { poll: 60_000 });
  const [open, setOpen] = useState<{ i: number; from: DOMRect | null } | null>(null);
  const [creating, setCreating] = useState(false);
  const rings = useRef(new Map<string, HTMLElement>());
  const groups = list.data ?? [];
  const mine = groups.findIndex((g) => g.me);
  // status criado pelo "+" do Feed: a fileira se atualiza
  const reload = list.reload;
  useEffect(() => {
    const on = () => void reload();
    window.addEventListener("pj-status-changed", on);
    return () => window.removeEventListener("pj-status-changed", on);
  }, [reload]);
  const show = (i: number, el: HTMLElement) => {
    haptic(6);
    setOpen({ i, from: el.getBoundingClientRect() });
  };
  // ao fechar, a tela volta para a bolinha de quem estava passando (pode ser outra pessoa da que abriu)
  const ringOf = (authorId: string) => rings.current.get(authorId)?.getBoundingClientRect() ?? open?.from ?? null;

  // quem ainda não criou o perfil só assiste: sem bolinha própria e sem fileira vazia
  if (!profile && !groups.length) return null;
  return (
    <div className="rd-status" role="list" aria-label="Status">
      {profile && (
      <div className="rd-st" role="listitem">
        <button
          type="button"
          ref={(el) => { if (el && mine >= 0) rings.current.set(groups[mine]!.author.id, el); }}
          className={`rd-st-ring${mine >= 0 ? " seen" : " none"}`}
          onClick={(e) => { mine >= 0 ? show(mine, e.currentTarget) : (haptic(6), setCreating(true)); }}
          aria-label={mine >= 0 ? "Ver meu status" : "Criar status"}
        >
          <Avatar who={profile} size={58} me link={false} />
        </button>
        <button type="button" className="rd-st-plus" onClick={() => { haptic(6); setCreating(true); }} aria-label="Novo status">
          <Icon name="plus" size={13} />
        </button>
        <span>Seu status</span>
      </div>
      )}
      {groups.map((g, i) =>
        g.me ? null : (
          <div className="rd-st" role="listitem" key={g.author.id}>
            <button
              type="button"
              ref={(el) => { if (el) rings.current.set(g.author.id, el); }}
              className={`rd-st-ring${g.seen ? " seen" : ""}`}
              onClick={(e) => show(i, e.currentTarget)}
              aria-label={`Status de ${g.author.name}${g.seen ? "" : ", novo"}`}
            >
              <Avatar who={g.author} size={58} link={false} />
            </button>
            <span>{g.author.official ? g.author.name : g.author.name.split(" ")[0]}</span>
          </div>
        ),
      )}
      {open != null && groups[open.i] && (
        <StatusViewer
          groups={groups}
          start={open.i}
          from={open.from}
          ringOf={ringOf}
          onClose={() => { setOpen(null); void list.reload(); }}
          onDeleted={() => void list.reload()}
        />
      )}
      {creating && <StatusComposer onClose={() => setCreating(false)} onDone={() => { setCreating(false); void list.reload(); }} />}
    </div>
  );
}

/** Transformação que encolhe o cartão até caber na bolinha (o caminho de abrir e de fechar). */
function towards(card: HTMLElement, ring: DOMRect | null) {
  const r = card.getBoundingClientRect();
  if (!ring || !r.width) return { transform: "translateY(40px) scale(.92)", borderRadius: "22px" };
  const s = ring.width / r.width;
  const dx = ring.left + ring.width / 2 - (r.left + r.width / 2);
  const dy = ring.top + ring.height / 2 - (r.top + r.height / 2);
  return { transform: `translate(${dx}px, ${dy}px) scale(${s})`, borderRadius: `${r.width / 2}px` };
}

export function StatusViewer({ groups, start, startItem, label, from, ringOf, onClose, onDeleted }: {
  groups: StatusGroup[];
  start: number;
  /** abre neste item do grupo (destaques do perfil); sem ele, no primeiro que a pessoa ainda não viu */
  startItem?: number;
  /** título no lugar de "Seu status" (ex.: "Destaques") */
  label?: string;
  from: DOMRect | null;
  ringOf: (authorId: string) => DOMRect | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const firstUnseen = (g: StatusGroup) => Math.max(0, g.items.findIndex((it) => !it.seen));
  const [gi, setGi] = useState(start);
  const [ii, setIi] = useState(() => startItem ?? firstUnseen(groups[start]!));
  const [starred, setStarred] = useState<Record<string, boolean>>({});
  const [held, setHeld] = useState(false);
  const [ready, setReady] = useState(false);
  const [viewers, setViewers] = useState<Person[] | null | undefined>(undefined);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const press = useRef<{ t: number; x: number; y: number; dy: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const prevGi = useRef(start);

  const group = groups[gi]!;
  const items = group.items.filter((it) => !gone.has(it.id));
  const item = items[Math.min(ii, items.length - 1)];
  const paused = held || viewers !== undefined || (item?.kind === "photo" && !ready);

  // abrir: o cartão sai da bolinha tocada e cresce até o meio da tela; o fundo escurece junto
  useLayoutEffect(() => {
    const c = card.current;
    const b = box.current;
    if (!c || !b) return;
    if (reduced()) {
      b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
      return;
    }
    const t = towards(c, from);
    const radius = getComputedStyle(c).borderRadius;
    c.animate([{ ...t, opacity: 0.5 }, { transform: "none", borderRadius: radius, opacity: 1 }], { duration: 380, easing: OPEN_EASE });
    b.animate([{ backgroundColor: "rgba(8, 8, 10, 0)" }, { backgroundColor: getComputedStyle(b).backgroundColor }], { duration: 300, easing: "ease-out" });
    b.querySelectorAll(".rd-sv-side").forEach((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 160, fill: "backwards" }));
  }, [from]);

  // fechar: o caminho de volta, do ponto em que o dedo largou até a bolinha de quem estava passando
  const close = useCallback(() => {
    const c = card.current;
    const b = box.current;
    if (closing.current) return;
    closing.current = true;
    if (!c || !b || reduced()) {
      if (!b) return onClose();
      b.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 140, fill: "forwards" }).onfinish = onClose;
      return;
    }
    const now = c.style.transform || "none";
    c.style.transform = "";
    const t = towards(c, ringOf(groups[gi]!.author.id));
    b.querySelectorAll(".rd-sv-side").forEach((el) => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: "forwards" }));
    b.animate([{ backgroundColor: getComputedStyle(b).backgroundColor }, { backgroundColor: "rgba(8, 8, 10, 0)" }], { duration: 300, easing: "ease-in", fill: "forwards" });
    const a = c.animate([{ transform: now, borderRadius: getComputedStyle(c).borderRadius, opacity: 1 }, { ...t, opacity: 0 }], { duration: 300, easing: CLOSE_EASE, fill: "forwards" });
    a.onfinish = onClose;
  }, [onClose, ringOf, groups, gi]);

  // trocou de pessoa: o cartão entra deslizando do lado de onde veio
  useEffect(() => {
    const dir = Math.sign(gi - prevGi.current);
    prevGi.current = gi;
    if (!dir || !card.current || reduced()) return;
    card.current.animate(
      [{ transform: `translateX(${dir * 56}px) scale(.96)`, opacity: 0.3 }, { transform: "none", opacity: 1 }],
      { duration: 300, easing: OPEN_EASE },
    );
  }, [gi]);

  const go = useCallback(
    (dir: 1 | -1) => {
      setReady(false);
      if (dir === 1) {
        if (ii < items.length - 1) return setIi(ii + 1);
        if (gi < groups.length - 1) return (setGi(gi + 1), setIi(firstUnseen(groups[gi + 1]!)));
        return close();
      }
      if (ii > 0) return setIi(ii - 1);
      if (gi > 0) return (setGi(gi - 1), setIi(0));
      setIi(0);
    },
    [ii, gi, items.length, groups, close],
  );

  // visto: uma vez por status que não é meu
  useEffect(() => {
    if (item && !group.me && !item.seen) {
      item.seen = true;
      api(`/api/feed/status/${item.id}/view`, { method: "POST", headers: quiet }).catch(() => {});
    }
  }, [item, group.me]);

  useEffect(() => {
    if (!items.length) onClose();
  }, [items.length, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (viewers !== undefined) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === " ") (e.preventDefault(), setHeld((h) => !h));
    };
    window.addEventListener("keydown", onKey);
    box.current?.focus({ preventScroll: true });
    return () => window.removeEventListener("keydown", onKey);
  }, [go, close, viewers]);

  if (!item) return null;

  // puxar para baixo: o cartão acompanha o dedo, encolhe um pouco e o fundo vai clareando
  const follow = (dy: number) => {
    const c = card.current;
    const b = box.current;
    if (!c || !b) return;
    const d = Math.max(0, dy);
    c.style.transform = d ? `translateY(${d}px) scale(${1 - Math.min(d, 400) / 1600})` : "";
    b.style.backgroundColor = d ? `rgba(8, 8, 10, ${0.94 - Math.min(d, 400) / 700})` : "";
  };
  const down = (e: React.PointerEvent) => {
    press.current = { t: Date.now(), x: e.clientX, y: e.clientY, dy: 0 };
    setHeld(true);
  };
  const move = (e: React.PointerEvent) => {
    const p = press.current;
    if (!p) return;
    p.dy = e.clientY - p.y;
    if (p.dy > 6 && Math.abs(e.clientX - p.x) < 80) follow(p.dy);
  };
  const up = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    setHeld(false);
    if (!p) return;
    const dy = e.clientY - p.y;
    if (dy > 90 && Math.abs(e.clientX - p.x) < 80) return close();
    if (dy > 6 && card.current?.style.transform) {
      const c = card.current;
      const from0 = c.style.transform;
      follow(0);
      c.animate([{ transform: from0 }, { transform: "none" }], { duration: 280, easing: OPEN_EASE });
    }
    if (Date.now() - p.t > 260 || Math.abs(dy) > 14) return;
    const r = e.currentTarget.getBoundingClientRect();
    go(e.clientX - r.left < r.width * 0.32 ? -1 : 1);
  };

  const showViewers = async () => {
    setViewers(null);
    try {
      setViewers(await api<Person[]>(`/api/feed/status/${item.id}/viewers`));
    } catch {
      setViewers([]);
    }
  };
  const remove = async () => {
    setHeld(true);
    const ok = await confirmDialog({ title: "Apagar este status?", body: "Ele sai do ar agora para todo mundo.", confirmLabel: "Apagar", danger: true });
    setHeld(false);
    if (!ok) return;
    await api(`/api/feed/status/${item.id}`, { method: "DELETE" }).catch(() => {});
    setGone((g) => new Set(g).add(item.id));
    onDeleted();
  };
  // destaque: o status fica no perfil depois das 24 horas, até a pessoa tirar
  const isStar = item ? (starred[item.id] ?? Boolean(item.highlight)) : false;
  const star = async () => {
    const on = !isStar;
    haptic(on ? 12 : 6);
    setStarred((m) => ({ ...m, [item.id]: on }));
    try {
      await api(`/api/feed/status/${item.id}/highlight`, { method: "PUT", json: { on }, headers: quiet });
      onDeleted();
    } catch {
      setStarred((m) => ({ ...m, [item.id]: !on }));
    }
  };
  const reportIt = async () => {
    setHeld(true);
    const ok = await confirmDialog({ title: "Denunciar este status?", body: "O Planejai vai olhar e tirar do ar se não devia estar aqui.", confirmLabel: "Denunciar", danger: true });
    setHeld(false);
    if (ok) await api("/api/feed/report", { method: "POST", json: { kind: "status", id: item.id } }).catch(() => {});
  };

  const textCls = `rd-sv-text rd-font-${item.font || "classica"} rd-align-${item.align || "center"}`;
  return createPortal(
    <div className="rd-sv" role="dialog" aria-modal="true" aria-label={`Status de ${group.author.name}`} ref={box} tabIndex={-1}>
      <button type="button" className="rd-sv-side prev" onClick={() => go(-1)} aria-label="Anterior" disabled={gi === 0 && ii === 0}><Icon name="chevron-left" size={22} /></button>
      <div ref={card} className={`rd-sv-card rd-bg-${item.kind === "photo" ? "foto" : item.bg}`}>
        <div
          className="rd-sv-touch"
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={() => { press.current = null; setHeld(false); follow(0); }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {item.kind === "photo" && item.media && <img key={item.id} className="rd-sv-img" src={mediaUrl(item.media.id)} alt="" draggable={false} onLoad={() => setReady(true)} onError={() => setReady(true)} />}
          {item.body && (
            <p key={`${item.id}-t`} className={item.kind === "photo" ? "rd-sv-caption" : textCls} style={item.kind === "photo" ? undefined : { fontSize: statusFontSize(item.body.length) }}>
              {item.body}
            </p>
          )}
        </div>
        <div className={`rd-sv-top${held ? " dim" : ""}`}>
          <div className="rd-sv-bars" aria-hidden>
            {items.map((it, i) => (
              <span key={it.id}>
                {i < ii ? <i className="full" /> : i === ii ? <i key={`${it.id}-run`} className="run" style={{ animationDuration: `${STATUS_MS}ms`, animationPlayState: paused ? "paused" : "running" }} onAnimationEnd={() => go(1)} /> : null}
              </span>
            ))}
          </div>
          <div className="rd-sv-head">
            <Avatar who={group.author} size={36} me={group.me} link={false} />
            <Link to={profilePath(group.author.handle)} onClick={onClose}>
              <strong>{label ?? (group.me ? "Seu status" : group.author.name)}</strong>
              <span>{shortTime(item.created_at)}</span>
            </Link>
            <span className="spacer" />
            {!group.me && <button type="button" className="rd-sv-btn" onClick={reportIt} aria-label="Denunciar"><Icon name="more" size={20} /></button>}
            <button type="button" className="rd-sv-btn" onClick={close} aria-label="Fechar"><Icon name="x" size={20} /></button>
          </div>
        </div>
        {group.me && (
          <div className={`rd-sv-foot${held ? " dim" : ""}`}>
            <button type="button" className="rd-sv-pill" onClick={showViewers}>
              <Icon name="eye" size={16} /> {item.views ? `Visto por ${item.views}` : "Ninguém viu ainda"}
            </button>
            <span className="spacer" />
            <button type="button" className={`rd-sv-pill rd-sv-star${isStar ? " on" : ""}`} onClick={star} aria-pressed={isStar}>
              <Icon name="bookmark" size={15} /> {isStar ? "No perfil" : "Destacar"}
            </button>
            <button type="button" className="rd-sv-btn" onClick={remove} aria-label="Apagar status"><Icon name="trash" size={18} /></button>
          </div>
        )}
      </div>
      <button type="button" className="rd-sv-side next" onClick={() => go(1)} aria-label="Próximo"><Icon name="chevron-right" size={22} /></button>
      {viewers !== undefined && (
        <Modal title="Quem viu" onClose={() => setViewers(undefined)}>
          <PeopleList people={viewers} empty="Ninguém viu ainda. Quando alguém abrir, aparece aqui." onNavigate={onClose} />
        </Modal>
      )}
    </div>,
    document.body,
  );
}

const AlignIcon = ({ align }: { align: string }) => {
  const rows = align === "left" ? [[4, 20], [4, 14], [4, 17]] : align === "right" ? [[4, 20], [10, 20], [7, 20]] : [[4, 20], [7, 17], [5.5, 18.5]];
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      {rows.map(([a, b], i) => <line key={i} x1={a} x2={b} y1={7 + i * 5} y2={7 + i * 5} />)}
    </svg>
  );
};

/**
 * Editor de status em tela cheia, como nos apps de foto: o próprio cartão é a prévia. Em cima, fechar e as
 * ferramentas (letra, alinhamento, foto); embaixo, as cores (ou a legenda, com foto) e Publicar.
 */
export function StatusComposer({ onClose, onDone, highlight }: { onClose: () => void; onDone: () => void; /** já nasce como destaque do perfil */ highlight?: boolean }) {
  const [body, setBody] = useState("");
  const [bg, setBg] = useState<string>("roxo");
  const [font, setFont] = useState(0);
  const [align, setAlign] = useState(0);
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);
  const fontKey = STATUS_FONTS[font]![0];
  const alignKey = STATUS_ALIGNS[align]!;

  useLayoutEffect(() => {
    const b = box.current;
    if (!b || reduced()) return;
    b.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: "ease-out" });
    b.querySelector(".rd-se-card")?.animate([{ transform: "translateY(36px) scale(.94)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 360, easing: OPEN_EASE });
  }, []);

  const leave = useCallback((then: () => void) => {
    const b = box.current;
    if (leaving.current) return;
    leaving.current = true;
    if (!b || reduced()) return then();
    b.querySelector(".rd-se-card")?.animate([{ transform: "none", opacity: 1 }, { transform: "translateY(40px) scale(.94)", opacity: 0 }], { duration: 240, easing: CLOSE_EASE, fill: "forwards" });
    b.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, easing: "ease-in", fill: "forwards" }).onfinish = then;
  }, []);
  const cancel = useCallback(async () => {
    if ((body.trim() || photo) && !(await confirmDialog({ title: "Descartar este status?", body: "O que você escreveu não vai ser salvo.", confirmLabel: "Descartar", danger: true }))) return;
    leave(onClose);
  }, [body, photo, leave, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && void cancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel]);

  // a caixa de texto cresce com o texto, sempre no meio do cartão
  useLayoutEffect(() => {
    const t = text.current;
    if (!t) return;
    t.style.height = "0px";
    t.style.height = `${t.scrollHeight}px`;
  }, [body, font, photo]);

  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 1100);
    return () => window.clearTimeout(id);
  }, [toast]);

  const choose = async (f?: File) => {
    if (!f) return;
    setError(null);
    setLoading(true);
    try {
      setPhoto(await pickPhoto(f));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const nextFont = () => {
    const n = (font + 1) % STATUS_FONTS.length;
    haptic(5);
    setFont(n);
    setToast(STATUS_FONTS[n]![1]);
  };
  const nextAlign = () => {
    haptic(5);
    setAlign((a) => (a + 1) % STATUS_ALIGNS.length);
  };
  const send = async () => {
    if (busy || (!body.trim() && !photo)) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/feed/status", {
        method: "POST",
        json: { body, bg, font: fontKey, align: alignKey, photo: photo ? { base64: photo.base64, width: photo.width, height: photo.height } : undefined, highlight: highlight || undefined },
      });
      haptic(12);
      leave(onDone);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const left = STATUS_MAX - body.length;
  const can = !busy && (!!body.trim() || !!photo);
  return createPortal(
    <div className="rd-se" role="dialog" aria-modal="true" aria-label="Novo status" ref={box}>
      <div className="rd-se-top">
        <button type="button" className="rd-se-ico" onClick={() => void cancel()} aria-label="Fechar"><Icon name="x" size={22} /></button>
        <span className="spacer" />
        {!photo && (
          <>
            <button type="button" className="rd-se-ico rd-se-aa" onClick={nextFont} aria-label={`Letra: ${STATUS_FONTS[font]![1]}. Trocar`}>
              <span className={`rd-font-${fontKey}`}>Aa</span>
            </button>
            <button type="button" className="rd-se-ico" onClick={nextAlign} aria-label="Alinhamento do texto"><AlignIcon align={alignKey} /></button>
          </>
        )}
        <button type="button" className="rd-se-ico" onClick={() => file.current?.click()} aria-label={photo ? "Trocar a foto" : "Escolher foto"}><Icon name="image" size={21} /></button>
        <input ref={file} type="file" accept="image/*" className="rd-file" tabIndex={-1} aria-hidden onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
      </div>

      <div className={`rd-se-card rd-bg-${photo ? "foto" : bg}`} onClick={() => !photo && text.current?.focus()}>
        {photo ? (
          <>
            <img className="rd-se-img" src={photo.preview} alt="" />
            <button type="button" className="rd-se-ico rd-se-rm" onClick={() => setPhoto(null)} aria-label="Tirar a foto"><Icon name="trash" size={18} /></button>
          </>
        ) : (
          <textarea
            ref={text}
            className={`rd-se-text rd-font-${fontKey} rd-align-${alignKey}`}
            style={{ fontSize: statusFontSize(body.length) }}
            value={body}
            rows={1}
            maxLength={STATUS_MAX}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Escreva algo"
            aria-label="Texto do status"
            autoFocus
          />
        )}
        {loading && <span className="rd-se-wait" aria-label="Preparando a foto" />}
        {toast && <span className="rd-se-toast" key={toast}>{toast}</span>}
      </div>

      <div className="rd-se-bottom">
        {photo ? (
          <input className="rd-se-caption" value={body} maxLength={STATUS_MAX} onChange={(e) => setBody(e.target.value)} placeholder="Escreva uma legenda" aria-label="Legenda" />
        ) : (
          <div className="rd-se-bgs" role="radiogroup" aria-label="Cor de fundo">
            {STATUS_BGS.map((b) => (
              <button key={b} type="button" role="radio" aria-checked={bg === b} aria-label={b} className={`rd-bg-${b}${bg === b ? " on" : ""}`} onClick={() => { haptic(5); setBg(b); }} />
            ))}
          </div>
        )}
        {error && <div className="rd-se-err">{error}</div>}
        <div className="rd-se-send">
          <span className={`rd-se-left${left < 20 ? " low" : ""}`}>{body.length ? `${left}` : highlight ? "Fica no seu perfil" : "Some em 24 horas"}</span>
          <button type="button" className="btn btn-brand rd-se-go" disabled={!can} onClick={send}>
            {busy ? "Publicando…" : "Publicar"} <Icon name="arrow-up" size={16} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

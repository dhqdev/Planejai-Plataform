import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { api } from "../api";
import { confirmDialog, Modal } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";
import { Avatar, mediaUrl, PeopleList, pickPhoto, profilePath, shortTime, STATUS_BGS, STATUS_MAX, useRede, type Person, type PickedPhoto, type StatusGroup } from "./redeBase";

/**
 * Status da rede (somem em 24h): a fileira de bolinhas em cima do feed, a tela de assistir (barrinhas de progresso,
 * toque para passar, segurar para pausar, puxar para baixo para fechar) e a folha de criar (texto sobre cor ou foto).
 */

const STATUS_MS = 5200;
const quiet = { "x-pj-quiet": "1" };

export function StatusRow() {
  const { profile } = useRede();
  const list = useApi<StatusGroup[]>("/api/feed/status", { poll: 60_000 });
  const [open, setOpen] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const groups = list.data ?? [];
  const mine = groups.findIndex((g) => g.me);

  // quem ainda não criou o perfil só assiste: sem bolinha própria e sem fileira vazia
  if (!profile && !groups.length) return null;
  return (
    <div className="rd-status" role="list" aria-label="Status">
      {profile && (
      <div className="rd-st" role="listitem">
        <button
          type="button"
          className={`rd-st-ring${mine >= 0 ? " seen" : " none"}`}
          onClick={() => { haptic(6); mine >= 0 ? setOpen(mine) : setCreating(true); }}
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
            <button type="button" className={`rd-st-ring${g.seen ? " seen" : ""}`} onClick={() => { haptic(6); setOpen(i); }} aria-label={`Status de ${g.author.name}${g.seen ? "" : ", novo"}`}>
              <Avatar who={g.author} size={58} link={false} />
            </button>
            <span>{g.author.official ? g.author.name : g.author.name.split(" ")[0]}</span>
          </div>
        ),
      )}
      {open != null && groups[open] && (
        <StatusViewer
          groups={groups}
          start={open}
          onClose={() => { setOpen(null); void list.reload(); }}
          onDeleted={() => void list.reload()}
        />
      )}
      {creating && <StatusComposer onClose={() => setCreating(false)} onDone={() => { setCreating(false); void list.reload(); }} />}
    </div>
  );
}

function StatusViewer({ groups, start, onClose, onDeleted }: { groups: StatusGroup[]; start: number; onClose: () => void; onDeleted: () => void }) {
  const firstUnseen = (g: StatusGroup) => Math.max(0, g.items.findIndex((it) => !it.seen));
  const [gi, setGi] = useState(start);
  const [ii, setIi] = useState(() => firstUnseen(groups[start]!));
  const [held, setHeld] = useState(false);
  const [ready, setReady] = useState(false);
  const [viewers, setViewers] = useState<Person[] | null | undefined>(undefined);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const press = useRef<{ t: number; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const group = groups[gi]!;
  const items = group.items.filter((it) => !gone.has(it.id));
  const item = items[Math.min(ii, items.length - 1)];
  const paused = held || viewers !== undefined || (item?.kind === "photo" && !ready);

  const go = useCallback(
    (dir: 1 | -1) => {
      setReady(false);
      if (dir === 1) {
        if (ii < items.length - 1) return setIi(ii + 1);
        if (gi < groups.length - 1) return (setGi(gi + 1), setIi(firstUnseen(groups[gi + 1]!)));
        return onClose();
      }
      if (ii > 0) return setIi(ii - 1);
      if (gi > 0) return (setGi(gi - 1), setIi(0));
      setIi(0);
    },
    [ii, gi, items.length, groups, onClose],
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
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === " ") (e.preventDefault(), setHeld((h) => !h));
    };
    window.addEventListener("keydown", onKey);
    box.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [go, onClose, viewers]);

  if (!item) return null;

  const down = (e: React.PointerEvent) => {
    press.current = { t: Date.now(), x: e.clientX, y: e.clientY };
    setHeld(true);
  };
  const up = (e: React.PointerEvent) => {
    const p = press.current;
    press.current = null;
    setHeld(false);
    if (!p) return;
    const dy = e.clientY - p.y;
    if (dy > 90 && Math.abs(e.clientX - p.x) < 80) return onClose();
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
  const reportIt = async () => {
    setHeld(true);
    const ok = await confirmDialog({ title: "Denunciar este status?", body: "O Planejai vai olhar e tirar do ar se não devia estar aqui.", confirmLabel: "Denunciar", danger: true });
    setHeld(false);
    if (ok) await api("/api/feed/report", { method: "POST", json: { kind: "status", id: item.id } }).catch(() => {});
  };

  return createPortal(
    <div className="rd-sv" role="dialog" aria-modal="true" aria-label={`Status de ${group.author.name}`} ref={box} tabIndex={-1}>
      <button type="button" className="rd-sv-side prev" onClick={() => go(-1)} aria-label="Anterior" disabled={gi === 0 && ii === 0}><Icon name="chevron-left" size={22} /></button>
      <div className={`rd-sv-card rd-bg-${item.kind === "photo" ? "foto" : item.bg}`}>
        <div className="rd-sv-touch" onPointerDown={down} onPointerUp={up} onPointerCancel={() => { press.current = null; setHeld(false); }} onContextMenu={(e) => e.preventDefault()}>
          {item.kind === "photo" && item.media && <img key={item.id} src={mediaUrl(item.media.id)} alt="" draggable={false} onLoad={() => setReady(true)} onError={() => setReady(true)} />}
          {item.body && <p className={item.kind === "photo" ? "rd-sv-caption" : `rd-sv-text${item.body.length > 110 ? " long" : ""}`}>{item.body}</p>}
        </div>
        <div className="rd-sv-top">
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
              <strong>{group.me ? "Seu status" : group.author.name}</strong>
              <span>{shortTime(item.created_at)}</span>
            </Link>
            <span className="spacer" />
            {!group.me && <button type="button" className="rd-sv-btn" onClick={reportIt} aria-label="Denunciar"><Icon name="more" size={20} /></button>}
            <button type="button" className="rd-sv-btn" onClick={onClose} aria-label="Fechar"><Icon name="x" size={20} /></button>
          </div>
        </div>
        {group.me && (
          <div className="rd-sv-foot">
            <button type="button" className="rd-sv-pill" onClick={showViewers}>
              <Icon name="eye" size={16} /> {item.views ? `Visto por ${item.views}` : "Ninguém viu ainda"}
            </button>
            <span className="spacer" />
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

export function StatusComposer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [body, setBody] = useState("");
  const [bg, setBg] = useState<string>("roxo");
  const [photo, setPhoto] = useState<PickedPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const choose = async (f?: File) => {
    if (!f) return;
    setError(null);
    try {
      setPhoto(await pickPhoto(f));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const send = async () => {
    if (busy || (!body.trim() && !photo)) return;
    setBusy(true);
    setError(null);
    try {
      await api("/api/feed/status", { method: "POST", json: { body, bg, photo: photo ? { base64: photo.base64, width: photo.width, height: photo.height } : undefined } });
      haptic(12);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Novo status"
      onClose={onClose}
      className="rd-sc-modal"
      footer={(close) => (
        <>
          <button type="button" className="btn" onClick={close}>Cancelar</button>
          <button type="button" className="btn btn-brand" disabled={busy || (!body.trim() && !photo)} onClick={send}>{busy ? "Publicando…" : "Publicar"}</button>
        </>
      )}
    >
      <div className={`rd-sc-card rd-bg-${photo ? "foto" : bg}`}>
        {photo ? (
          <>
            <img src={photo.preview} alt="" />
            <button type="button" className="rd-sc-x" onClick={() => setPhoto(null)} aria-label="Tirar a foto"><Icon name="x" size={16} /></button>
            <input className="rd-sc-caption" value={body} maxLength={STATUS_MAX} onChange={(e) => setBody(e.target.value)} placeholder="Escreva uma legenda" aria-label="Legenda" />
          </>
        ) : (
          <textarea value={body} maxLength={STATUS_MAX} onChange={(e) => setBody(e.target.value)} placeholder="O que você quer contar?" aria-label="Texto do status" autoFocus />
        )}
      </div>
      <div className="rd-sc-tools">
        {!photo && (
          <div className="rd-sc-bgs" role="radiogroup" aria-label="Cor de fundo">
            {STATUS_BGS.map((b) => (
              <button key={b} type="button" role="radio" aria-checked={bg === b} aria-label={b} className={`rd-bg-${b}${bg === b ? " on" : ""}`} onClick={() => { haptic(5); setBg(b); }} />
            ))}
          </div>
        )}
        <span className="spacer" />
        <button type="button" className="btn btn-sm" onClick={() => file.current?.click()}><Icon name="image" size={16} /> {photo ? "Trocar foto" : "Foto"}</button>
        <input ref={file} type="file" accept="image/*" hidden onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {error && <div className="error-box">{error}</div>}
      <p className="rd-hint">Fica no ar por 24 horas e aparece para quem está na rede. Só você vê quem abriu.</p>
    </Modal>
  );
}

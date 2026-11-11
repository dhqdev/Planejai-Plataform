import { createContext, useContext, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import type { Outfit } from "../mascote/Mascote";
import { UserMascote } from "../mascote/UserMascote";
import { haptic } from "../touch";

/** Peças comuns da rede social (pages/Rede.tsx e pages/RedeStatus.tsx): tipos, avatar, texto, tempo e fotos. */

export interface Author {
  id: string;
  handle: string;
  name: string;
  outfit: Outfit | null;
}
export interface Person extends Author {
  bio: string;
  following: boolean;
  me: boolean;
}
export interface Profile extends Author {
  bio: string;
  since: string;
  posts: number;
  followers: number;
  following: number;
  me: boolean;
  iFollow: boolean;
  followsMe: boolean;
  blocked: boolean;
}
export interface Photo {
  id: string;
  w: number;
  h: number;
}
export interface Post {
  id: string;
  body: string;
  created_at: string;
  author: Author;
  media: Photo[];
  likes: number;
  comments: number;
  liked: boolean;
  mine: boolean;
}
export interface Comment {
  id: string;
  body: string;
  created_at: string;
  author: Author;
  mine: boolean;
  canDelete: boolean;
}
export interface StatusItem {
  id: string;
  kind: "text" | "photo";
  body: string;
  bg: string;
  media: Photo | null;
  created_at: string;
  seen: boolean;
  views?: number;
}
export interface StatusGroup {
  author: Author;
  me: boolean;
  seen: boolean;
  items: StatusItem[];
}

export const POST_MAX = 500;
export const COMMENT_MAX = 300;
export const STATUS_MAX = 220;
export const BIO_MAX = 160;
export const MAX_PHOTOS = 4;
export const STATUS_BGS = ["tinta", "roxo", "magenta", "ceu", "mata", "sol"] as const;

export const mediaUrl = (id: string) => `/api/feed/media/${id}`;
export const profilePath = (handle: string) => `/rede/u/${handle}`;

/** Quem está usando a rede (perfil já criado) e se pode moderar. */
export const RedeMe = createContext<{ profile: Profile; isSuper: boolean; unread: number; reload: () => void } | null>(null);
export const useRede = () => useContext(RedeMe)!;

const DAY_MONTH = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" });
const DAY_MONTH_YEAR = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short", year: "numeric" });
/** Tempo curto, no jeito das redes: agora, 5 min, 3 h, 2 d e depois a data. */
export function shortTime(iso: string) {
  const d = new Date(iso);
  const s = Math.max(0, Math.round((Date.now() - d.getTime()) / 1000));
  if (s < 45) return "agora";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d`;
  return (d.getFullYear() === new Date().getFullYear() ? DAY_MONTH : DAY_MONTH_YEAR).format(d).replace(".", "");
}

export const count = (n: number) => (n >= 10000 ? `${Math.round(n / 1000)} mil` : n >= 1000 ? `${(n / 1000).toFixed(1).replace(".", ",").replace(",0", "")} mil` : String(n));

export function Avatar({ who, size = 40, me = false, link = true }: { who: Author; size?: number; me?: boolean; link?: boolean }) {
  const face = <UserMascote name={who.name} outfit={who.outfit} seed={who.id} size={size} me={me} />;
  if (!link) return face;
  return (
    <Link to={profilePath(who.handle)} className="rd-avatar" aria-label={`Perfil de ${who.name}`} onClick={(e) => e.stopPropagation()}>
      {face}
    </Link>
  );
}

const TOKEN = /(@[a-z0-9][a-z0-9._]{2,19}|https?:\/\/[^\s<>"']+)/gi;
/** Texto de post/comentário: @ vira link para o perfil e endereço http(s) abre em outra aba. Nada de HTML. */
export function RichText({ text }: { text: string }) {
  const parts = text.split(TOKEN);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 0) return part;
        if (part.startsWith("@")) {
          const handle = part.slice(1).replace(/[._]+$/, "").toLowerCase();
          return (
            <Link key={i} className="rd-link" to={profilePath(handle)} onClick={(e) => e.stopPropagation()}>
              {part}
            </Link>
          );
        }
        const url = part.replace(/[.,;:!?)]+$/, "");
        return (
          <span key={i}>
            <a className="rd-link" href={url} target="_blank" rel="noopener noreferrer nofollow" onClick={(e) => e.stopPropagation()}>
              {url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
            </a>
            {part.slice(url.length)}
          </span>
        );
      })}
    </>
  );
}

export interface PickedPhoto {
  base64: string;
  width: number;
  height: number;
  preview: string;
}

/**
 * Foto escolhida no aparelho: reduz para no máximo 1600px e JPEG (baixa a qualidade até caber em ~1,4 MB),
 * o que também tira localização e outros dados escondidos do arquivo original.
 */
export async function pickPhoto(file: File): Promise<PickedPhoto> {
  if (!file.type.startsWith("image/")) throw new Error("Escolha uma foto.");
  let bitmap: ImageBitmap | HTMLImageElement;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" } as ImageBitmapOptions);
  } catch {
    const url = URL.createObjectURL(file);
    try {
      bitmap = await new Promise<HTMLImageElement>((ok, fail) => {
        const img = new Image();
        img.onload = () => ok(img);
        img.onerror = () => fail(new Error("Não consegui abrir essa foto."));
        img.src = url;
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Não consegui preparar a foto.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  let data = "";
  for (const q of [0.84, 0.72, 0.6, 0.45]) {
    data = canvas.toDataURL("image/jpeg", q);
    if (data.length * 0.75 < 1_400_000) break;
  }
  return { base64: data.slice(data.indexOf(",") + 1), width, height, preview: data };
}

/** Botão Seguir/Seguindo (muda na hora; se a rede recusar, volta). */
export function FollowButton({ handle, following, onChange, small }: { handle: string; following: boolean; onChange?: (on: boolean) => void; small?: boolean }) {
  const [on, setOn] = useState(following);
  const [busy, setBusy] = useState(false);
  const toggle = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    const next = !on;
    haptic(8);
    setOn(next);
    setBusy(true);
    try {
      await api(`/api/feed/u/${handle}/follow`, { method: next ? "POST" : "DELETE", headers: { "x-pj-quiet": "1" } });
      onChange?.(next);
    } catch {
      setOn(!next);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button type="button" className={`rd-follow${on ? " on" : ""}${small ? " sm" : ""}`} onClick={toggle} aria-pressed={on}>
      {on ? "Seguindo" : "Seguir"}
    </button>
  );
}

export function PersonRow({ p, extra, onNavigate }: { p: Person; extra?: ReactNode; onNavigate?: () => void }) {
  return (
    <div className="rd-person">
      <Avatar who={p} size={44} />
      <Link to={profilePath(p.handle)} className="rd-person-txt" onClick={onNavigate}>
        <strong>{p.name}</strong>
        <span>@{p.handle}</span>
        {p.bio && <em>{p.bio}</em>}
      </Link>
      {extra ?? (!p.me && <FollowButton handle={p.handle} following={p.following} small />)}
    </div>
  );
}

export function PeopleList({ people, empty, onNavigate }: { people: Person[] | null; empty: string; onNavigate?: () => void }) {
  if (!people) return <div className="rd-wait" aria-busy="true" />;
  if (!people.length) return <p className="rd-none">{empty}</p>;
  return (
    <div className="rd-people">
      {people.map((p) => (
        <PersonRow key={p.id} p={p} onNavigate={onNavigate} />
      ))}
    </div>
  );
}

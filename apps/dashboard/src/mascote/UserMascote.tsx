import { Mascote, type Outfit } from "./Mascote";
import { MASCOTE } from "./nome";
import { LOOKS } from "./Parade";
import { useMascoteMood, useOutfit } from "./state";

/** Visual de quem nunca abriu o guarda-roupa: sempre o mesmo para a mesma pessoa (tirado do id). */
export function defaultOutfit(seed: string | null | undefined): Outfit {
  let h = 0;
  for (const ch of String(seed ?? "")) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return LOOKS[Math.abs(h) % LOOKS.length]!.outfit;
}

/**
 * Avatar de uma pessoa: o Mascote dela, com a roupinha que ela escolheu, numa bolinha escura (a noite do Mascote).
 * Ninguém sobe foto. `me` usa a roupinha e o humor ao vivo da própria conta; para os outros vale o `outfit`
 * que a API manda (null = nunca escolheu, veste um visual pelo `seed`).
 */
export function UserMascote({ name, outfit, seed, size = 32, me = false }: { name?: string | null; outfit?: Outfit | null; seed?: string | null; size?: number; me?: boolean }) {
  const label = `${MASCOTE} de ${name?.trim() || "alguém"}`;
  const art = Math.round(size * 0.92);
  return (
    <span className="user-mascote" style={{ width: size, height: size, paddingBottom: Math.round(size * 0.06) }} role="img" aria-label={label} title={name ?? undefined}>
      {me ? <MyMascote size={art} /> : <Mascote size={art} outfit={outfit ?? defaultOutfit(seed ?? name)} still crop title={label} />}
    </span>
  );
}

function MyMascote({ size }: { size: number }) {
  const mood = useMascoteMood();
  const [outfit] = useOutfit();
  return <Mascote size={size} outfit={outfit} mood={mood} crop />;
}

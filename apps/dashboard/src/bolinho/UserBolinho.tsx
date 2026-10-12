import { Bolinho, type Outfit } from "./Bolinho";
import { LOOKS } from "./Parade";
import { useBolinhoMood, useOutfit } from "./state";

/** Visual de quem nunca abriu o guarda-roupa: sempre o mesmo para a mesma pessoa (tirado do id). */
export function defaultOutfit(seed: string | null | undefined): Outfit {
  let h = 0;
  for (const ch of String(seed ?? "")) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return LOOKS[Math.abs(h) % LOOKS.length]!.outfit;
}

/**
 * Avatar de uma pessoa: o Bolinho dela, com a roupinha que ela escolheu, numa bolinha escura (a noite do Bolinho).
 * Ninguém sobe foto. `me` usa a roupinha e o humor ao vivo da própria conta; para os outros vale o `outfit`
 * que a API manda (null = nunca escolheu, veste um visual pelo `seed`).
 */
export function UserBolinho({ name, outfit, seed, size = 32, me = false }: { name?: string | null; outfit?: Outfit | null; seed?: string | null; size?: number; me?: boolean }) {
  const label = `Bolinho de ${name?.trim() || "alguém"}`;
  const art = Math.round(size * 0.92);
  return (
    <span className="user-bolinho" style={{ width: size, height: size, paddingBottom: Math.round(size * 0.06) }} role="img" aria-label={label} title={name ?? undefined}>
      {me ? <MyBolinho size={art} /> : <Bolinho size={art} outfit={outfit ?? defaultOutfit(seed ?? name)} still crop title={label} />}
    </span>
  );
}

function MyBolinho({ size }: { size: number }) {
  const mood = useBolinhoMood();
  const [outfit] = useOutfit();
  return <Bolinho size={size} outfit={outfit} mood={mood} crop />;
}

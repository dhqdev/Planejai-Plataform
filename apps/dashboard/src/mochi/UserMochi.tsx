import { Mochi, type Outfit } from "./Mochi";
import { LOOKS } from "./Parade";
import { useMochiMood, useOutfit } from "./state";

/** Visual de quem nunca abriu o guarda-roupa: sempre o mesmo para a mesma pessoa (tirado do id). */
export function defaultOutfit(seed: string | null | undefined): Outfit {
  let h = 0;
  for (const ch of String(seed ?? "")) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return LOOKS[Math.abs(h) % LOOKS.length]!.outfit;
}

/**
 * Avatar de uma pessoa: o Mochi dela, com a roupinha que ela escolheu, numa bolinha escura (a noite do Mochi).
 * Ninguém sobe foto. `me` usa a roupinha e o humor ao vivo da própria conta; para os outros vale o `outfit`
 * que a API manda (null = nunca escolheu, veste um visual pelo `seed`).
 */
export function UserMochi({ name, outfit, seed, size = 32, me = false }: { name?: string | null; outfit?: Outfit | null; seed?: string | null; size?: number; me?: boolean }) {
  const label = `Mochi de ${name?.trim() || "alguém"}`;
  const art = Math.round(size * 0.92);
  return (
    <span className="user-mochi" style={{ width: size, height: size }} role="img" aria-label={label} title={name ?? undefined}>
      {me ? <MyMochi size={art} /> : <Mochi size={art} outfit={outfit ?? defaultOutfit(seed ?? name)} still crop title={label} />}
    </span>
  );
}

function MyMochi({ size }: { size: number }) {
  const mood = useMochiMood();
  const [outfit] = useOutfit();
  return <Mochi size={size} outfit={outfit} mood={mood} crop />;
}

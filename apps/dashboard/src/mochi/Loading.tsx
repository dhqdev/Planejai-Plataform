import { Mochi } from "./Mochi";
import { useOutfit } from "./state";

/** Carregando: o Mochi pensando. */
export function MochiLoading({ text = "Carregando…" }: { text?: string }) {
  const [outfit] = useOutfit();
  return (
    <div className="mochi-loading" role="status">
      <Mochi mood="thinking" outfit={outfit} size={72} />
      {text}
    </div>
  );
}

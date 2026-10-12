import { useEffect, useState } from "react";
import { Modal } from "../components";
import { haptic } from "../touch";
import { ITEMS, MOODS, Mochi, MochiTile, SLOTS, type Mood, type Outfit } from "./Mochi";
import { openWardrobe, useMochiLife, useMochiMood, useOutfit } from "./state";

/** O Mochi do app (barra lateral, topo, menu). Tocar nele abre o guarda-roupa. */
export function MochiButton({ size = 34 }: { size?: number }) {
  const mood = useMochiMood();
  const [outfit] = useOutfit();
  return (
    <button type="button" className="mochi-badge" onClick={() => { haptic(8); openWardrobe(); }} aria-label="Mochi: trocar roupinha" title="Mochi">
      <Mochi mood={mood} outfit={outfit} size={size} crop />
    </button>
  );
}

/** Só o desenho, vestido e com o humor do momento (para tiles e menus). */
export function MochiIcon({ size = 40 }: { size?: number }) {
  const mood = useMochiMood();
  const [outfit] = useOutfit();
  return <Mochi mood={mood} outfit={outfit} size={size} crop />;
}

/** Guarda-roupa: montado uma vez no app, abre com openWardrobe(). */
export function WardrobeHost() {
  useMochiLife();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("pj:mochi-open", on);
    return () => window.removeEventListener("pj:mochi-open", on);
  }, []);
  return open ? <Wardrobe onClose={() => setOpen(false)} /> : null;
}

function Wardrobe({ onClose }: { onClose: () => void }) {
  const [outfit, setOutfit] = useOutfit();
  const [preview, setPreview] = useState<Mood>("idle");

  const wear = (slot: keyof Outfit, id: string | undefined) => {
    haptic(10);
    const next: Outfit = { ...outfit };
    if (!id || next[slot] === id) delete next[slot];
    else next[slot] = id;
    setOutfit(next);
    setPreview(id && next[slot] ? "happy" : "idle");
  };

  const label = MOODS.find((m) => m.id === preview)?.label ?? "";
  const wearing = ITEMS.filter((i) => outfit[i.slot] === i.id).map((i) => i.label);

  return (
    <Modal title="Mochi" onClose={onClose} wide>
      <div className="mochi-stage">
        <Mochi mood={preview} outfit={outfit} size={200} />
        <div className="mochi-stage-label">
          {label}
          <small>{wearing.length ? wearing.join(" · ") : "sem roupinha"}</small>
        </div>
      </div>

      {SLOTS.map((slot) => (
        <div key={slot.id}>
          <div className="mochi-section">{slot.label}</div>
          <div className="mochi-grid">
            <MochiTile label="nada" active={!outfit[slot.id]} onClick={() => wear(slot.id, undefined)}>
              <span className="mochi-none">∅</span>
            </MochiTile>
            {ITEMS.filter((i) => i.slot === slot.id).map((item) => (
              <MochiTile key={item.id} label={item.label.toLowerCase()} active={outfit[slot.id] === item.id} onClick={() => wear(slot.id, item.id)}>
                <Mochi size={74} still outfit={{ ...outfit, [slot.id]: item.id }} />
              </MochiTile>
            ))}
          </div>
        </div>
      ))}

      <div className="mochi-section">Expressões</div>
      <p className="muted" style={{ margin: "-4px 0 10px", fontSize: 12.5 }}>
        Ele fala com os olhos: procura enquanto salva, sorri quando dá certo e cochila se você some. Toque nele para ver a reação.
      </p>
      <div className="mochi-grid">
        {MOODS.map((m) => (
          <MochiTile key={m.id} label={m.label} active={preview === m.id} onClick={() => { haptic(6); setPreview(m.id); }}>
            <Mochi size={74} mood={m.id} outfit={{ ...outfit, eyes: undefined }} still={preview !== m.id} />
          </MochiTile>
        ))}
      </div>
    </Modal>
  );
}

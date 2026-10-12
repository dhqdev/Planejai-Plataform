import { useEffect, useState } from "react";
import { Modal } from "../components";
import { haptic } from "../touch";
import { ITEMS, MOODS, Bolinho, BolinhoTile, SLOTS, type Mood, type Outfit } from "./Bolinho";
import { openWardrobe, useBolinhoLife, useBolinhoMood, useOutfit } from "./state";

/** O Bolinho do app (barra lateral, topo, menu). Tocar nele abre o guarda-roupa. */
export function BolinhoButton({ size = 34 }: { size?: number }) {
  const mood = useBolinhoMood();
  const [outfit] = useOutfit();
  return (
    <button type="button" className="bolinho-badge" onClick={() => { haptic(8); openWardrobe(); }} aria-label="Bolinho: trocar roupinha" title="Bolinho">
      <Bolinho mood={mood} outfit={outfit} size={size} crop />
    </button>
  );
}

/** Só o desenho, vestido e com o humor do momento (para tiles e menus). */
export function BolinhoIcon({ size = 40 }: { size?: number }) {
  const mood = useBolinhoMood();
  const [outfit] = useOutfit();
  return <Bolinho mood={mood} outfit={outfit} size={size} crop />;
}

/** Guarda-roupa: montado uma vez no app, abre com openWardrobe(). */
export function WardrobeHost() {
  useBolinhoLife();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener("pj:bolinho-open", on);
    return () => window.removeEventListener("pj:bolinho-open", on);
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
    <Modal title="Bolinho" onClose={onClose} wide>
      <div className="bolinho-stage">
        <Bolinho mood={preview} outfit={outfit} size={200} />
        <div className="bolinho-stage-label">
          {label}
          <small>{wearing.length ? wearing.join(" · ") : "sem roupinha"}</small>
        </div>
      </div>

      {SLOTS.map((slot) => (
        <div key={slot.id}>
          <div className="bolinho-section">{slot.label}</div>
          <div className="bolinho-grid">
            <BolinhoTile label="nada" active={!outfit[slot.id]} onClick={() => wear(slot.id, undefined)}>
              <span className="bolinho-none">∅</span>
            </BolinhoTile>
            {ITEMS.filter((i) => i.slot === slot.id).map((item) => (
              <BolinhoTile key={item.id} label={item.label.toLowerCase()} active={outfit[slot.id] === item.id} onClick={() => wear(slot.id, item.id)}>
                <Bolinho size={74} still outfit={{ ...outfit, [slot.id]: item.id }} />
              </BolinhoTile>
            ))}
          </div>
        </div>
      ))}

      <div className="bolinho-section">Expressões</div>
      <p className="muted" style={{ margin: "-4px 0 10px", fontSize: 12.5 }}>
        Ele vira a cabeça atrás do mouse, procura enquanto salva, dá cambalhota quando dá certo e boceja antes de cochilar. Toque nele e ele faz cara feia; três toques seguidos e ele fica tonto. Deixe o mouse em cima um pouquinho e ele se apaixona.
      </p>
      <div className="bolinho-grid">
        {MOODS.map((m) => (
          <BolinhoTile key={m.id} label={m.label} active={preview === m.id} onClick={() => { haptic(6); setPreview(m.id); }}>
            <Bolinho size={74} mood={m.id} outfit={{ ...outfit, eyes: undefined }} still={preview !== m.id} />
          </BolinhoTile>
        ))}
      </div>
    </Modal>
  );
}

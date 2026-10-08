import { useState } from "react";
import { Json } from "../../components";
import { Icon } from "../../icons";
import { tok, usdBR } from "./format";
import { shortModel } from "./labels";
import type { Step } from "./steps";

/* Pedaços de um passo que a História e o Canvas mostram igual: erro, etiquetas de custo e entrada/saída. */

export function ErrorText({ text }: { text: string }) {
  const [first, ...rest] = String(text).split("\n");
  const [open, setOpen] = useState(false);
  return (
    <div className="tl-error">
      <Icon name="x" size={13} />
      <div>
        <strong>{first}</strong>
        {rest.join("").trim() && (
          <>
            <button className="tl-link" onClick={() => setOpen(!open)}>{open ? "esconder detalhes" : "ver detalhes"}</button>
            {open && <pre>{rest.join("\n")}</pre>}
          </>
        )}
      </div>
    </div>
  );
}

export function Chips({ s }: { s: Step }) {
  return (
    <span className="tl-chips">
      {s.model && <span className="tl-chip mono">{shortModel(s.model)}</span>}
      {Number(s.tokens_in) + Number(s.tokens_out) > 0 && <span className="tl-chip mono">{tok(s.tokens_in)} → {tok(s.tokens_out)}</span>}
      {Number(s.cost_usd) > 0 && <span className="tl-chip mono">{usdBR(s.cost_usd)}</span>}
    </span>
  );
}

export function IO({ step }: { step: Step }) {
  return (
    <div className="tl-io">
      <div>
        <small>Entrada</small>
        <Json value={step.input} />
      </div>
      <div>
        <small>Saída</small>
        <Json value={step.output} />
      </div>
    </div>
  );
}

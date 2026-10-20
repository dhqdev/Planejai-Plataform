/** O que cada plano dá e o que não dá (a lista vem do servidor, em pricing.features: plan-features.ts). */
export type PlanLevel = "basico" | "time" | "completo";
export interface PlanFeature {
  label: string;
  short: string;
  values: [boolean | string, boolean | string, boolean | string];
}

const LEVELS: PlanLevel[] = ["basico", "time", "completo"];
const idx = (level?: string) => Math.max(0, LEVELS.indexOf((level as PlanLevel) ?? "time"));

/** O que o plano tem neste item: false (não tem), true ou um texto ("até 2"). */
export const featureAt = (f: PlanFeature, level?: string) => f.values[idx(level)];

/** Itens que o plano não inclui. */
export const lacksOf = (features: PlanFeature[] | undefined, level?: string) => (features ?? []).filter((f) => !featureAt(f, level));

/** Itens que se perdem ao ir de um plano para outro (descer) ou que se ganham (subir). */
export const diffOf = (features: PlanFeature[] | undefined, from?: string, to?: string) => {
  const list = features ?? [];
  return {
    gain: list.filter((f) => !featureAt(f, from) && featureAt(f, to)),
    lose: list.filter((f) => featureAt(f, from) && !featureAt(f, to)),
  };
};

/** "Não inclui: ..." num cartão de plano. Plano que tem tudo não mostra nada. */
export function Lacks({ features, level, className = "" }: { features?: PlanFeature[]; level?: string; className?: string }) {
  const lacks = lacksOf(features, level);
  if (!lacks.length) return null;
  return (
    <p className={`plan-lacks ${className}`}>
      <b>Não inclui:</b> {lacks.map((f) => f.short).join(", ")}.
    </p>
  );
}

/** Frase para o aviso de troca de plano: o que ela ganha ou perde. */
export function changeNote(features: PlanFeature[] | undefined, from?: string, to?: string) {
  const { gain, lose } = diffOf(features, from, to);
  const names = (l: PlanFeature[]) => l.map((f) => f.short).join(", ");
  if (lose.length) return ` Atenção: quando a troca valer você deixa de ter ${names(lose)}. Especialista que estiver ligado fica pausado até você subir de novo.`;
  if (gain.length) return ` Quando a troca valer você passa a ter ${names(gain)}.`;
  return "";
}

/** Lista do cartão da landing: o que o plano tem (no primeiro) ou o que soma ao plano de baixo ("Tudo do Leve, mais:"). */
export function Adds({ features, level, prev }: { features?: PlanFeature[]; level?: string; prev?: { name: string; level?: string } }) {
  const list = (features ?? []).filter((f) => featureAt(f, level) && (!prev || !featureAt(f, prev.level) || featureAt(f, level) !== featureAt(f, prev.level)));
  if (!list.length) return null;
  return (
    <div className="plan-adds">
      {prev && <b>Tudo do {prev.name}, mais:</b>}
      <ul>
        {list.map((f) => (
          <li key={f.label}>{typeof featureAt(f, level) === "string" ? `${f.short} (${featureAt(f, level)})` : f.short}</li>
        ))}
      </ul>
    </div>
  );
}

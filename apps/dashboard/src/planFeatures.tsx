/** O que todo plano inclui (a lista vem do servidor, em pricing.features: plan-features.ts). Os planos mudam só no preço e nos grãos. */
export interface PlanFeature {
  label: string;
  short: string;
}

/** "Tudo liberado em todos os planos: ..." numa linha. */
export function Includes({ features, className = "" }: { features?: PlanFeature[]; className?: string }) {
  if (!features?.length) return null;
  return (
    <p className={`plan-includes ${className}`}>
      <b>Tudo liberado em todos os planos, até no grátis:</b> {features.map((f) => f.short).join(", ")}.
    </p>
  );
}

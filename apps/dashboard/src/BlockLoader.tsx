/** Carregando: 16 blocos em onda (4 colunas, cada uma com um atraso). CSS puro em styles.css. */
export function BlockLoader({ text, small, full }: { text?: string; small?: boolean; full?: boolean }) {
  return (
    <div className={`pj-loader-wrap ${small ? "small" : ""} ${full ? "full" : ""}`} role="status" aria-label={text ?? "Carregando"}>
      <div className="pj-loader" aria-hidden="true">
        {Array.from({ length: 16 }, (_, i) => (
          <div className="block" key={i} />
        ))}
      </div>
      {text && <span>{text}</span>}
    </div>
  );
}

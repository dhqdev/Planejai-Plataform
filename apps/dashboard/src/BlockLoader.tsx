/** Abertura do app: 16 blocos em onda, grandes e sozinhos no centro da tela. CSS puro em styles/carregando-toque.css. */
export function BlockLoader() {
  return (
    <div className="pj-loader-wrap" role="status" aria-label="Carregando">
      <div className="pj-loader" aria-hidden="true">
        {Array.from({ length: 16 }, (_, i) => (
          <div className="block" key={i} />
        ))}
      </div>
    </div>
  );
}

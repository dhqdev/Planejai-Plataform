import { Component, Fragment, type ReactNode } from "react";

/**
 * Uma tela que quebra no meio do desenho não derruba o app inteiro (antes ficava tudo em branco, por
 * exemplo ao tocar várias vezes em Início). A primeira falha remonta a tela sozinha; se quebrar de novo
 * logo em seguida, aparece um aviso com "Tentar de novo" no lugar só daquela tela.
 */
export class Guard extends Component<{ children: ReactNode; full?: boolean }, { error: boolean; round: number }> {
  state = { error: false, round: 0 };
  private lastRetry = 0;

  static getDerivedStateFromError() {
    return { error: true };
  }

  componentDidCatch(err: unknown) {
    console.error("tela quebrou", err);
    // pedaço da tela que sumiu depois de um deploy: a versão nova resolve
    if (/dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(String((err as Error)?.message ?? err))) {
      try {
        if (Date.now() - Number(sessionStorage.getItem("pj-reloaded") ?? 0) > 15_000) {
          sessionStorage.setItem("pj-reloaded", String(Date.now()));
          return location.reload();
        }
      } catch {
        /* sem storage: fica o aviso */
      }
    }
    if (Date.now() - this.lastRetry > 3000) {
      this.lastRetry = Date.now();
      setTimeout(() => this.retry(), 0);
    }
  }

  retry = () => this.setState((s) => ({ error: false, round: s.round + 1 }));

  render() {
    if (!this.state.error) return <Fragment key={this.state.round}>{this.props.children}</Fragment>;
    return (
      <div className="page" style={this.props.full ? { paddingTop: "30vh" } : undefined}>
        <div className="empty">
          <p>Essa tela travou por um instante.</p>
          <div className="row" style={{ gap: 8, justifyContent: "center" }}>
            <button className="btn btn-sm" onClick={this.retry}>Tentar de novo</button>
            <button className="btn btn-sm btn-ghost" onClick={() => location.assign("/")}>Recarregar</button>
          </div>
        </div>
      </div>
    );
  }
}

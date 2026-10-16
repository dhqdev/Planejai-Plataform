import { Link } from "react-router-dom";
import { Icon } from "./icons";
import { haptic } from "./touch";
import "./styles/vazio.css";

export interface VazioAcao {
  label: string;
  icon?: string;
  onClick?: () => void;
  to?: string;
}

/**
 * Aba ainda vazia (primeiro acesso): ilustração no estilo do blog, uma frase do que dá para fazer ali e
 * até dois atalhos de primeira ação (o primeiro é o principal). As ilustrações são arquivos fixos em
 * public/vazio/<img>.webp, geradas uma vez com a rota do blog (não geram nada a cada acesso).
 */
export function Vazio({ img, title, text, actions = [], tip }: { img: string; title: string; text: string; actions?: VazioAcao[]; tip?: string }) {
  return (
    <div className="vazio-box">
      <section className="vazio">
        <img className="vazio-img" src={`/vazio/${img}.webp`} alt="" width={960} height={717} decoding="async" />
        <div className="vazio-txt">
          <h2>{title}</h2>
          <p>{text}</p>
          {actions.length > 0 && (
            <div className="vazio-acoes">
              {actions.slice(0, 2).map((a, i) => {
                const cls = `btn ${i === 0 ? "btn-brand" : ""}`;
                const icon = a.icon && <Icon name={a.icon} size={16} />;
                return a.to ? (
                  <Link key={a.label} className={cls} to={a.to} onClick={() => haptic(6)}>{icon} {a.label}</Link>
                ) : (
                  <button key={a.label} type="button" className={cls} onClick={() => { haptic(6); a.onClick?.(); }}>{icon} {a.label}</button>
                );
              })}
            </div>
          )}
          {tip && <p className="vazio-dica"><Icon name="send" size={14} /> {tip}</p>}
        </div>
      </section>
    </div>
  );
}

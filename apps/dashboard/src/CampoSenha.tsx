import { useState, type InputHTMLAttributes } from "react";
import "./campo-senha.css";

/**
 * Campo de senha com botão de olho dentro do próprio input.
 * Começa sempre oculto; o botão alterna sem perder o valor digitado, sem tirar o foco
 * do campo e sem enviar o formulário (type="button"). Um botão por campo, independente.
 */
export function CampoSenha({ className = "input", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const [mostrar, setMostrar] = useState(false);
  return (
    <span className="campo-senha">
      <input {...props} className={className} type={mostrar ? "text" : "password"} />
      <button
        type="button"
        className="campo-senha-olho"
        aria-label={mostrar ? "Ocultar senha" : "Mostrar senha"}
        title={mostrar ? "Ocultar senha" : "Mostrar senha"}
        aria-pressed={mostrar}
        onClick={() => setMostrar((m) => !m)}
        onMouseDown={(e) => e.preventDefault()}
      >
        {mostrar ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </span>
  );
}

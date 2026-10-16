import { useEffect, useState } from "react";
import { Modal } from "./components";
import { Icon } from "./icons";
import { canInstall, haptic, isAndroid, isIos, isStandalone, onInstallAvailable, promptInstall } from "./touch";

/**
 * Instalar o Planejai como app. Onde o navegador deixa (Chrome e Edge no Android, no Windows e no Mac),
 * um toque abre a janela do próprio sistema e o app vai para a tela inicial ou a área de trabalho.
 * No iPhone e no iPad a Apple não deixa site nenhum se instalar sozinho (não existe o aviso de instalar):
 * lá o toque abre o passo a passo mais curto, com a seta apontando para o botão do Safari.
 */
export type InstallMode = "prompt" | "ios" | "manual" | null;

export function useInstall() {
  const [, bump] = useState(0);
  useEffect(() => onInstallAvailable(() => bump((n) => n + 1)), []);
  const mode: InstallMode = isStandalone() ? null : canInstall() ? "prompt" : isIos() ? "ios" : isAndroid() ? "manual" : null;
  return mode;
}

/** Botão/linha que instala: chama o aviso do navegador direto, ou abre o passo a passo onde ele não existe. */
export function useInstallAction() {
  const mode = useInstall();
  const [help, setHelp] = useState(false);
  const run = async () => {
    haptic(10);
    if (mode === "prompt") await promptInstall();
    else setHelp(true);
  };
  const sheet = help && mode !== "prompt" ? <InstallHelp mode={mode} onClose={() => setHelp(false)} /> : null;
  return { mode, run, sheet };
}

const ShareGlyph = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M12 3v12M8 7l4-4 4 4" />
    <path d="M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1" />
  </svg>
);
const AddGlyph = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
    <rect x="4" y="4" width="16" height="16" rx="4" />
    <path d="M12 8.5v7M8.5 12h7" />
  </svg>
);

function InstallHelp({ mode, onClose }: { mode: InstallMode; onClose: () => void }) {
  const ipad = /Macintosh|iPad/.test(navigator.userAgent);
  const ios = mode === "ios";
  return (
    <Modal title="Instalar o Planejai" onClose={onClose} className="install-sheet">
      <div className="install-hero">
        <img src="/icons/logo-256.png" alt="" width={64} height={64} />
        <p>
          {ios
            ? "No iPhone a Apple não deixa nenhum site se instalar com um toque só. São três toques e ele fica na tela de início, abrindo em tela cheia como app."
            : "Seu navegador não mostrou o botão de instalar. Pelo menu dele leva dois toques."}
        </p>
      </div>
      <ol className="install-steps">
        {ios ? (
          <>
            <li>
              <span className="install-n">1</span>
              <span>Toque em <b className="install-key"><ShareGlyph /> Compartilhar</b> {ipad ? "no alto do Safari" : "na barra do Safari (no iOS 26, fica dentro do ···)"}</span>
            </li>
            <li>
              <span className="install-n">2</span>
              <span>Escolha <b className="install-key"><AddGlyph /> Adicionar à Tela de Início</b></span>
            </li>
            <li>
              <span className="install-n">3</span>
              <span>Toque em <b>Adicionar</b>, no canto de cima</span>
            </li>
          </>
        ) : (
          <>
            <li>
              <span className="install-n">1</span>
              <span>Toque no menu <b className="install-key install-dots">⋮</b> do navegador</span>
            </li>
            <li>
              <span className="install-n">2</span>
              <span>Escolha <b>Instalar app</b> (ou <b>Adicionar à tela inicial</b>)</span>
            </li>
          </>
        )}
      </ol>
      {ios && (
        <div className={`install-point${ipad ? " up" : ""}`} aria-hidden>
          <ShareGlyph />
          <Icon name={ipad ? "arrow-up" : "arrow-down"} size={18} />
        </div>
      )}
    </Modal>
  );
}

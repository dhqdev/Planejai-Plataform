import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { Guard } from "./Guard";
import "./styles.css";
import "./motion.css";
import { installFieldLabels, installKeyboard } from "./a11y";
import { installEdgeBack, installLiquidGlass, installSegmented } from "./ios";
import { installRipple } from "./motion";
import { installTouchFeedback, registerServiceWorker } from "./touch";
import { watchForUpdates } from "./update";

// volta de um "Atualizar": tira o ?v= da barra de endereço
if (new URLSearchParams(location.search).has("v")) {
  const u = new URL(location.href);
  u.searchParams.delete("v");
  history.replaceState(history.state, "", u.pathname + u.search + u.hash);
}

installTouchFeedback();
installRipple();
registerServiceWorker();
installFieldLabels();
installKeyboard();
installSegmented();
installEdgeBack();
installLiquidGlass();
watchForUpdates();

// a barra de cima do celular acompanha o tema do painel (claro/escuro), mesmo com o sistema no outro
const syncThemeColor = () => {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = document.documentElement.dataset.theme === "dark" ? "#111111" : "#fafafa";
};
new MutationObserver(syncThemeColor).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

try {
  const saved = localStorage.getItem("pj-theme");
  const dark = saved ? saved === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
} catch {
  document.documentElement.dataset.theme = "light";
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Guard full>
        <App />
      </Guard>
    </BrowserRouter>
  </StrictMode>,
);

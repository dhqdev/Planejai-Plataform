import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles.css";
import "./motion.css";
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
watchForUpdates();

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
      <App />
    </BrowserRouter>
  </StrictMode>,
);

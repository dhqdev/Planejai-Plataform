import { readFileSync } from "node:fs";

/** Versão do app (package.json, igual à tag da release vX.Y.Z) e commit da imagem (GIT_SHA no build). */
function pkgVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
  } catch {
    return "0.0.0";
  }
}

export const VERSION = process.env.APP_VERSION || pkgVersion();
export const COMMIT = (process.env.GIT_SHA ?? "").slice(0, 7) || null;

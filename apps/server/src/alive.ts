import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Arquivo que o processo de filas (worker, channel ou conversations) renova a cada 15s; o healthcheck confere a idade. */
export const ALIVE_FILE = join(tmpdir(), "planejai-worker-alive");

export function startAliveBeat() {
  const beat = () => {
    try {
      writeFileSync(ALIVE_FILE, String(Date.now()));
    } catch {
      /* disco somente leitura: o healthcheck acusa */
    }
  };
  beat();
  setInterval(beat, 15_000).unref();
}

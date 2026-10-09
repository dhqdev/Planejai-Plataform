// Processo ROLE=conversations de verdade para o workers.e2e: só consome as filas de conversa e envia pelo channel.
import { startWorker } from "../../src/queue/worker.js";

const log = { info: () => {}, warn: () => {}, error: (...a: unknown[]) => console.error(...a) };
await startWorker(log, 1);
process.stdout.write("pronto\n");

import { useEffect, useState, type ReactNode } from "react";
import { ago, api } from "../api";
import { ErrorBox, Loading, Modal, PageHead, alertDialog } from "../components";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import "../backup.css";
import { haptic } from "../touch";
import { bytes } from "./Resources";

// ================= Tipos (iguais ao servidor: apps/server/src/backup.ts e api/routes/dashboard/backup.ts) =================

interface FilesCheck {
  total: number;
  inBucket: number;
  inBucketBytes: number;
  inDbOnly: number;
  inDbOnlyBytes: number;
  missing: number;
  objects: number;
  objectsBytes: number;
  truncated: boolean;
}
interface Inventory {
  table: string;
  label: string;
  rows: number;
}
interface Manifest {
  file: string;
  created_at: string;
  reason: string;
  bytes: number;
  app_version: string;
  last_migration: string | null;
  key_fingerprint: string | null;
  inventory: Inventory[];
  files: FilesCheck;
  verified?: { downloaded: boolean; entries: number } | null;
}
interface Run {
  id: string;
  reason: string;
  started_at: string;
  finished_at: string | null;
  ok: boolean | null;
  key: string | null;
  bytes: number | null;
  error: string | null;
  files: FilesCheck | null;
  verified: { entries: number } | null;
  inventory: Inventory[] | null;
}
interface Remote {
  key: string;
  size: number;
  lastModified: string;
  manifest: Manifest | null;
}
interface RestoreState {
  phase: string;
  key: string;
  message: string;
  error?: string;
  previousDb?: string;
  credentials?: { total: number; fixed: number; failed: number };
}
interface Info {
  bucket: { host: string; endpoint: string; region: string; bucket: string; prefix: string } | null;
  tools: { pgDump: string | null; pgRestore: string | null };
  keyFingerprint: string | null;
  fresh: boolean;
  dbName: string;
  schedule: { time: string; timezone: string; keepDays: number };
  runs: Run[];
  remote: Remote[];
  remoteError: string | null;
  vault: { savedAt: string; keyFingerprint: string | null } | null;
  legacyObjects: number;
  whatsapp: { keys: number; status: string | null };
  restore: RestoreState | null;
  restoredAt: { at: string; from: string } | null;
}

const nf = (v: number) => v.toLocaleString("pt-BR");
const when = (iso: string) => new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
const REASON: Record<string, string> = { agenda: "Diário", manual: "Na mão", teste: "Teste", "antes-de-restaurar": "Antes de restaurar" };
const fileName = (key: string) => key.split("/").pop() ?? key;
const plural = (n: number, one: string, many: string) => `${nf(n)} ${n === 1 ? one : many}`;

/** Servidor > Backup (só o dono da stack): o que está no Backblaze, testar, cofre das chaves, migrar e restaurar. */
export function BackupPage() {
  const { data, error, reload, setData } = useApi<Info>("/api/backup", { poll: 15_000 });
  const [busy, setBusy] = useState<"" | "run" | "test">("");
  const [restoreKey, setRestoreKey] = useState<string | null>(null);
  const [vault, setVault] = useState<"" | "save" | "open">("");
  const [ftp, setFtp] = useState(false);
  const phase = data?.restore?.phase;

  // restauração andando: acompanha de perto (na troca do banco a API some uns segundos e volta)
  useEffect(() => {
    if (!phase || phase === "pronto" || phase === "erro") return;
    const t = setInterval(async () => {
      const r = await api<{ restore: RestoreState | null }>("/api/backup/restore").catch(() => null);
      if (r?.restore) setData((d) => (d ? { ...d, restore: r.restore } : d));
    }, 1500);
    return () => clearInterval(t);
  }, [phase, setData]);

  if (error && !data) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;

  const running = data.runs.find((r) => !r.finished_at && Date.now() - new Date(r.started_at).getTime() < 3 * 3600_000);
  const lastOk = data.runs.find((r) => r.ok);
  const lastRun = data.runs.find((r) => r.finished_at);
  const restoring = data.restore && !["pronto", "erro"].includes(data.restore.phase);

  const start = async (test: boolean) => {
    haptic(5);
    setBusy(test ? "test" : "run");
    try {
      await api("/api/backup/run", { method: "POST", json: { test } });
      await reload();
    } catch (err) {
      void alertDialog("Não deu para começar", (err as Error).message);
    } finally {
      setBusy("");
    }
  };

  // ---------- veredito: está tudo no bucket? ----------
  const ageH = lastOk ? (Date.now() - new Date(lastOk.finished_at ?? lastOk.started_at).getTime()) / 3600_000 : Infinity;
  const files = lastOk?.files ?? null;
  const problems: string[] = [];
  if (!data.bucket) problems.push("O bucket não está configurado na stack");
  else {
    if (!data.tools.pgDump) problems.push("Esta imagem não tem o pg_dump: atualize o Planejai");
    if (!lastOk) problems.push("Nenhum backup feito pelo app ainda");
    else if (ageH > 30) problems.push(`O último backup tem ${Math.round(ageH / 24)} dia(s)`);
    if (files && files.missing > 0) problems.push(`${plural(files.missing, "arquivo não está", "arquivos não estão")} no bucket`);
    if (!data.vault) problems.push("As chaves da stack ainda não estão no cofre");
  }
  const allGood = problems.length === 0;

  return (
    <div className="page page-wide bk-page">
      <PageHead
        title="Backup e migração"
        subtitle="Tudo que precisa para subir o Planejai em outra VPS fica no seu bucket. Aqui você confere, testa e restaura."
        actions={
          <>
            <button className="btn" disabled={!!busy || !!running || !data.bucket} onClick={() => void start(false)}>
              <Icon name="download" size={15} /> {busy === "run" ? "Começando" : "Fazer backup agora"}
            </button>
            <button className="btn btn-primary" disabled={!!busy || !!running || !data.bucket} onClick={() => void start(true)}>
              <Icon name="check" size={15} /> {running ? "Rodando" : busy === "test" ? "Começando" : "Testar backup agora"}
            </button>
          </>
        }
      />

      {data.fresh && data.remote.length > 0 && !restoring && (
        <div className="card bk-fresh">
          <div>
            <strong>Instalação nova</strong>
            <p className="muted">Achei {plural(data.remote.length, "backup", "backups")} no bucket. O mais novo é de {when(data.remote[0]!.lastModified)}. Quer trazer tudo de volta?</p>
          </div>
          <button className="btn btn-primary" onClick={() => { haptic(5); setRestoreKey(data.remote[0]!.key); }}>Restaurar o mais novo</button>
        </div>
      )}

      {data.restore && <RestoreBanner state={data.restore} />}

      <div className={`card bk-verdict ${allGood ? "ok" : "warn"}`}>
        <span className="bk-verdict-dot"><Icon name={allGood ? "check" : "shield"} size={18} /></span>
        <div className="bk-verdict-text">
          <strong>{allGood ? "Tudo que precisa para migrar está no bucket" : "Ainda falta coisa para migrar tranquilo"}</strong>
          {allGood ? (
            <small>
              Último backup {ago(lastOk!.finished_at ?? lastOk!.started_at)}, {bytes(lastOk!.bytes)}
              {lastOk!.verified ? ", baixado de volta e conferido" : ""}. Próximo às {data.schedule.time} ({data.schedule.timezone}).
            </small>
          ) : (
            <small>{problems.join(" · ")}.</small>
          )}
        </div>
        {running && <span className="bk-running"><span className="srv-live" /> Backup rodando</span>}
      </div>

      <div className="bk-grid">
        <div className="bk-col">
          <div className="card bk-card">
            <h3>O que está salvo</h3>
            <Item
              ok={!!lastOk}
              title="Banco de dados"
              detail={
                lastOk
                  ? `${bytes(lastOk.bytes)} em ${fileName(lastOk.key ?? "")}, ${ago(lastOk.finished_at ?? lastOk.started_at)}`
                  : "Ainda sem backup no bucket"
              }
            >
              Pessoas, agenda, finanças, memórias, recados, configurações, integrações (cifradas), planos e grãos. Tudo do Postgres num arquivo só.
              {lastOk?.inventory && (
                <span className="bk-inv">
                  {lastOk.inventory.filter((t) => t.rows > 0).map((t) => (
                    <span key={t.table}><strong className="mono-num">{nf(t.rows)}</strong> {t.label.toLowerCase()}</span>
                  ))}
                </span>
              )}
            </Item>
            <Item
              ok={!!files && files.missing === 0}
              warn={!files}
              title="Documentos e mídias"
              detail={
                files
                  ? `${plural(files.inBucket, "arquivo", "arquivos")} no bucket (${bytes(files.inBucketBytes)})${files.inDbOnly ? `, ${nf(files.inDbOnly)} dentro do banco` : ""}${files.missing ? `, ${nf(files.missing)} faltando` : ""}`
                  : "Conferido a cada backup"
              }
            >
              Cada arquivo que o banco diz ter é procurado no bucket. Os que ainda estão só no banco vão juntos no dump.
              {data.legacyObjects > 0 && <> Arrumando as pastas: {plural(data.legacyObjects, "arquivo ainda está", "arquivos ainda estão")} no lugar antigo e mudam sozinhos de hora em hora.</>}
            </Item>
            <Item ok={!!lastOk && data.whatsapp.keys > 0} warn={data.whatsapp.keys === 0} title="Sessão do WhatsApp" detail={data.whatsapp.keys ? `Dentro do banco (${plural(data.whatsapp.keys, "chave", "chaves")})` : "Nenhuma sessão pareada"}>
              Volta junto com o banco. Se o servidor antigo continuar ligado, ou o backup for velho, o WhatsApp pode pedir para parear de novo.
            </Item>
            <Item ok={!!data.vault} warn={!data.vault} title="Chaves da stack" detail={data.vault ? `No cofre desde ${when(data.vault.savedAt)}` : "Fora do bucket"}>
              ENCRYPTION_KEY, senhas e chaves de API vêm da stack, não do banco. Sem a ENCRYPTION_KEY as integrações não abrem. O cofre guarda todas cifradas com uma senha que só você sabe.
              <span className="bk-actions">
                <button className="btn btn-sm" onClick={() => { haptic(5); setVault("save"); }} disabled={!data.bucket}>{data.vault ? "Atualizar o cofre" : "Guardar no cofre"}</button>
                {data.vault && <button className="btn btn-sm" onClick={() => { haptic(5); setVault("open"); }}>Abrir o cofre</button>}
              </span>
              {data.vault && data.keyFingerprint && data.vault.keyFingerprint !== data.keyFingerprint && (
                <span className="bk-warn">A ENCRYPTION_KEY mudou desde que o cofre foi salvo. Atualize o cofre.</span>
              )}
            </Item>
            <h4 className="bk-sub">Não vai para o bucket, e tudo bem</h4>
            <ul className="bk-not">
              <li><strong>Memória curta (Redis):</strong> as últimas horas de conversa. O resumo de cada conversa está no banco, então o assistente só esquece o detalhe do que se falou hoje.</li>
              <li><strong>Cache:</strong> buscas e páginas guardadas para economizar. Refaz sozinho.</li>
              <li><strong>Portainer, Traefik e DNS:</strong> ficam com você. O arquivo da stack tem tudo; o cofre tem as variáveis.</li>
            </ul>
          </div>

          <div className="card bk-card">
            <h3>Como migrar para outra VPS</h3>
            <p className="muted bk-lead">Serve para qualquer provedor (AWS, Oracle, Hetzner) e qualquer processador (arm64 ou amd64): a imagem é a mesma.</p>
            <ol className="bk-steps">
              <li><strong>Aqui, antes de tudo.</strong> Toque em "Testar backup agora" e guarde as chaves no cofre. Anote a senha do cofre num lugar seu (gerenciador de senhas).</li>
              <li><strong>Desligue o WhatsApp do servidor antigo.</strong> No Portainer, serviço <code>worker</code> com 0 réplicas. Depois "Fazer backup agora" de novo: assim a sessão do WhatsApp vai fresquinha e não fica em dois lugares.</li>
              <li><strong>Suba a VPS nova.</strong> Instale com <code>deploy/instalar-ssh.ps1</code> (Windows) ou cole a mesma stack no Portainer. Use as mesmas variáveis <code>STORAGE_S3_*</code>, <code>ADMIN_EMAIL</code> e <code>ADMIN_PASSWORD</code>. O jeito mais simples é usar a mesma <code>ENCRYPTION_KEY</code>; se for outra, a restauração pede a senha do cofre.</li>
              <li><strong>Aponte o domínio</strong> {location.host} para o IP novo (ou entre primeiro pelo IP para testar).</li>
              <li><strong>Entre com o super admin.</strong> Na instalação nova o WhatsApp ainda não está conectado, então entra só com a senha. Vá em Servidor &gt; Backup e toque em "Restaurar o mais novo".</li>
              <li><strong>Pronto.</strong> O Planejai reinicia sozinho com tudo de volta, e o WhatsApp reconecta com a sessão do backup. Se pedir QR, pareie de novo em Conexões.</li>
              <li><strong>Deixe a VPS antiga parada uns dias</strong> antes de apagar, só por garantia.</li>
            </ol>
          </div>
        </div>

        <div className="bk-col">
          <div className="card bk-card">
            <div className="bk-head">
              <h3>No bucket</h3>
              <span className="spacer" />
              {data.bucket && <button className="btn btn-sm" onClick={() => { haptic(5); setFtp(true); }}><Icon name="folder" size={14} /> Abrir como pasta</button>}
            </div>
            {!data.bucket ? (
              <p className="muted bk-lead">
                Preencha <code>STORAGE_S3_ENDPOINT</code>, <code>STORAGE_S3_BUCKET</code>, <code>STORAGE_S3_REGION</code>, <code>STORAGE_S3_ACCESS_KEY_ID</code> e <code>STORAGE_S3_SECRET_ACCESS_KEY</code> na stack (app e worker) e atualize.
              </p>
            ) : (
              <>
                <p className="muted bk-lead mono-small">{data.bucket.host} · {data.bucket.bucket}/{data.bucket.prefix}</p>
                <div className="bk-tree">
                  <Folder name="banco/" note={`um .dump por dia com a ficha .json do lado, ${data.schedule.keepDays} dias`} size={data.remote.reduce((a, r) => a + r.size, 0)} count={data.remote.length} />
                  <Folder name="arquivos/" note="documentos/<pessoa>/ com os documentos de cada um e midia/ com fotos, áudios e gravações" size={files?.objectsBytes} count={files?.objects} />
                  <Folder name="chaves/" note={data.vault ? "cofre das chaves, cifrado" : "vazio: guarde o cofre"} />
                  <Folder name="LEIA-ME.txt" note="explica as pastas para quem abrir o bucket" file />
                </div>
                {data.remoteError && <p className="bk-warn">Não consegui listar o bucket agora: {data.remoteError}</p>}
              </>
            )}
          </div>

          <div className="card bk-card">
            <h3>Backups no bucket</h3>
            {!data.remote.length && <p className="muted bk-lead">{data.bucket ? "Nenhum ainda. Toque em \"Testar backup agora\"." : "Configure o bucket primeiro."}</p>}
            <div className="bk-list">
              {data.remote.slice(0, 10).map((r) => {
                const otherKey = !!r.manifest?.key_fingerprint && !!data.keyFingerprint && r.manifest.key_fingerprint !== data.keyFingerprint;
                return (
                  <div key={r.key} className="bk-row">
                    <span className="bk-row-main">
                      <strong>{when(r.lastModified)}</strong>
                      <small className="muted">
                        {bytes(r.size)}
                        {r.manifest ? ` · v${r.manifest.app_version}` : " · do serviço backup da stack"}
                        {r.manifest?.verified ? " · conferido" : ""}
                        {r.key.includes("antes-de-restaurar") ? " · cópia antes de restaurar" : ""}
                        {otherKey ? " · outra ENCRYPTION_KEY" : ""}
                      </small>
                    </span>
                    <button className="btn btn-sm" disabled={!!restoring || !data.tools.pgRestore} onClick={() => { haptic(5); setRestoreKey(r.key); }}>Restaurar</button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card bk-card">
            <h3>Últimas rodadas</h3>
            <div className="bk-list">
              {data.runs.slice(0, 6).map((r) => (
                <div key={r.id} className="bk-row">
                  <span className={`bk-state ${r.ok ? "ok" : r.finished_at ? "err" : "run"}`} />
                  <span className="bk-row-main">
                    <strong>{REASON[r.reason] ?? r.reason} · {when(r.started_at)}</strong>
                    <small className={r.ok === false ? "bk-err" : "muted"}>
                      {r.ok ? `${bytes(r.bytes)}${r.verified ? `, conferido (${nf(r.verified.entries)} itens)` : ""}` : r.finished_at ? r.error : "rodando"}
                    </small>
                  </span>
                </div>
              ))}
              {!data.runs.length && <p className="muted bk-lead">Nenhuma ainda.</p>}
            </div>
            {lastRun && !lastRun.ok && <p className="bk-warn">A última rodada falhou. O motivo está acima; o backup anterior continua no bucket.</p>}
            <p className="muted bk-foot">
              Ferramentas: {data.tools.pgDump ?? "pg_dump não instalado"}. Chave atual: <code>{data.keyFingerprint ?? "nenhuma"}</code> (impressão digital, não a chave).
              {data.restoredAt && <> Restaurado {ago(data.restoredAt.at)} de {fileName(data.restoredAt.from)}.</>}
            </p>
          </div>
        </div>
      </div>

      {restoreKey && (
        <RestoreModal
          info={data}
          initialKey={restoreKey}
          onClose={() => setRestoreKey(null)}
          onStarted={(s) => setData({ ...data, restore: s })}
        />
      )}
      {vault === "save" && <VaultSave onClose={() => setVault("")} onSaved={() => void reload()} />}
      {vault === "open" && <VaultOpen onClose={() => setVault("")} />}
      {ftp && data.bucket && <FtpHelp bucket={data.bucket} onClose={() => setFtp(false)} />}
    </div>
  );
}

function Item({ ok, warn, title, detail, children }: { ok: boolean; warn?: boolean; title: string; detail: string; children: ReactNode }) {
  return (
    <div className="bk-item">
      <span className={`bk-mark ${ok ? "ok" : warn ? "warn" : "err"}`}><Icon name={ok ? "check" : "x"} size={13} /></span>
      <div className="bk-item-body">
        <div className="bk-item-top"><strong>{title}</strong><small>{detail}</small></div>
        <p className="muted">{children}</p>
      </div>
    </div>
  );
}

function Folder({ name, note, size, count, file }: { name: string; note: string; size?: number; count?: number; file?: boolean }) {
  return (
    <div className="bk-folder">
      <Icon name={file ? "file" : "folder"} size={15} />
      <span className="bk-folder-name"><code>{name}</code><small className="muted">{note}</small></span>
      {count != null && <small className="muted mono-num">{nf(count)}{size ? ` · ${bytes(size)}` : ""}</small>}
    </div>
  );
}

const PHASES: Record<string, string> = {
  baixando: "Baixando",
  conferindo: "Conferindo",
  copia: "Guardando cópia",
  restaurando: "Restaurando",
  atualizando: "Atualizando",
  chaves: "Credenciais",
  trocando: "Trocando",
  pronto: "Pronto",
  erro: "Não restaurou",
};

function RestoreBanner({ state }: { state: RestoreState }) {
  const done = state.phase === "pronto";
  const failed = state.phase === "erro";
  // depois da troca o app reinicia: espera voltar e manda para o login
  useEffect(() => {
    if (!done) return;
    let stop = false;
    const t = setTimeout(async function check() {
      if (stop) return;
      const ok = await fetch("/health").then((r) => r.ok).catch(() => false);
      if (ok && !stop) window.location.href = "/";
      else setTimeout(check, 3000);
    }, 9000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [done]);
  return (
    <div className={`card bk-restore ${failed ? "err" : done ? "ok" : ""}`}>
      {!done && !failed && <span className="srv-live" />}
      <div>
        <strong>{PHASES[state.phase] ?? state.phase}: {fileName(state.key)}</strong>
        <small>{failed ? state.error : state.message}</small>
        {failed && <small>{state.message}</small>}
        {done && state.credentials && state.credentials.total > 0 && (
          <small>{plural(state.credentials.total, "credencial conferida", "credenciais conferidas")}{state.credentials.fixed ? `, ${nf(state.credentials.fixed)} regravada(s) com a chave desta stack` : ""}{state.credentials.failed ? `, ${nf(state.credentials.failed)} sem abrir (conecte de novo)` : ""}.</small>
        )}
        {done && state.previousDb && <small>O banco de antes ficou guardado como {state.previousDb}.</small>}
      </div>
    </div>
  );
}

function RestoreModal({ info, initialKey, onClose, onStarted }: { info: Info; initialKey: string; onClose: () => void; onStarted: (s: RestoreState) => void }) {
  const [key, setKey] = useState(initialKey);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [secret, setSecret] = useState("");
  const [ignoreKeys, setIgnoreKeys] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const chosen = info.remote.find((r) => r.key === key);
  const otherKey = !!chosen?.manifest?.key_fingerprint && !!info.keyFingerprint && chosen.manifest.key_fingerprint !== info.keyFingerprint;
  const ready = password.length > 0 && confirm.trim().toUpperCase() === "RESTAURAR" && !busy;

  const go = async () => {
    haptic(10);
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ restore: RestoreState }>("/api/backup/restore", { method: "POST", json: { key, password, confirm, secret: secret || undefined, ignoreKeys } });
      onStarted(r.restore);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Restaurar do bucket"
      icon={<Icon name="database" />}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn btn-primary" disabled={!ready} onClick={() => void go()}>{busy ? "Começando" : "Restaurar"}</button>
        </>
      }
    >
      <div className="bk-form">
        <p className="muted">
          {info.fresh
            ? "Esta instalação está vazia: o banco do backup entra no lugar dela."
            : "O banco de agora é trocado pelo do backup. Antes, uma cópia dele vai para o bucket e ele fica guardado ao lado, então dá para voltar."}{" "}
          O Planejai fica fora do ar alguns segundos e reinicia sozinho.
        </p>
        <div className="field">
          <label>Backup</label>
          <select className="input" value={key} onChange={(e) => setKey(e.target.value)}>
            {info.remote.map((r) => (
              <option key={r.key} value={r.key}>{when(r.lastModified)} · {bytes(r.size)}{r.key.includes("antes-de-restaurar") ? " · cópia antes de restaurar" : ""}</option>
            ))}
          </select>
          {chosen?.manifest && (
            <div className="help">
              Versão {chosen.manifest.app_version}, {chosen.manifest.inventory.filter((t) => ["users", "documents", "transactions"].includes(t.table)).map((t) => `${nf(t.rows)} ${t.label.toLowerCase()}`).join(", ")}.
            </div>
          )}
        </div>
        <div className="field">
          <label>Chave antiga ou senha do cofre {otherKey ? "" : "(opcional)"}</label>
          <input className="input" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={otherKey ? "Este backup usa outra ENCRYPTION_KEY" : "Só se a ENCRYPTION_KEY desta stack for outra"} />
          <div className="help">{otherKey ? "As integrações deste backup foram cifradas com outra chave. Com a senha do cofre (ou a ENCRYPTION_KEY antiga) elas são regravadas com a chave desta stack." : "A chave desta stack bate com a do backup (ou o backup não tem ficha). Pode deixar vazio."}</div>
        </div>
        {otherKey && (
          <label className="set-switch">
            <input type="checkbox" checked={ignoreKeys} onChange={(e) => setIgnoreKeys(e.target.checked)} />
            <span><strong>Restaurar mesmo sem a chave</strong><small>Tudo volta, menos as integrações: aí é só conectar cada uma de novo.</small></span>
          </label>
        )}
        <div className="field">
          <label>Senha do dono</label>
          <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="field">
          <label>Escreva RESTAURAR para confirmar</label>
          <input className="input" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoCapitalize="characters" />
        </div>
        {err && <p className="bk-err">{err}</p>}
      </div>
    </Modal>
  );
}

function VaultSave({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = a.length >= 10 && a === b && !busy;
  const save = async () => {
    haptic(10);
    setBusy(true);
    setErr(null);
    try {
      await api("/api/backup/vault", { method: "POST", json: { passphrase: a } });
      onSaved();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Guardar as chaves no cofre"
      icon={<Icon name="shield" />}
      onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancelar</button><button className="btn btn-primary" disabled={!ok} onClick={() => void save()}>{busy ? "Guardando" : "Guardar"}</button></>}
    >
      <div className="bk-form">
        <p className="muted">
          As variáveis da stack (ENCRYPTION_KEY, senhas, chaves de API, bucket) vão para <code>chaves/</code> no bucket, cifradas com esta senha.
          Ela não fica salva em lugar nenhum: se esquecer, o cofre não abre. Guarde num gerenciador de senhas.
        </p>
        <div className="field"><label>Senha do cofre</label><input className="input" type="password" autoComplete="new-password" value={a} onChange={(e) => setA(e.target.value)} /><div className="help">Pelo menos 10 caracteres. Uma frase é melhor.</div></div>
        <div className="field"><label>Repita</label><input className="input" type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} /></div>
        {b && a !== b && <p className="bk-err">As duas não batem.</p>}
        {err && <p className="bk-err">{err}</p>}
      </div>
    </Modal>
  );
}

function VaultOpen({ onClose }: { onClose: () => void }) {
  const [pass, setPass] = useState("");
  const [env, setEnv] = useState<Record<string, string> | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const open = async () => {
    haptic(5);
    setBusy(true);
    setErr(null);
    try {
      setEnv((await api<{ env: Record<string, string> }>("/api/backup/vault/open", { method: "POST", json: { passphrase: pass } })).env);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const text = env ? Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n") : "";
  return (
    <Modal
      title="Cofre das chaves"
      icon={<Icon name="shield" />}
      onClose={onClose}
      wide={!!env}
      footer={
        env ? (
          <button className="btn btn-primary" onClick={async () => { await navigator.clipboard.writeText(text).catch(() => {}); setCopied(true); }}>
            <Icon name={copied ? "check" : "copy"} size={15} /> {copied ? "Copiado" : "Copiar tudo"}
          </button>
        ) : (
          <><button className="btn" onClick={onClose}>Cancelar</button><button className="btn btn-primary" disabled={!pass || busy} onClick={() => void open()}>{busy ? "Abrindo" : "Abrir"}</button></>
        )
      }
    >
      <div className="bk-form">
        {!env ? (
          <>
            <p className="muted">Mostra as variáveis da stack para você colar na VPS nova. Feche esta janela quando terminar.</p>
            <div className="field"><label>Senha do cofre</label><input className="input" type="password" autoComplete="off" value={pass} onChange={(e) => setPass(e.target.value)} onKeyDown={(e) => e.key === "Enter" && pass && void open()} /></div>
            {err && <p className="bk-err">{err}</p>}
          </>
        ) : (
          <pre className="bk-env">{text}</pre>
        )}
      </div>
    </Modal>
  );
}

function FtpHelp({ bucket, onClose }: { bucket: NonNullable<Info["bucket"]>; onClose: () => void }) {
  return (
    <Modal title="Abrir o bucket como pasta" icon={<Icon name="folder" />} onClose={onClose}>
      <div className="bk-form">
        <p className="muted">
          O Backblaze não tem FTP. Ele fala S3, e programas de FTP como o WinSCP e o Cyberduck abrem S3 do mesmo jeito: você vê as pastas, baixa e sobe arquivos.
        </p>
        <ol className="bk-steps">
          <li>No Backblaze, <strong>App Keys &gt; Add a New Application Key</strong>: só o bucket <code>{bucket.bucket}</code>, <strong>Read Only</strong>. Assim, olhando, você não apaga nada sem querer.</li>
          <li>No <strong>WinSCP</strong> (Windows): Novo site, protocolo <strong>Amazon S3</strong>.</li>
          <li>Nome do host: <code>{bucket.host}</code>, porta 443.</li>
          <li>Access key ID: o <strong>keyID</strong> da chave nova. Secret access key: a <strong>applicationKey</strong>.</li>
          <li>Em Avançado &gt; Diretórios, pasta remota: <code>/{bucket.bucket}/{bucket.prefix}</code>.</li>
        </ol>
        <p className="muted">No Mac, o Cyberduck faz igual (perfil "Amazon S3", mesmo servidor e chaves). Não mexa nem renomeie arquivos em <code>arquivos/</code>: o banco guarda o caminho de cada um.</p>
      </div>
    </Modal>
  );
}

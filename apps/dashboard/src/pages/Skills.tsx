import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api";
import { Empty, ErrorBox, Loading, Modal, PageHead } from "../components";
import { useApi, useMedia } from "../hooks";
import { Icon } from "../icons";
import { haptic } from "../touch";

/**
 * Skills (só o dono, aba da Esteira): os guias .md de .claude/skills/ do repositório, como cada parte do sistema
 * funciona. Abre, edita e "Salvar e publicar" faz um commit na main só com aquele arquivo; a Lia aponta as skills
 * de cada chamado e o time da esteira lê.
 */
interface SkillList {
  repo: string;
  branch: string;
  groups: { folder: string; files: { path: string; name: string; size: number }[] }[];
}
interface SkillFile {
  path: string;
  content: string;
  sha: string;
}

export function SkillsPage() {
  const list = useApi<SkillList>("/api/dev/skills");
  const [params, setParams] = useSearchParams();
  const path = params.get("p");
  const phone = useMedia("(max-width: 767px)");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const pick = (p: string | null) => {
    const n = new URLSearchParams(params);
    if (p) n.set("p", p);
    else n.delete("p");
    setParams(n, { replace: !p });
  };

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (list.data?.groups ?? [])
      .map((g) => ({ ...g, files: g.files.filter((f) => !term || f.path.toLowerCase().includes(term)) }))
      .filter((g) => g.files.length);
  }, [list.data, q]);

  if (list.error) return <div className="page"><PageHead title="Skills" /><ErrorBox error={list.error} /></div>;
  if (!list.data) return <Loading />;

  const showList = !phone || !path;
  return (
    <div className="page page-wide">
      <PageHead
        title="Skills"
        subtitle={`Como cada parte do sistema funciona, direto de ${list.data.repo}. Salvar publica na ${list.data.branch} e a esteira passa a usar.`}
        actions={
          <button className="btn" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> Nova skill
          </button>
        }
      />
      <div className="skills-layout">
        {showList && (
          <nav className="skills-list card" aria-label="Skills">
            <input className="input" placeholder="Procurar" value={q} onChange={(e) => setQ(e.target.value)} />
            {!groups.length && <Empty>Nenhuma skill com esse nome.</Empty>}
            {groups.map((g) => (
              <section key={g.folder}>
                <h4>{g.folder === "planejai" ? "Do Planejai" : g.folder}</h4>
                {g.files.map((f) => (
                  <button key={f.path} className={f.path === path ? "active" : ""} onClick={() => { haptic(5); pick(f.path); }}>
                    <span className="ellipsis">{f.name}</span>
                    <small className="muted">{Math.max(1, Math.round(f.size / 1000))} mil</small>
                  </button>
                ))}
              </section>
            ))}
          </nav>
        )}
        {path ? (
          <Editor key={path} path={path} onBack={phone ? () => pick(null) : undefined} onSaved={() => void list.reload()} />
        ) : (
          !phone && <div className="card skills-empty"><Empty>Escolha uma skill na lista para ler ou editar.</Empty></div>
        )}
      </div>
      {creating && (
        <NewSkill
          onClose={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            void list.reload();
            pick(p);
          }}
        />
      )}
    </div>
  );
}

function Editor({ path, onBack, onSaved }: { path: string; onBack?: () => void; onSaved: () => void }) {
  const file = useApi<SkillFile>(`/api/dev/skills/file?path=${encodeURIComponent(path)}`);
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    if (file.data) setText(file.data.content);
  }, [file.data]);
  const dirty = text != null && file.data != null && text !== file.data.content;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  const save = async () => {
    if (!file.data || text == null) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const r = await api<{ commit: string | null; sha: string }>("/api/dev/skills/file", { method: "PUT", json: { path, content: text, sha: file.data.sha } });
      haptic();
      file.setData({ ...file.data, content: text, sha: r.sha });
      setDone(r.commit ? `Publicado na main (${r.commit.slice(0, 7)}). Entra em produção com o próximo deploy.` : "Nada mudou.");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card skills-editor">
      <header>
        {onBack && (
          <button className="btn btn-sm" onClick={onBack} aria-label="Voltar para a lista">‹</button>
        )}
        <span className="mono ellipsis" title={path}>{path.replace(/^\.claude\/skills\//, "")}</span>
        <span className="spacer" />
        {dirty && <span className="muted">não salvo</span>}
        <button className="btn btn-sm" disabled={!dirty || busy} onClick={() => file.data && setText(file.data.content)}>Desfazer</button>
        <button className="btn btn-sm btn-primary" disabled={!dirty || busy} onClick={save}>{busy ? "Publicando…" : "Salvar e publicar"}</button>
      </header>
      {file.error && <ErrorBox error={file.error} />}
      {err && <ErrorBox error={err} />}
      {done && <p className="skills-done">{done}</p>}
      {text == null ? <Loading /> : <textarea className="skills-text" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} aria-label="Conteúdo da skill" />}
    </div>
  );
}

function NewSkill({ onClose, onCreated }: { onClose: () => void; onCreated: (path: string) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const slug = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  const path = `.claude/skills/planejai/${slug}.md`;
  const create = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/dev/skills/file", { method: "PUT", json: { path, content: `# ${name.trim()}\n\nComo funciona, onde está no código e as regras.\n`, sha: null } });
      haptic();
      onCreated(path);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Nova skill"
      onClose={onClose}
      footer={(close) => (
        <>
          <button className="btn" onClick={close}>Cancelar</button>
          <button className="btn btn-primary" disabled={busy || slug.length < 2} onClick={create}>{busy ? "Criando…" : "Criar e publicar"}</button>
        </>
      )}
    >
      <div className="field">
        <label htmlFor="skill-name">Assunto</label>
        <input id="skill-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Lembretes e agenda" autoFocus />
      </div>
      <p className="muted dev-hint">Vai virar <span className="mono">{slug ? path : "…"}</span> na main. Depois de criar, escreva o conteúdo e publique de novo.</p>
      {err && <ErrorBox error={err} />}
    </Modal>
  );
}

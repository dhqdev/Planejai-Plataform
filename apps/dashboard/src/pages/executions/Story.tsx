import { useMemo, useState } from "react";
import { Icon } from "../../icons";
import { haptic } from "../../touch";
import { AgentAvatar, PersonAvatar, StatusIcon } from "./Avatars";
import { clock, dur } from "./format";
import { TRIGGER_FALLBACK, TRIGGER_LABEL, agentMeta, argSummary, callLabel, delegateTarget, isDelegation, personOf, toolIcon, toolLabel, who } from "./labels";
import { Chips, ErrorText, IO } from "./StepParts";
import { stepTree, type Step, type StepTree } from "./steps";

/* ---------- História (linha do tempo) ---------- */

export function Story({ data, steps, clientAgents }: { data: any; steps: Step[]; clientAgents: any[] }) {
  const tree = useMemo(() => stepTree(steps), [steps]);
  const roots = tree.get(null) ?? [];
  const sent = steps.filter((s) => s.type === "channel" && s.name === "enviar_texto").length;
  const silent = data.output === "[[silencio]]";
  const person = personOf(data);

  return (
    <div className="tl">
      {data.content_purged && (
        <div className="tl-purged">
          <Icon name="shield" size={14} />{" "}
          {data.private
            ? "Conversa de um cliente: o texto é particular e fica só com ele. Aqui aparecem os passos, modelos, tempos e custos."
            : "O texto desta execução foi apagado por privacidade. Ficaram os passos, tempos e custos."}
        </div>
      )}

      <div className="tl-item tl-in">
        <div className="tl-rail"><PersonAvatar name={person ?? TRIGGER_LABEL[data.trigger]} size={30} /></div>
        <div className="tl-body">
          <div className="tl-head static">
            <span className="tl-title">{data.trigger === "message" || data.trigger === "playground" ? `${person ?? "Pessoa"} mandou` : TRIGGER_FALLBACK[data.trigger] ?? "Início"}</span>
            <span className="spacer" />
            <span className="tl-time mono">{clock(data.started_at)}</span>
          </div>
          {data.content_purged ? null : data.input ? <div className="bubble in">{data.input}</div> : <div className="tl-sub">sem texto</div>}
        </div>
      </div>

      <Steps list={roots} tree={tree} clientAgents={clientAgents} />

      {data.status === "running" ? (
        <div className="tl-item tl-running">
          <div className="tl-rail"><span className="tl-dot"><span className="ex-spin" /></span></div>
          <div className="tl-body"><div className="tl-head static"><span className="tl-title">Trabalhando…</span></div></div>
        </div>
      ) : data.status === "error" ? (
        <div className="tl-item tl-end err">
          <div className="tl-rail"><StatusIcon status="error" size={30} /></div>
          <div className="tl-body">
            <div className="tl-head static"><span className="tl-title">Parou com erro</span><span className="spacer" /><span className="tl-time mono">{dur(data.duration_ms)}</span></div>
            {data.error && (steps.some((st) => st.error && String(data.error).startsWith(st.error)) ? <div className="tl-sub">Mesmo erro do passo destacado acima.</div> : <ErrorText text={data.error} />)}
          </div>
        </div>
      ) : (
        <div className="tl-item tl-end">
          <div className="tl-rail"><StatusIcon status={data.status === "partial" ? "partial" : "success"} size={30} /></div>
          <div className="tl-body">
            <div className="tl-head static">
              <span className="tl-title">{silent ? "Concluída só com a reação" : data.status === "partial" ? "Respondeu com o que tinha" : "Resposta final"}</span>
              <span className="spacer" />
              <span className="tl-time mono">em {dur(data.duration_ms)}</span>
            </div>
            {data.status === "partial" && data.error && <div className="tl-sub tl-partial">{data.error}</div>}
            {!silent && !data.content_purged && data.output && !sent && <div className="bubble out">{data.output}</div>}
            {!silent && sent > 0 && <div className="tl-sub">Enviada acima, em {sent} balão(ões).</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function Steps({ list, tree, clientAgents }: { list: Step[]; tree: StepTree; clientAgents: any[] }) {
  return (
    <>
      {list.map((s) => (
        <StepItem key={s.id} step={s} kids={tree.get(s.id) ?? []} tree={tree} clientAgents={clientAgents} />
      ))}
    </>
  );
}

function StepItem({ step: s, kids, tree, clientAgents }: { step: Step; kids: Step[]; tree: StepTree; clientAgents: any[] }) {
  const [open, setOpen] = useState(false);
  const me = agentMeta(s.agent, clientAgents);
  const toggle = () => { haptic(4); setOpen(!open); };
  const err = s.status === "error";
  const running = s.status === "running";
  const time = <span className="tl-time mono">{running ? "…" : dur(s.duration_ms)}</span>;

  // Delegação: o CTO (ou um colega) chama um especialista; o trabalho dele fica aninhado
  if (s.type === "delegate") {
    const target = agentMeta(delegateTarget(s.name), clientAgents);
    const ask = s.input?.message ?? s.input?.question;
    const answer = s.output?.report ?? s.output?.answer;
    return (
      <div className={`tl-item tl-delegate ${err ? "err" : ""} ${running ? "running" : ""}`}>
        <div className="tl-rail"><AgentAvatar meta={target} size={30} /></div>
        <div className="tl-body">
          <div className="tl-head static">
            <span className="tl-title">{who(me)} chamou {who(target)}</span>
            <span className="tl-role">{target.name}</span>
            <span className="spacer" />
            {time}
          </div>
          {ask && <div className="tl-quote">{ask}</div>}
          {err && s.error && <ErrorText text={s.error} />}
          {kids.length > 0 && (
            <div className="tl-group">
              <Steps list={kids} tree={tree} clientAgents={clientAgents} />
            </div>
          )}
          {answer && (
            <div className={`tl-answer ${open ? "open" : ""}`}>
              <div className="tl-answer-head"><AgentAvatar meta={target} size={18} /> <strong>{who(target)}</strong> respondeu</div>
              <div className="tl-answer-text">{answer}</div>
              {String(answer).length > 280 && <button className="tl-link" onClick={toggle}>{open ? "mostrar menos" : "mostrar tudo"}</button>}
            </div>
          )}
        </div>
      </div>
    );
  }

  // Mensagem enviada para a pessoa
  if (s.type === "channel") {
    const text = s.input?.text;
    const progress = s.name === "aviso_andamento";
    return (
      <div className={`tl-item tl-send ${err ? "err" : ""}`}>
        <div className="tl-rail"><span className="tl-dot"><Icon name="send" size={13} /></span></div>
        <div className="tl-body">
          <div className="tl-head static">
            <span className="tl-title">{toolLabel(s.name)}</span>
            <span className="spacer" />
            <span className="tl-time mono">{clock(s.started_at)}</span>
          </div>
          {text ? <div className={`bubble out ${progress ? "soft" : ""}`}>{text}</div> : s.input?.media ? <div className="tl-sub">imagem anexada</div> : null}
          {err && s.error && <ErrorText text={s.error} />}
        </div>
      </div>
    );
  }

  // Trava ou atalho (sem IA)
  if (s.type === "info") {
    const guard = s.name.startsWith("trava");
    return (
      <div className={`tl-item tl-info ${guard ? "guard" : ""}`}>
        <div className="tl-rail"><span className="tl-dot"><Icon name={guard ? "shield" : "check"} size={13} /></span></div>
        <div className="tl-body">
          <div className="tl-head" onClick={toggle} role="button" aria-expanded={open}>
            <span className="tl-title">{s.name.charAt(0).toUpperCase() + s.name.slice(1)}</span>
            <span className="tl-sub inline">{argSummary(s.input)}</span>
            <span className="spacer" />
            <Icon name="chevron-right" size={14} className={`tl-chev ${open ? "open" : ""}`} />
          </div>
          {open && <IO step={s} />}
        </div>
      </div>
    );
  }

  // Chamada de IA: discreta e fechada por padrão
  if (s.type === "llm") {
    const said = typeof s.output?.content === "string" ? s.output.content.trim() : "";
    const calls: string[] = (s.output?.tool_calls ?? []).map((c: any) => c?.function?.name).filter(Boolean);
    return (
      <div className={`tl-item tl-llm ${err ? "err" : ""} ${running ? "running" : ""}`}>
        <div className="tl-rail"><span className="tl-dot small"><Icon name="sparkle" size={11} /></span></div>
        <div className="tl-body">
          <div className="tl-head" onClick={toggle} role="button" aria-expanded={open}>
            <span className="tl-title">{running ? `${who(me)} está pensando` : `${who(me)} pensou`}</span>
            {!open && calls.length > 0 && <span className="tl-sub inline">e decidiu: {calls.map((c) => callLabel(c, clientAgents)).join(", ")}</span>}
            <span className="spacer" />
            <Chips s={s} />
            {time}
            <Icon name="chevron-right" size={14} className={`tl-chev ${open ? "open" : ""}`} />
          </div>
          {err && s.error && <ErrorText text={s.error} />}
          {open && (
            <div className="tl-detail">
              {said && <div className="tl-said">{said}</div>}
              {calls.length > 0 && <div className="tl-calls">{calls.map((c, i) => <span key={i} className="chip"><Icon name={isDelegation(c) ? "arrow" : toolIcon(c)} size={12} /> {callLabel(c, clientAgents, true)}</span>)}</div>}
              <IO step={s} />
            </div>
          )}
        </div>
      </div>
    );
  }

  // Ferramenta
  const summary = argSummary(s.input);
  return (
    <div className={`tl-item tl-tool ${err ? "err" : ""} ${running ? "running" : ""}`}>
      <div className="tl-rail"><span className="tl-dot"><Icon name={toolIcon(s.name)} size={13} /></span></div>
      <div className="tl-body">
        <div className="tl-head" onClick={toggle} role="button" aria-expanded={open}>
          <span className="tl-title">{toolLabel(s.name)}</span>
          {s.output?.cache && <span className="chip-mini">cache</span>}
          <span className="spacer" />
          <Chips s={s} />
          {time}
          <Icon name="chevron-right" size={14} className={`tl-chev ${open ? "open" : ""}`} />
        </div>
        {summary && <div className="tl-sub">{summary}</div>}
        {err && s.error && <ErrorText text={s.error} />}
        {open && <IO step={s} />}
        {kids.length > 0 && (
          <div className="tl-group">
            <Steps list={kids} tree={tree} clientAgents={clientAgents} />
          </div>
        )}
      </div>
    </div>
  );
}

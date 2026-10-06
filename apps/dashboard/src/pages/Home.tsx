import { Link } from "react-router-dom";
import { brl, day, when } from "../api";
import type { Me } from "../App";
import { CATEGORY_COLORS, Donut, Empty, ErrorBox, Loading, PageHead, Stat } from "../components";
import { useApi } from "../hooks";

/** Início do admin: só os dados da própria pessoa. */
export function HomePage({ me }: { me: Me }) {
  const { data, error } = useApi<any>("/api/me/overview", { poll: 20000 });
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  if (!data) return <Loading />;
  const exp = Number(data.money.expenses_month);
  const prev = Number(data.money.expenses_prev);
  const cats = data.byCategory.map((c: any) => ({ label: c.category, value: Number(c.total) }));
  const first = (me.name ?? "").split(" ")[0];
  return (
    <div className="page">
      <PageHead title={`Oi${first ? `, ${first}` : ""}! 👋`} subtitle="Um resumo do que o seu assistente está cuidando para você." />
      {!me.linked && <div className="error-box" style={{ marginBottom: 14 }}>Sua conta ainda não está ligada a um número de WhatsApp. Fale com o administrador.</div>}
      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat label="Gastos no mês" value={brl(exp)} icon="💸" sub={prev ? <span className={exp > prev ? "trend-up" : "trend-down"}>{exp > prev ? "▲" : "▼"} {brl(Math.abs(exp - prev))} vs mês passado</span> : "este mês"} />
        <Stat label="Receitas no mês" value={brl(data.money.income_month)} icon="💵" tone="ok" />
        <Stat label="Lembretes ativos" value={data.counts.reminders} icon="⏰" tone="info" />
        <Stat label="Coisas que ele sabe de você" value={data.counts.memories} icon="🧩" tone="warn" sub={`${data.counts.messages_24h} mensagens nas últimas 24h`} />
      </div>
      <div className="grid grid-2">
        <div className="card card-pad">
          <div className="row"><h3 style={{ margin: 0 }}>Gastos por categoria</h3><span className="spacer" /><Link className="btn btn-sm" to="/finance">Ver tudo</Link></div>
          {cats.length ? (
            <div className="donut-wrap" style={{ marginTop: 12 }}>
              <Donut items={cats} size={140} center={<strong>{brl(exp)}</strong>} />
              <div className="legend">
                {cats.slice(0, 7).map((c: any, i: number) => (
                  <div className="item" key={c.label}><span className="sw" style={{ background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />{c.label}<strong>{brl(c.value)}</strong></div>
                ))}
              </div>
            </div>
          ) : <Empty>Mande "gastei 25 no almoço" ou a foto de um comprovante no WhatsApp.</Empty>}
        </div>
        <div className="card card-pad">
          <div className="row"><h3 style={{ margin: 0 }}>Próximos lembretes</h3><span className="spacer" /><Link className="btn btn-sm" to="/reminders">Ver todos</Link></div>
          {data.nextReminders.map((r: any) => (
            <div key={r.id} className="row" style={{ padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
              <span>⏰</span><span style={{ flex: 1 }}>{r.intent}</span><span className="muted">{r.cron ? "recorrente" : when(r.due_at)}</span>
            </div>
          ))}
          {!data.nextReminders.length && <Empty>Nenhum lembrete. Diga "me lembra de pagar a luz dia 10".</Empty>}
          <h3 style={{ marginTop: 18 }}>Últimos lançamentos</h3>
          {data.recent.map((t: any) => (
            <div key={t.id} className="row" style={{ padding: "6px 0" }}>
              <span className="chip">{t.category}</span><span style={{ flex: 1 }} className="ellipsis">{t.description ?? t.merchant ?? ""}</span>
              <span className="muted">{day(t.occurred_at)}</span>
              <span className={t.kind === "income" ? "amount-in" : "amount-out"}>{brl(t.amount)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

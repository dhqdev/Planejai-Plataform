import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Me } from "../App";
import { useApi } from "../hooks";
import { Icon } from "../icons";
import { useInstallAction } from "../Install";
import { openWardrobe } from "../mascote/state";
import { MASCOTE } from "../mascote/nome";
import { UserMascote } from "../mascote/UserMascote";
import { MascoteIcon } from "../mascote/Wardrobe";
import { type BillingLite, grainUse, pct } from "../plano";
import { haptic } from "../touch";

declare const __APP_VERSION__: string;

export type MenuLink = { to: string; label: string; icon: string; badge?: string; short?: string };

/**
 * Conta (último item da barra do celular e o mascote no pé do trilho do notebook), no jeito do Toki:
 * cartão da pessoa com o plano e quanto dos grãos já usou (toque abre Meu plano), depois as telas em
 * listas agrupadas e, no fim, os ajustes (mascote, tema, instalar o app, sair).
 * No notebook as listas de telas somem (já estão no trilho) e fica só o que é da conta.
 */
export function ContaPage({ me, sections, theme, onTheme, onLogout, unread }: {
  me: Me;
  sections: { title: string; items: MenuLink[] }[];
  theme: string;
  onTheme: (e?: { clientX: number; clientY: number }) => void;
  onLogout: () => void;
  unread: number;
}) {
  const nav = useNavigate();
  const isSuper = me.role === "superadmin";
  const billing = useApi<BillingLite>(isSuper ? null : "/api/billing");
  const use = grainUse(billing.data);
  const install = useInstallAction();
  const role = me.owner ? "Dono da stack" : isSuper ? "Super admin" : null;
  const account = sections.find((s) => s.title === "Conta")?.items.filter((i) => i.to !== "/plano") ?? [];
  const screens = sections.filter((s) => s.title !== "Conta" && s.items.length);
  const go = (to: string) => {
    haptic(5);
    nav(to);
  };

  return (
    <div className="page conta-page">
      <h1 className="sr-only">Conta</h1>
      <div className="conta-grid">
        <section className="conta-card" aria-label="Você">
          <div className="conta-who">
            <UserMascote me name={me.name ?? me.email} size={58} />
            <div className="conta-who-text">
              <strong>{me.name ?? me.email}</strong>
              <span>{me.email}</span>
            </div>
            <Link className="conta-edit" to="/profile" aria-label="Editar perfil" title="Editar perfil" onClick={() => haptic(5)}>
              <Icon name="edit" size={18} />
            </Link>
          </div>
          {use ? (
            <>
              <div className="conta-plan">
                <span className="conta-plan-name">{use.plan}</span>
                {use.canUpgrade && (
                  <Link className="btn btn-primary btn-sm conta-up" to="/plano#planos" onClick={() => haptic(10)}>
                    {use.plan === "Grátis" ? "Assinar" : "Subir de plano"}
                  </Link>
                )}
              </div>
              <Link className="conta-quota" to="/plano" onClick={() => haptic(5)}>
                <span className="conta-quota-row">
                  <span>Grãos usados</span>
                  <b>{use.used != null ? pct(use.used) : `${use.left} grãos`}</b>
                  <Icon name="chevron-right" size={16} />
                </span>
                <span className="conta-bar" role="img" aria-label={use.used != null ? `${pct(use.used)} dos grãos usados, sobram ${use.left}` : `${use.left} grãos`}>
                  <i style={{ width: `${Math.round((use.used ?? 0) * 100)}%` }} />
                </span>
              </Link>
            </>
          ) : (
            <div className="conta-plan">
              <span className="conta-plan-name">{role ?? "Grátis"}</span>
              {!isSuper && billing.data && !billing.data.linked && <Link className="btn btn-sm" to="/profile">Ligar WhatsApp</Link>}
            </div>
          )}
        </section>

        <div className="conta-lists">
          {screens.map((sec) => (
            <Group key={sec.title} title={sec.title} className="conta-screens">
              {sec.items.map((it) => (
                <Row key={it.to} icon={<Icon name={it.icon} size={21} />} label={it.label} onClick={() => go(it.to)} />
              ))}
            </Group>
          ))}

          <Group title="Conta">
            {use && <Row icon={<Icon name="card" size={21} />} label="Meu plano" value={use.plan} onClick={() => go("/plano")} />}
            {account.map((it) => (
              <Row
                key={it.to}
                icon={<Icon name={it.icon} size={21} />}
                label={it.label}
                value={it.badge === "notif" && unread > 0 ? `${unread} ${unread === 1 ? "nova" : "novas"}` : undefined}
                dot={it.badge === "notif" && unread > 0}
                onClick={() => go(it.to)}
              />
            ))}
          </Group>

          <Group title="Ajustes">
            <Row icon={<span className="conta-mascote"><MascoteIcon size={26} /></span>} label={`Roupinha do ${MASCOTE}`} onClick={() => (haptic(5), openWardrobe())} />
            <Row icon={<Icon name={theme === "dark" ? "moon" : "sun"} size={21} />} label="Tema" value={theme === "dark" ? "Escuro" : "Claro"} onClick={(e) => onTheme(e)} />
            {install.mode && <Row icon={<Icon name="download" size={21} />} label="Instalar o app" value={install.mode === "prompt" ? "1 toque" : undefined} onClick={install.run} />}
            <Row icon={<Icon name="logout" size={21} />} label="Sair" danger onClick={onLogout} />
          </Group>
          <p className="conta-version">Planejai v{__APP_VERSION__}</p>
        </div>
      </div>
      {install.sheet}
    </div>
  );
}

function Group({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`conta-group${className ? ` ${className}` : ""}`} aria-label={title}>
      <h2>{title}</h2>
      <div className="conta-rows">{children}</div>
    </section>
  );
}

function Row({ icon, label, value, dot, danger, onClick }: { icon: ReactNode; label: string; value?: string; dot?: boolean; danger?: boolean; onClick: (e: { clientX: number; clientY: number }) => void }) {
  return (
    <button type="button" className={`conta-row${danger ? " danger" : ""}`} onClick={onClick}>
      <span className="conta-row-ico">{icon}{dot && <i className="conta-dot" />}</span>
      <span className="conta-row-label">{label}</span>
      {value && <span className="conta-row-value">{value}</span>}
      {!danger && <Icon name="chevron-right" size={16} />}
    </button>
  );
}

import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { type Alarm, AlarmSettings, alarmTime } from "../Alarms";
import { ErrorBox, PageHead } from "../components";
import { useApi } from "../hooks";
import { haptic } from "../touch";

/** Toque simples de telefone (duas notas, pausa), só enquanto a tela do alarme está aberta. */
function useRingtone(on: boolean) {
  const ctx = useRef<AudioContext | null>(null);
  useEffect(() => {
    if (!on) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      ctx.current = new AudioContext();
    } catch {
      return;
    }
    const ac = ctx.current;
    const ring = () => {
      if (stopped) return;
      const t = ac.currentTime;
      for (let i = 0; i < 2; i++) {
        const osc = ac.createOscillator();
        const gain = ac.createGain();
        osc.frequency.value = i ? 480 : 440;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.15, t + 0.05);
        gain.gain.setValueAtTime(0.15, t + 1.2);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.3);
        osc.connect(gain).connect(ac.destination);
        osc.start(t);
        osc.stop(t + 1.35);
      }
      navigator.vibrate?.([900, 400, 900]);
      timer = setTimeout(ring, 3000);
    };
    void ac.resume().catch(() => {});
    ring();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      navigator.vibrate?.(0);
      void ac.close().catch(() => {});
    };
  }, [on]);
}

/** Tela aberta pela notificação do alarme: o alarme na tela, como uma ligação, com Parar e Soneca. */
export function AlarmPage() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const id = params.get("id");
  const test = params.get("teste") === "1";
  const { data, reload } = useApi<{ alarms: Alarm[] }>("/api/alarms");
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alarm = id ? data?.alarms.find((a) => a.id === id) : null;
  const ringing = !done && (test || alarm?.status === "rang");
  useRingtone(ringing);

  const act = async (action: "stop" | "snooze") => {
    haptic(12);
    setError(null);
    if (test || !alarm) {
      setDone("Alarme parado.");
      return;
    }
    try {
      const r = await api<{ ringAt?: string }>(`/api/alarms/${alarm.id}/${action}`, { method: "POST" });
      setDone(action === "snooze" && r.ringAt ? `Toca de novo ${alarmTime(r.ringAt)}.` : "Alarme parado.");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="page" style={{ maxWidth: 640 }}>
      {ringing ? (
        <div className="alarm-call" role="alertdialog" aria-labelledby="alarm-label">
          <p className="alarm-caller">Planejai está te ligando</p>
          <h1 id="alarm-label" className="alarm-label">{test ? "Teste de alarme" : alarm?.label}</h1>
          {alarm && <p className="muted">{alarmTime(alarm.ring_at)}</p>}
          <ErrorBox error={error} />
          <div className="alarm-actions">
            <button className="btn alarm-btn" onClick={() => act("snooze")} disabled={test || (alarm?.snoozes ?? 0) >= 6}>Soneca 5 min</button>
            <button className="btn btn-primary alarm-btn" onClick={() => act("stop")} autoFocus>Parar</button>
          </div>
        </div>
      ) : (
        <>
          <PageHead title="Alarmes" subtitle={done ?? (id && data && !alarm ? "Esse alarme já foi parado." : undefined)} />
          <AlarmSettings />
          <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => nav("/")}>Voltar ao início</button>
        </>
      )}
    </div>
  );
}

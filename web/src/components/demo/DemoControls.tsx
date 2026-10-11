import { BellRing, RotateCcw, Smartphone } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type PhoneView } from "../../lib/api.ts";

/** Which registered phone receives FinGuard's texts. */
export function PhonePicker() {
  const operator = useMemo(() => api("operator"), []);
  const [phones, setPhones] = useState<PhoneView[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    operator.phones().then(setPhones, () => undefined);
  }, [operator]);
  if (phones.length < 2) return null;
  const use = async (id: number) => {
    setBusy(true);
    try {
      setPhones((await operator.usePhone(id)).phones);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="demo-phones" role="group" aria-label="Phone that receives texts">
      {phones.map((p) => (
        <button key={p.id} type="button" className={`btn btn-sm${p.active ? " btn-primary" : ""}`} aria-pressed={p.active} disabled={busy} onClick={() => use(p.id)}>
          <Smartphone size={13} aria-hidden /> {p.label}
        </button>
      ))}
    </div>
  );
}

/** Demo controls on the phone: the texting phone, alerts now, and a clean start. */
export function DemoControls() {
  const operator = useMemo(() => api("operator"), []);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote(await fn());
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card card-pad demo-controls" aria-label="Demo controls">
      <h2 className="section-title">Demo</h2>
      <PhonePicker />
      <div className="demo-row">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(async () => `${(await operator.runNudges()).length} alerts sent`)}>
          <BellRing size={13} aria-hidden /> Send alerts
        </button>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => run(async () => (await operator.reset(true), "Reset"))}>
          <RotateCcw size={13} aria-hidden /> Reset and agree
        </button>
      </div>
      {note && <p className="faint">{note}</p>}
    </section>
  );
}

import { useEffect, useState } from "react";
import { formatUsd, shortHash, clockTime } from "../../lib/format.ts";
import { BRAND } from "../../lib/brand.ts";
import { DemoControls } from "../../components/demo/DemoControls.tsx";
import type { AppCtx } from "../CustomerApp.tsx";

export function SettingsScreen({ ctx }: { ctx: AppCtx }) {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "system");
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);
  const policy = ctx.state?.policy;
  const own = policy?.grants.find((g) => g.capability === "transfers.own");
  const [autoLimit, setAutoLimit] = useState(String(own?.maxAmount ?? ""));
  const [daily, setDaily] = useState(String(policy?.dailyLimit ?? ""));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (!policy) return <div className="screen muted">Loading</div>;

  const save = async () => {
    const auto = Number(autoLimit);
    const day = Number(daily);
    if (!(auto >= 0) || !(day > 0)) return setMessage("Enter amounts in dollars.");
    setBusy(true);
    setMessage(null);
    try {
      const grants = policy.grants.map((g) => (g.capability === "transfers.own" ? { ...g, maxAmount: auto } : g));
      await ctx.api.updatePolicy({ grants, dailyLimit: day }, "limits changed in settings");
      setMessage(`Saved as a new policy version. Agree to it to let ${BRAND} move money again.`);
      ctx.refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const consent = ctx.state?.consent;
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Settings</h1>
      </header>
      <section className="card card-pad form">
        <h2 className="section-title">Limits</h2>
        <p className="faint form-lead">{BRAND} can only do what these allow. Changes need your agreement again.</p>
        <label htmlFor="auto-limit">Automatic between your accounts, up to</label>
        <div className="money-input">
          <span>$</span>
          <input id="auto-limit" inputMode="decimal" value={autoLimit} onChange={(e) => setAutoLimit(e.target.value)} />
        </div>
        <label htmlFor="daily-limit">Daily limit for all money actions</label>
        <div className="money-input">
          <span>$</span>
          <input id="daily-limit" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
        </div>
        <p className="faint">Bills and payments to other people always ask you first.</p>
        {message && <p className="form-msg" role="status">{message}</p>}
        <button type="button" className="btn btn-primary btn-block" onClick={save} disabled={busy}>
          {busy ? "Saving" : "Save limits"}
        </button>
      </section>

      <section className="card card-pad stack-sm">
        <h2 className="section-title">Saved payees</h2>
        {policy.savedPayees.map((p) => (
          <div key={p.id} className="kv-row">
            <span>{p.name}</span>
            <span className="faint num">...{p.account.slice(-4)}</span>
          </div>
        ))}
      </section>

      {policy.trustedContact && (
        <section className="card card-pad stack-sm">
          <h2 className="section-title">Trusted contact</h2>
          <p>
            {BRAND} records an alert for <strong>{policy.trustedContact.name}</strong> when it stops a likely scam.
          </p>
        </section>
      )}

      <section className="card card-pad stack-sm">
        <h2 className="section-title">Your agreement</h2>
        {consent ? (
          <p className="faint">
            Policy v{consent.policyVersion} agreed at <span className="num">{clockTime(consent.acceptedAt)}</span> in the {consent.channel}, record <span className="mono">{consent.id}</span>, policy hash{" "}
            <span className="hash">{shortHash(consent.policyHash)}</span>
          </p>
        ) : (
          <p className="error-text">You have not agreed to policy v{policy.version}, so {BRAND} will not move money.</p>
        )}
        <p className="faint num">Daily limit used: {formatUsd(ctx.state?.spentToday ?? 0)}</p>
      </section>

      <section className="card card-pad stack-sm" aria-label="Appearance">
        <h2 className="section-title">Appearance</h2>
        <div className="seg">
          {["system", "light", "dark"].map((value) => <button key={value} type="button" className="btn seg-btn" aria-pressed={theme === value} onClick={() => setTheme(value)}>{value === "system" ? "System" : value === "light" ? "Light" : "Dark"}</button>)}
        </div>
      </section>
      <DemoControls />
    </div>
  );
}

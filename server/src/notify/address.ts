import os from "node:os";

export function appUrl(env: NodeJS.ProcessEnv, port: number): string | undefined {
  if (env.FINGUARD_APP_URL) return env.FINGUARD_APP_URL.replace(/\/+$/, "");
  if (env.FINGUARD_APP_URL === "") return undefined; // set but empty: no links
  const addrs = Object.entries(os.networkInterfaces())
    .sort(([a], [b]) => Number(!/^(en|eth|wlan)\d/.test(a)) - Number(!/^(en|eth|wlan)\d/.test(b)))
    .flatMap(([name, list]) => (list ?? []).map((a) => ({ ...a, wifi: /^(en|eth|wlan)\d/.test(name) })))
    .filter((a) => a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254."));
  const lan = addrs.find((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) ?? addrs.find((a) => a.wifi);
  return lan ? `http://${lan.address}:${port}` : undefined;
}

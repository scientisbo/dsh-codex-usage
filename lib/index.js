/**
 * dsh-codex-usage — host 插件。
 * 只读回环路由 GET /api/dsh-usage/overview（5 分钟内存缓存；?refresh=1 或 no-cache 头强制穿透）。
 * codex 配额 ← 锁定版 @openai/codex@0.147.0 app-server；DeepSeek 余额 ← 官方 /user/balance。
 */
import { collectCodexOverview } from "./codex.js";

const name = "codex-usage";
const inject = ["webServer", "credentials"];
const OVERVIEW_PATH = "/api/dsh-usage/overview";
const DEFAULTS = {
  apiKeyRef: "DEEPSEEK_API_KEY",
  codexUsageUrl: "https://codex.app/account/usage",
  deepseekUsageUrl: "https://platform.deepseek.com/usage",
  refreshMs: 5 * 60 * 1000,
  timeoutMs: 30000,
};

//#region 回环护栏与工具（借鉴 dsh-deepseek-usage，MIT License）
function json(res, status, value) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache",
  });
  res.end(JSON.stringify(value));
}
function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const value = address.toLowerCase();
  if (value === "::1") return true;
  const ipv4 = value.startsWith("::ffff:") ? value.slice(7) : value;
  const octets = ipv4.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function hostNameOf(value) {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close <= 1) return null;
    const suffix = host.slice(close + 1);
    if (suffix !== "" && !/^:\d+$/.test(suffix)) return null;
    return host.slice(1, close);
  }
  const firstColon = host.indexOf(":");
  const lastColon = host.lastIndexOf(":");
  if (firstColon !== lastColon) return host;
  if (lastColon === -1) return host.replace(/\.$/, "");
  if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
  return host.slice(0, lastColon).replace(/\.$/, "");
}
function isLoopbackHostHeader(req) {
  const host = hostNameOf(req.headers.host);
  return host === "localhost" || isLoopbackAddress(host);
}
function rejectForeignCaller(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
    return true;
  }
  if (isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackHostHeader(req)) return false;
  json(res, 403, { ok: false, error: "forbidden" });
  return true;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function normalizeConfig(value) {
  const input = value !== null && typeof value === "object" ? value : {};
  const config = { ...DEFAULTS };
  for (const key of ["apiKeyRef", "codexUsageUrl", "deepseekUsageUrl"]) {
    const text = nonEmptyString(input[key]);
    if (text !== null) config[key] = text;
  }
  for (const key of ["refreshMs", "timeoutMs"]) {
    const parsed = Number(input[key]);
    if (Number.isFinite(parsed) && parsed > 0) config[key] = Math.floor(parsed);
  }
  return config;
}
async function resolveCredential(ctx, ref) {
  const credentials = ctx.get("credentials") ?? ctx.credentials;
  if (credentials && typeof credentials.resolve === "function") {
    try {
      const hit = await credentials.resolve(ref);
      const value = nonEmptyString(hit?.value);
      if (value !== null) return value;
    } catch { /* 落到环境变量回退 */ }
  }
  return nonEmptyString(process.env[ref]);
}
//#endregion

let cache = { fetchedAt: 0, payload: null };
let inflight = null;

async function fetchDeepSeekBalance(apiKey, timeoutMs) {
  const res = await fetch("https://api.deepseek.com/user/balance", {
    headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 401 || res.status === 403) throw new Error(`DeepSeek 鉴权失败 (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`DeepSeek 上游 HTTP ${res.status}`);
  const payload = await res.json();
  const list = (Array.isArray(payload?.balance_infos) ? payload.balance_infos : []).filter((x) => x && typeof x === "object");
  if (list.length === 0) return null;
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const pick = list.find((i) => i.currency === "USD" && num(i.total_balance) > 0) ?? list[0];
  return {
    currency: String(pick.currency ?? "USD").toUpperCase(),
    total: num(pick.total_balance),
    granted: num(pick.granted_balance),
    toppedUp: num(pick.topped_up_balance),
  };
}

async function collect(ctx, config, { force }) {
  const now = Date.now();
  if (!force && cache.payload && now - cache.fetchedAt < config.refreshMs) return cache.payload;
  if (inflight) return inflight;
  inflight = (async () => {
    const codex = await collectCodexOverview({ timeoutMs: config.timeoutMs });
    let balance = null;
    try {
      const apiKey = await resolveCredential(ctx, config.apiKeyRef);
      if (apiKey) balance = await fetchDeepSeekBalance(apiKey, config.timeoutMs);
    } catch { /* 余额可选，失败不影响 codex */ }
    const payload = {
      ok: true,
      updatedAt: Date.now(),
      codex,
      deepseek: { balance },
      links: { codexUsage: config.codexUsageUrl, deepseekUsage: config.deepseekUsageUrl },
    };
    cache = { fetchedAt: payload.updatedAt, payload };
    return payload;
  })();
  try { return await inflight; } finally { inflight = null; }
}

async function handleOverview(ctx, config, req, res) {
  if (rejectForeignCaller(req, res)) return;
  try {
    const url = new URL(req.url ?? "/", "http://dsh.invalid");
    const force = url.searchParams.has("refresh") || /no-cache/i.test(req.headers["cache-control"] ?? "");
    json(res, 200, await collect(ctx, config, { force }));
  } catch (error) {
    ctx.logger?.warn?.(`codex-usage: ${String(error?.message ?? error)}`);
    json(res, 500, { ok: false, error: error?.message ?? String(error) });
  }
}

async function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  ctx.effect(
    () => ctx.webServer.register({
      kind: "exact",
      path: OVERVIEW_PATH,
      handler: (req, res) => handleOverview(ctx, config, req, res),
    }),
    "codex-usage: overview route"
  );
}

const Config = {
  "~standard": {
    version: 1,
    vendor: "codex-usage",
    validate(value) {
      try {
        return { value: normalizeConfig(value) };
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
      }
    },
  },
};

export { apply, Config, inject, name, OVERVIEW_PATH };

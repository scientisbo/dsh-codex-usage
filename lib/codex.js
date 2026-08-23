/**
 * codex.js — 通过锁定版 @openai/codex@0.147.0 的 app-server 协议读取订阅配额。
 * account/read（账户/计划）→ account/rateLimits/read（滚动窗口百分比）。
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const codexPkgPath = require.resolve("@openai/codex/package.json");
const codexManifest = JSON.parse(readFileSync(codexPkgPath, "utf8"));
const WRAPPER = resolve(dirname(codexPkgPath), codexManifest.bin.codex);

function classifyWindow(mins) {
  if (!Number.isFinite(mins)) return null;
  if (mins === 300) return "5h";
  if (mins === 10080) return "7d";
  if (mins >= 40320 && mins <= 44640) return "month";
  return null;
}

function formatResetIn(resetsAtSec) {
  if (!Number.isFinite(resetsAtSec) || resetsAtSec <= 0) return null;
  const ms = resetsAtSec * 1000 - Date.now();
  if (ms <= 0) return "0m";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 24) return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function windowsFrom(rateLimits) {
  const order = ["5h", "7d", "month"];
  const seen = new Map();
  for (const slot of [rateLimits?.primary, rateLimits?.secondary]) {
    if (slot === null || typeof slot !== "object") continue;
    const label = classifyWindow(Number(slot.windowDurationMins));
    if (label === null || seen.has(label)) continue;
    const usedPercent = Number(slot.usedPercent);
    seen.set(label, {
      label,
      usedPercent: Number.isFinite(usedPercent) ? Math.min(100, Math.max(0, usedPercent)) : 0,
      resetIn: formatResetIn(Number(slot.resetsAt)),
      resetsAt: (() => {
        const sec = Number(slot.resetsAt);
        return Number.isFinite(sec) && sec > 0 ? sec * 1000 : null;
      })(),
    });
  }
  return order.filter((label) => seen.has(label)).map((label) => seen.get(label));
}

/** 打开一次 app-server，按顺序调用若干 JSON-RPC 方法，返回 { method: result }。 */
function runAppServerCalls(calls, { timeoutMs = 30000 } = {}) {
  return new Promise((resolveOuter, rejectOuter) => {
    const child = spawn(process.execPath, [WRAPPER, "app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = "";
    let seq = 0;
    const pending = new Map();
    const results = {};
    let settled = false;
    const cleanup = () => { try { child.kill("SIGTERM"); } catch {} };
    const fail = (err) => { if (!settled) { settled = true; rejectOuter(err); cleanup(); } };
    const timer = setTimeout(() => fail(new Error("codex app-server 超时")), timeoutMs);

    function send(method, params) {
      const id = String(++seq);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return new Promise((res, rej) => pending.set(id, { res, rej }));
    }

    child.stdout.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(String(msg.id))) {
          const p = pending.get(String(msg.id));
          pending.delete(String(msg.id));
          msg.error ? p.rej(new Error(msg.error.message ?? JSON.stringify(msg.error))) : p.res(msg.result);
        }
      }
    });
    child.stderr.on("data", () => {});
    child.on("error", (err) => fail(new Error(`无法启动 codex: ${err.message}`)));
    child.on("exit", (code) => { if (!settled && code !== 0) fail(new Error(`codex 进程提前退出 (code ${code})`)); });

    (async () => {
      try {
        await send("initialize", {
          clientInfo: { name: "dsh-codex-usage", title: "DSH Codex Usage", version: "0.1.0" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        });
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
        for (const { method, params } of calls) {
          try {
            results[method] = { ok: true, result: await send(method, params ?? {}) };
          } catch (err) {
            results[method] = { ok: false, error: err?.message ?? String(err) };
          }
        }
        clearTimeout(timer);
        finish(resolveOuter, results);
        cleanup();
      } catch (err) {
        fail(err);
      }
    })();

    function finish(fn, value) { if (!settled) { settled = true; fn(value); } }
  });
}

function friendlyError(message) {
  const text = String(message ?? "");
  if (/error sending request|SSL|ECONN|ENOTFOUND|EAI_|fetch failed|network|connect/i.test(text)) {
    return "Codex 后端不可达（网络/VPN 未连通）";
  }
  if (/unauthorized|401|403|not logged in|auth/i.test(text)) {
    return "Codex 未登录（请先 codex login）";
  }
  return text;
}

/** 汇总 Codex 订阅配额为 { configured, windows, error }。 */
export async function collectCodexOverview({ timeoutMs } = {}) {
  try {
    const results = await runAppServerCalls(
      [{ method: "account/read" }, { method: "account/rateLimits/read" }],
      { timeoutMs }
    );
    const accountEntry = results["account/read"];
    if (!accountEntry?.ok) {
      return { configured: false, windows: [], error: friendlyError(accountEntry?.error) };
    }
    const account = accountEntry.result?.account;
    if (!account) {
      return { configured: false, windows: [], error: "Codex 未登录（请先 codex login）" };
    }
    const limitsEntry = results["account/rateLimits/read"];
    if (!limitsEntry?.ok) {
      return { configured: true, windows: [], error: friendlyError(limitsEntry?.error) };
    }
    return {
      configured: true,
      windows: windowsFrom(limitsEntry.result?.rateLimits),
      error: null,
    };
  } catch (err) {
    return { configured: false, windows: [], error: friendlyError(err?.message ?? String(err)) };
  }
}

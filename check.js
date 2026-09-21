const fs = require("fs");
const crypto = require("crypto");

const CONFIG = JSON.parse(fs.readFileSync("apps.json", "utf8"));
const SLOW_MS = CONFIG.slowMs || 5000;
const TIMEOUT_MS = CONFIG.timeoutMs || 20000;
const HISTORY_KEEP = 60;
const RENOTIFY_EVERY = 4;

const STATUS_FILE = "status.json";
const HISTORY_FILE = "history.json";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function kst(date) {
  return new Date(date).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

async function timedFetch(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": "app-monitor/1.0", "Cache-Control": "no-cache" },
    });
    const text = await res.text();
    return { status: res.status, finalUrl: res.url, text, ms: Date.now() - start };
  } catch (err) {
    const reason = err.name === "AbortError" ? `timeout ${TIMEOUT_MS / 1000}s` : String(err.message || err);
    return { error: reason, ms: Date.now() - start };
  } finally {
    clearTimeout(timer);
  }
}

function stage(state, ms, detail) {
  return { state, ms: ms ?? null, detail: detail || "" };
}

async function checkPages(url) {
  if (!url) return stage("none", null, "URL 없음");
  const r = await timedFetch(url);
  if (r.error) return stage("fail", r.ms, r.error);
  if (r.status !== 200) return stage("fail", r.ms, `HTTP ${r.status}`);
  if (!/<html|<!doctype/i.test(r.text.slice(0, 500))) return stage("fail", r.ms, "HTML 아님");
  return stage(r.ms > SLOW_MS ? "warn" : "ok", r.ms, r.ms > SLOW_MS ? "응답 느림" : `HTTP 200`);
}

function isRealGasUrl(url) {
  return typeof url === "string" && /^https:\/\/script\.google\.com\/macros\/s\/.+\/exec/.test(url);
}

async function checkGas(url) {
  if (!url) return { gas: stage("none", null, "GAS 없음"), data: stage("none", null, "") };
  if (!isRealGasUrl(url)) return { gas: stage("skip", null, "GAS URL 미설정"), data: stage("skip", null, "") };

    const pingUrl = url + (url.includes("?") ? "&" : "?") + "action=ping&_=" + Date.now();
  let r = await timedFetch(pingUrl);
  if (r.error || (r.status !== 200 && !/accounts\.google\.com/.test(r.finalUrl || ""))) {
    await new Promise((ok) => setTimeout(ok, 8000));
    const retry = await timedFetch(pingUrl);
    if (!retry.error && retry.status === 200) r = retry;
    else r.detail = "재시도 후에도 실패";
  }
  if (r.error) return { gas: stage("fail", r.ms, r.error), data: stage("skip", null, "건너뜀") };
  if (/accounts\.google\.com/.test(r.finalUrl || "")) {
    return {
      gas: stage("fail", r.ms, "로그인 리다이렉트 — 배포 액세스 권한이 '모든 사용자'인지 확인"),
      data: stage("skip", null, "건너뜀"),
    };
  }
  if (r.status !== 200) return { gas: stage("fail", r.ms, `HTTP ${r.status}`), data: stage("skip", null, "건너뜀") };

  let json;
  try {
    json = JSON.parse(r.text);
  } catch {
    const head = r.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    const hint = /ping/i.test(head) || head === "" ? "ping 미구현 또는 스크립트 오류" : head;
    return { gas: stage("fail", r.ms, "JSON 응답 아님 — " + hint), data: stage("skip", null, "건너뜀") };
  }

  const gasState = r.ms > SLOW_MS ? "warn" : "ok";
  const gasDetail = r.ms > SLOW_MS ? "응답 느림" : json.version ? `v${json.version}` : "응답 정상";

  if (json.ok === false) {
    return { gas: stage(gasState, r.ms, gasDetail), data: stage("fail", null, json.error || "데이터 읽기 실패") };
  }
  const summary = json.data
    ? Object.entries(json.data).map(([k, v]) => `${k} ${v}`).join(" · ")
    : "ok";
  return { gas: stage(gasState, r.ms, gasDetail), data: stage("ok", null, summary) };
}

function overallOf(stages) {
  const states = Object.values(stages).map((s) => s.state);
  if (states.includes("fail")) return "fail";
  if (states.includes("warn")) return "warn";
  return "ok";
}

async function checkApp(app) {
  const [pages, gasRes] = await Promise.all([checkPages(app.pages), checkGas(app.gas)]);
  const stages = { pages, gas: gasRes.gas, data: gasRes.data };
  return { ...app, stages, overall: overallOf(stages) };
}

async function sendSolapi(text) {
  const key = process.env.SOLAPI_API_KEY;
  const secret = process.env.SOLAPI_API_SECRET;
  const from = process.env.SOLAPI_FROM;
  const to = process.env.SOLAPI_TO;
  if (!key || !secret || !from || !to) {
    console.log("[notify] Solapi secrets 미설정 — 알림 건너뜀\n" + text);
    return;
  }
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString("hex");
  const signature = crypto.createHmac("sha256", secret).update(date + salt).digest("hex");
  const body = {
    messages: to.split(",").map((t) => ({
      to: t.trim(),
      from,
      subject: "[앱 모니터]",
      text,
    })),
  };
  const res = await fetch("https://api.solapi.com/messages/v4/send-many/detail", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `HMAC-SHA256 apiKey=${key}, date=${date}, salt=${salt}, signature=${signature}`,
    },
    body: JSON.stringify(body),
  });
  console.log("[notify] Solapi", res.status, (await res.text()).slice(0, 200));
}

async function main() {
  const now = new Date();
  const prev = readJson(STATUS_FILE, { apps: [] });
  const history = readJson(HISTORY_FILE, {});
  const prevById = Object.fromEntries((prev.apps || []).map((a) => [a.id, a]));

  const results = await Promise.all(CONFIG.apps.map(checkApp));

  const alerts = [];
  const recovered = [];

  const apps = results.map((r) => {
    const p = prevById[r.id] || {};
    const failing = r.overall === "fail";
    const streak = failing ? (p.streak || 0) + 1 : 0;
    const lastOkAt = r.overall !== "fail" ? now.toISOString() : p.lastOkAt || null;
    const firstFailAt = failing ? p.firstFailAt || now.toISOString() : null;

    const failedStage = Object.entries(r.stages).find(([, s]) => s.state === "fail");
    const reason = failedStage ? `${failedStage[0]}: ${failedStage[1].detail}` : "";

    if (failing && (streak === 1 || streak % RENOTIFY_EVERY === 0)) {
      alerts.push(`■ ${r.name}${streak > 1 ? ` (${streak}회 연속)` : ""}\n  ${reason}`);
    }
    if (!failing && p.overall === "fail") {
      recovered.push(`□ ${r.name} 복구됨`);
    }

    const list = history[r.id] || [];
    list.push({ t: now.toISOString(), s: r.overall, ms: r.stages.gas.ms ?? r.stages.pages.ms ?? null });
    history[r.id] = list.slice(-HISTORY_KEEP);

    return { ...r, streak, lastOkAt, firstFailAt, reason };
  });

  const summary = apps.reduce(
    (acc, a) => ((acc[a.overall] = (acc[a.overall] || 0) + 1), acc),
    { ok: 0, warn: 0, fail: 0 }
  );

  const status = {
    checkedAt: now.toISOString(),
    checkedAtKst: kst(now),
    slowMs: SLOW_MS,
    staleHours: CONFIG.staleHours || 14,
    summary,
    apps,
  };

  fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));

  for (const a of apps) {
    const mark = a.overall === "ok" ? "🟢" : a.overall === "warn" ? "🟡" : "🔴";
    console.log(`${mark} ${a.name}`, JSON.stringify(a.stages));
  }

  if (alerts.length || recovered.length) {
    const text = [`앱 모니터 ${kst(now)}`, ...alerts, ...recovered].join("\n");
    await sendSolapi(text);
  } else {
    console.log("[notify] 변화 없음 — 알림 없음");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

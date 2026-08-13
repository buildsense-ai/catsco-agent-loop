const $ = (id) => document.getElementById(id);
const loopback = window.location.hostname === "127.0.0.1" || window.location.hostname === "localhost";
const defaultApiUrl = loopback
  ? `${window.location.protocol}//${window.location.hostname}:19992`
  : `https://${window.location.hostname}:19993`;
const state = {
  apiUrl: defaultApiUrl,
  token: sessionStorage.getItem("catsloop.operatorToken") || "",
  runs: [], events: new Map(), findings: new Map(), expanded: new Set(),
  selectedFindings: new Map(), findingScroll: new Map(),
  filter: "all", connected: false, refreshing: false,
};
const terminal = new Set(["completed", "cancelled", "blocked", "blocked_auth", "blocked_github_auth"]);
const active = new Set(["queued", "monday_finding", "developer_implementing", "waiting_ci", "monday_review", "recovering", "paused"]);
const phaseNames = {
  queued: "排队中", monday_finding: "审查中", developer_implementing: "开发中", waiting_ci: "验证中",
  monday_review: "复核中", recovering: "正在恢复", paused: "已暂停", blocked: "需要处理",
  blocked_auth: "登录失效", blocked_github_auth: "GitHub 登录失效", cancelled: "已取消", completed: "已完成",
};
const eventNames = {
  run_created: "任务已创建", message_dispatched: "已交给智能体", agent_activity: "收到新进展",
  finding_validated: "Finding ZIP 已验证", github_delivery: "发现 Pull Request", ci_observed: "CI 状态已更新",
  review_cycle_started: "开始新一轮复核", review_observed: "收到 GitHub 审核", head_changed: "检测到新提交",
  phase_changed: "阶段已切换", controller_restarted: "Controller 已恢复", reconcile_error: "核对暂时失败",
  activity_state_changed: "活动状态已变化", finding_rejected: "Finding ZIP 未通过验证",
};
let toastTimer;

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = text;
  return element;
}
function appendText(parent, text) {
  if (text) parent.append(node("span", "", text));
}
function safeLinkTarget(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.startsWith("//") || raw.includes("\\")) return null;
  let decoded = raw.replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (_, hex, decimal) => String.fromCodePoint(Number.parseInt(hex || decimal, hex ? 16 : 10)))
    .replace(/&colon;/gi, ":").replace(/&tab;|&newline;/gi, "");
  for (let index = 0; index < 3; index += 1) {
    try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; } catch { break; }
  }
  const compact = decoded.replace(/[\u0000-\u0020\u007f]+/g, "").toLowerCase();
  const scheme = compact.match(/^([a-z][a-z0-9+.-]*):/i)?.[1];
  if (scheme && !["http", "https", "mailto"].includes(scheme)) return null;
  if (!scheme && !/^(?:[./#?]|[^:]+$)/.test(compact)) return null;
  return raw;
}
function appendInlineMarkdown(parent, source) {
  const text = String(source || "");
  const token = /(`+)([^`\n]+?)\1|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)|(\*\*|__)(.+?)\5|(?<!\*)\*([^*\n]+)\*(?!\*)|(?<!_)_([^_\n]+)_(?!_)/g;
  let cursor = 0;
  for (const match of text.matchAll(token)) {
    appendText(parent, text.slice(cursor, match.index));
    if (match[1]) parent.append(node("code", "", match[2]));
    else if (match[3]) {
      const href = safeLinkTarget(match[4]);
      if (!href) appendText(parent, match[3]);
      else {
        const link = node("a", "", match[3]);
        link.href = href;
        if (/^https?:/i.test(href)) { link.target = "_blank"; link.rel = "noopener noreferrer"; }
        parent.append(link);
      }
    } else if (match[5]) {
      const strong = node("strong"); appendInlineMarkdown(strong, match[6]); parent.append(strong);
    } else {
      const emphasis = node("em"); appendInlineMarkdown(emphasis, match[7] || match[8]); parent.append(emphasis);
    }
    cursor = (match.index || 0) + match[0].length;
  }
  appendText(parent, text.slice(cursor));
}
function startsMarkdownBlock(line) {
  return /^\s*$|^ {0,3}(?:#{1,6}\s+|>|```|~~~|(?:[-+*]|\d+[.)])\s+)/.test(line);
}
function appendMarkdownBlocks(container, markdown) {
  const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
  for (let index = 0; index < lines.length;) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^`]*)$/);
    if (fence) {
      const body = []; const marker = fence[1][0]; const minimum = fence[1].length; index += 1;
      const closesFence = (candidate) => { const trimmed = candidate.trim(); return trimmed.length >= minimum && [...trimmed].every((character) => character === marker); };
      while (index < lines.length && !closesFence(lines[index])) body.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = node("pre"); pre.append(node("code", "", body.join("\n"))); container.append(pre); continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { const element = node(`h${heading[1].length}`); appendInlineMarkdown(element, heading[2]); container.append(element); index += 1; continue; }
    if (/^ {0,3}>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^ {0,3}>\s?/, ""));
      const blockquote = node("blockquote"); appendMarkdownBlocks(blockquote, quote.join("\n")); container.append(blockquote); continue;
    }
    const item = line.match(/^ {0,3}([-+*]|\d+[.)])\s+(.+)$/);
    if (item) {
      const ordered = /^\d/.test(item[1]); const list = node(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const next = lines[index].match(/^ {0,3}([-+*]|\d+[.)])\s+(.+)$/);
        if (!next || /^\d/.test(next[1]) !== ordered) break;
        const listItem = node("li"); appendInlineMarkdown(listItem, next[2]); list.append(listItem); index += 1;
      }
      container.append(list); continue;
    }
    const paragraphLines = [line]; index += 1;
    while (index < lines.length && !startsMarkdownBlock(lines[index])) paragraphLines.push(lines[index++]);
    const paragraph = node("p");
    paragraphLines.forEach((part, partIndex) => {
      const hardBreak = / {2}$/.test(part);
      appendInlineMarkdown(paragraph, part.replace(/ {2}$/, ""));
      if (partIndex < paragraphLines.length - 1) paragraph.append(hardBreak ? node("br") : node("span", "", " "));
    });
    container.append(paragraph);
  }
}
function renderFindingMarkdown(markdown) {
  const container = node("div", "finding-copy finding-markdown");
  appendMarkdownBlocks(container, markdown);
  return container;
}
function findingVersions(run) {
  const versions = [...(run.finding_history || [])];
  if (run.latest_finding && !versions.some((item) => item.version === run.latest_finding.version)) versions.push(run.latest_finding);
  return versions.sort((left, right) => left.version - right.version);
}
function selectedFinding(run) {
  const versions = findingVersions(run);
  const selectedVersion = state.selectedFindings.get(run.run_id);
  return versions.find((item) => item.version === selectedVersion) || versions.find((item) => item.version === run.latest_finding?.version) || versions.at(-1);
}
function findingKey(run, finding) { return `${run.run_id}:${finding.version}`; }
function restoreFindingScroll(container, key) {
  container.dataset.findingKey = key;
  requestAnimationFrame(() => { container.scrollTop = state.findingScroll.get(key) || 0; });
}
function rememberFindingScroll() {
  document.querySelectorAll(".finding-copy[data-finding-key]").forEach((container) => {
    if (container.dataset.findingKey) state.findingScroll.set(container.dataset.findingKey, container.scrollTop);
  });
}
function setConnection(value, label) {
  state.connected = value;
  $("connectionState").dataset.state = value ? "online" : "offline";
  $("healthText").textContent = label;
}
function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.remove("show"), 2200);
}
function elapsed(start, end = "") {
  if (!start) return "—";
  const ms = Math.max(0, Date.parse(end || new Date().toISOString()) - Date.parse(start));
  if (!Number.isFinite(ms)) return "—";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor(ms % 3600000 / 60000);
  const seconds = Math.floor(ms % 60000 / 1000);
  return `${hours ? `${String(hours).padStart(2,"0")}:` : ""}${String(minutes).padStart(2,"0")}:${String(seconds).padStart(2,"0")}`;
}
function clock(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}
function age(value) {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (!Number.isFinite(seconds)) return "未知";
  if (seconds < 60) return seconds < 8 ? "刚刚" : `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}
function short(value, length = 9) { return value ? String(value).slice(0, length) : "—"; }
function title(request) { return String(request || "未命名任务").replace(/\s+/g, " ").trim(); }

async function api(path, options = {}, raw = false) {
  const headers = { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const response = await fetch(new URL(path, state.apiUrl), {
    ...options,
    headers,
  });
  if (raw) {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function effectivePhase(run) { return run.phase === "recovering" || run.phase === "paused" ? run.resume_phase || run.phase : run.phase; }
function actorInfo(run) {
  const phase = effectivePhase(run);
  if (run.phase === "paused") return { name: "Controller", icon: "II", label: "已暂停", index: phase === "developer_implementing" ? 1 : phase === "waiting_ci" ? 2 : 0 };
  if (phase === "developer_implementing") return { name: "Developer", icon: "DEV", label: "开发中", index: 1 };
  if (phase === "waiting_ci") return { name: "自动检查", icon: "CI", label: "验证中", index: 2 };
  if (phase === "monday_finding" || phase === "monday_review") return { name: "Reviewer", icon: "REV", label: phase === "monday_review" ? "复核中" : "审查中", index: 0 };
  return { name: "Controller", icon: "CTL", label: phaseNames[run.phase] || "处理中", index: 0 };
}
function cycleGraphic(run) {
  const info = actorInfo(run);
  const box = node("div", "cycle-panel");
  const cycle = node("div", "cycle");
  cycle.innerHTML = `<svg viewBox="0 0 170 170" aria-label="当前处于${info.label}">
    <path class="arc ${info.index > 0 ? "done" : info.index < 0 ? "next" : ""}" d="M85 22 A63 63 0 0 1 140 116"/>
    <path class="arrow" d="M137.1 120.8 L145.9 115.5 L137.3 110.5 Z"/>
    <path class="arc ${info.index > 1 ? "done" : info.index < 1 ? "next" : ""}" d="M132 128 A63 63 0 0 1 38 128"/>
    <path class="arrow" d="M34.6 124.3 L37 134.3 L44.4 127.5 Z"/>
    <path class="arc ${info.index > 2 ? "done" : info.index < 2 ? "next" : ""}" d="M30 116 A63 63 0 0 1 73 23"/>
    <path class="arrow" d="M77.9 22 L68.1 18.9 L70 28.7 Z"/>
  </svg>`;
  const copy = node("div", "cycle-copy");
  copy.append(node("small", "", "当前轮次"), node("strong", "", String(Math.max(1, (run.iteration || 0) + 1)).padStart(2, "0")), node("b", "", info.label));
  const pills = node("div", "phase-pills");
  ["Reviewer", "Developer", "CI"].forEach((label, index) => pills.append(node("span", index === info.index ? "active" : "", label)));
  cycle.append(copy, pills); box.append(cycle); return box;
}

function normalizeEvent(run, event) {
  let actor = event.actor;
  if (actor === "monday") actor = "reviewer";
  if (actor === "github") actor = "ci";
  if (event.type === "message_dispatched" && /monday/i.test(event.data?.action || "")) actor = "reviewer";
  if (event.type === "message_dispatched" && /developer/i.test(event.data?.action || "")) actor = "developer";
  if (!actor || actor === "none" || actor === "controller") {
    if (event.type === "ci_observed" || event.type === "github_delivery" || event.type === "head_changed" || event.type === "review_observed") actor = event.type === "review_observed" ? "reviewer" : "ci";
    else if (event.phase === "developer_implementing") actor = "developer";
    else if (event.phase === "monday_finding" || event.phase === "monday_review") actor = "reviewer";
    else actor = "controller";
  }
  const names = { reviewer: ["Reviewer", "REV"], developer: ["Developer", "DEV"], ci: ["自动检查", "CI"], controller: ["Controller", "CTL"] };
  const [name, icon] = names[actor] || names.controller;
  const cycle = event.data?.review_cycle || run.review_cycles?.find((item) => item.requested_at <= event.at && (!item.completed_at || item.completed_at >= event.at))?.cycle || 1;
  return { actor, name, icon, cycle, title: eventNames[event.type] || "状态已更新", message: event.message || run.waiting_for, at: event.at, type: event.type, data: event.data || {} };
}
function syntheticLatest(run) {
  const info = actorInfo(run);
  const actor = info.name === "Developer" ? "developer" : info.name === "Reviewer" ? "reviewer" : info.icon === "CI" ? "ci" : "controller";
  return { actor, name: info.name, icon: info.icon, cycle: Math.max(1, (run.iteration || 0) + 1), title: phaseNames[run.phase] || "处理中", message: run.waiting_for || "正在核对最新状态", at: run.last_activity_at || run.updated_at, type: "current", data: {} };
}
function statusKey(item) { return `${item.cycle}:${item.actor}`; }
function collapseStatusEvents(items) {
  const collapsed = [];
  for (const item of items) {
    const previous = collapsed.at(-1);
    const controllerUpdate = previous && item.actor === "controller" && ["reviewer", "developer", "ci"].includes(previous.actor);
    if (previous && (statusKey(previous) === statusKey(item) || controllerUpdate)) {
      previous.latestAt = item.at;
      previous.message = item.message || previous.message;
      previous.type = item.type;
      previous.title = item.title;
      previous.data = { ...previous.data, ...item.data };
      previous.updates += 1;
    } else collapsed.push({ ...item, startedAt: item.at, latestAt: item.at, updates: 1 });
  }
  return collapsed;
}
function humanMessage(value) {
  return String(value || "正在核对最新状态")
    .replace(/an available Controller execution slot/i, "等待 Controller 调度")
    .replace(/a validated Finding ZIP/i, "等待经过验证的 Finding ZIP")
    .replace(/an open pull request/i, "等待 Developer 创建 Pull Request")
    .replace(/a new Head SHA on the existing PR/i, "等待 Developer 推送新的提交")
    .replace(/current-SHA approval or comment plus new Finding ZIP/i, "等待当前提交的批准，或审核意见与新 Finding ZIP")
    .replace(/operator resume/i, "等待用户恢复任务")
    .replace(/operator intervention/i, "等待用户处理")
    .replace(/manual reconciliation/i, "正在重新核对已有交付");
}
function eventMessage(run, item, latest) {
  if (latest) return `${humanMessage(item.message)} · ${age(item.at)}`;
  switch (item.type) {
    case "message_dispatched": return `已向 ${item.name} 的原会话发送本阶段要求`;
    case "agent_activity": return `${item.name} 会话出现了新消息或 Episode 状态变化`;
    case "finding_validated": return `Finding ZIP v${item.data?.version || ""} 已完成下载、校验和保存`;
    case "github_delivery": return `已机械核对 PR #${item.data?.pr || run.pr?.number || "—"} 与当前提交`;
    case "ci_observed": return `当前提交的 CI 状态：${item.data?.state === "success" ? "通过" : item.data?.state === "failure" ? "失败" : "运行中"}`;
    case "review_cycle_started": return `本轮复核绑定 Head ${short(item.data?.head_sha, 10)}`;
    case "review_observed": return "已核对到 Reviewer 的 GitHub 审核证据";
    case "head_changed": return `检测到新提交 ${short(item.data?.sha, 10)}，旧 CI 与批准已失效`;
    case "phase_changed": return `任务进入“${phaseNames[item.data?.to] || phaseNames[run.phase] || "下一阶段"}”`;
    default: return humanMessage(item.message);
  }
}
function eventCard(run, item, latest = false) {
  const card = node("article", `event${latest ? " latest" : ""}`);
  if (latest) card.append(node("span", "latest-label", "最新"));
  const actor = node("div", "actor");
  actor.append(node("i", "", item.icon), node("span", "", item.name), node("small", "", `第 ${item.cycle} 轮`));
  const main = node("div", "event-main");
  main.append(node("b", "", item.title), node("span", "", eventMessage(run, item, latest)));
  const status = node("span", "event-status", latest && !terminal.has(run.phase) && run.phase !== "paused" ? "处理中" : "已完成");
  const timing = node("div", "timing");
  const startedAt = item.startedAt || item.at;
  timing.append(node("span", "", `开始 ${clock(startedAt)}`));
  if (latest && !terminal.has(run.phase) && run.phase !== "paused") {
    const live = node("span", "live", `已运行 ${elapsed(startedAt)}`);
    live.dataset.start = startedAt;
    timing.append(live);
  } else timing.append(node("span", "", `用时 ${elapsed(startedAt, item.data?.ended_at || item.latestAt || item.at)}`));
  const finding = item.type === "finding_validated" ? run.finding_history?.find((entry) => entry.version === item.data?.version || entry.validated_at === item.at) : undefined;
  if (finding && !latest) {
    const link = node("a", "zip-link", `finding-v${finding.version}.zip ↓`);
    link.href = `${state.apiUrl}/api/runs/${run.run_id}/findings/${finding.version}/download`;
    link.addEventListener("click", (event) => { event.preventDefault(); downloadFinding(run, finding); });
    main.append(link);
  }
  card.append(actor, main, status, timing); return card;
}
function activityPanel(run) {
  const wrap = node("div", "activity-wrap");
  const panel = node("div", "activity");
  const history = node("div", "history");
  const inner = node("div", "history-inner");
  const normalized = (state.events.get(run.run_id) || []).map((event) => normalizeEvent(run, event));
  const visible = collapseStatusEvents(normalized.filter((item) => ["message_dispatched","agent_activity","finding_validated","github_delivery","ci_observed","review_cycle_started","review_observed","head_changed","phase_changed"].includes(item.type)));
  let latest;
  if (terminal.has(run.phase)) latest = visible.pop() || syntheticLatest(run);
  else {
    const current = syntheticLatest(run);
    const previous = visible.at(-1);
    latest = previous && statusKey(previous) === statusKey(current)
      ? { ...visible.pop(), ...current, startedAt: previous.startedAt, latestAt: current.at, data: previous.data }
      : { ...current, startedAt: run.phase_started_at || current.at, latestAt: current.at };
  }
  visible.forEach((item, index) => { item.data.ended_at ||= visible[index + 1]?.startedAt || latest.startedAt || (terminal.has(run.phase) ? run.updated_at : undefined); });
  visible.forEach((item) => inner.append(eventCard(run, item)));
  if (!inner.childNodes.length) inner.append(eventCard(run, normalizeEvent(run, { type: "run_created", actor: "controller", phase: "queued", at: run.created_at, message: "Controller 已接管任务。", data: {} })));
  history.append(inner); panel.append(history, eventCard(run, latest, true)); wrap.append(panel);
  requestAnimationFrame(() => { history.scrollTop = history.scrollHeight; });
  return wrap;
}

function taskDetail(run) {
  const detail = node("section", "detail");
  const main = node("div"); main.append(node("h3", "", "完整任务要求"), node("p", "request-copy", run.request));
  const versions = findingVersions(run);
  const finding = selectedFinding(run);
  if (finding) {
    const heading = node("div", "finding-heading");
    const title = node("h3", "", `${finding.version === run.latest_finding?.version ? "最新" : "历史"} Finding · v${finding.version}`);
    const actions = node("div", "finding-actions");
    if (versions.length > 1) {
      const label = node("label", "finding-version");
      label.append(node("span", "", "查看版本"));
      const select = node("select"); select.setAttribute("aria-label", "Finding 版本");
      versions.forEach((item) => { const option = node("option", "", `v${item.version}${item.version === run.latest_finding?.version ? " · 最新" : ""}`); option.value = String(item.version); option.selected = item.version === finding.version; select.append(option); });
      select.addEventListener("change", async () => { state.selectedFindings.set(run.run_id, Number(select.value)); await loadFinding(run, selectedFinding(run)); render(); });
      label.append(select); actions.append(label);
    }
    const download = node("a", "finding-download", `下载 ZIP · v${finding.version} ↓`);
    download.href = `${state.apiUrl}/api/runs/${run.run_id}/findings/${finding.version}/download`;
    download.addEventListener("click", (event) => { event.preventDefault(); downloadFinding(run, finding); });
    actions.append(download); heading.append(title, actions); main.append(heading);
    const key = findingKey(run, finding);
    const loaded = state.findings.get(key);
    const content = loaded?.markdown ? renderFindingMarkdown(loaded.markdown) : node("div", "finding-copy finding-empty", loaded?.error ? `暂时无法读取：${loaded.error}` : "正在读取 FINDING.md…");
    restoreFindingScroll(content, key); main.append(content);
  }
  const aside = node("aside"); aside.append(node("h3", "", "机械状态"));
  const facts = node("dl", "facts");
  [["Run",run.run_id],["仓库",run.repo],["基础分支",run.base_branch],["工作分支",run.branch],["Head",short(run.pr?.head_sha,14)],["等待",run.waiting_for]].forEach(([key,value]) => { const row=node("div"); row.append(node("dt","",key),node("dd","",value || "—")); facts.append(row); });
  aside.append(facts); detail.append(main, aside); return detail;
}
function taskCard(run) {
  const card = node("article", `task${terminal.has(run.phase) ? " terminal" : ""}${state.expanded.has(run.run_id) ? " open" : ""}`);
  const head = node("header", "task-head");
  const left = node("div"); left.append(node("div", "state", `${actorInfo(run).name} · ${phaseNames[run.phase] || "处理中"}`), node("h2", "", title(run.request)));
  const meta = node("div", "task-meta"); meta.append(node("span", "", run.repo));
  if (run.pr?.url) { const link=node("a","pr-link",`PR #${run.pr.number} · ${short(run.pr.head_sha)} ↗`); link.href=run.pr.url; link.target="_blank"; link.rel="noopener noreferrer"; meta.append(link); }
  left.append(meta);
  const end = terminal.has(run.phase) ? run.updated_at : "";
  const total = node("div", "total"); total.append(node("span", "", end ? "任务总用时" : "已运行"), node("strong", "live-total", elapsed(run.created_at,end))); total.lastChild.dataset.start=run.created_at; total.lastChild.dataset.end=end;
  head.append(left,total);
  const body=node("div","task-body"); body.append(cycleGraphic(run),activityPanel(run));
  const actions=node("div","task-actions");
  const toggle=node("button","detail-toggle",state.expanded.has(run.run_id)?"收起任务详情 ↑":"查看任务要求与证据 ↓"); toggle.type="button";
  toggle.addEventListener("click",async()=>{ if(state.expanded.has(run.run_id))state.expanded.delete(run.run_id);else state.expanded.add(run.run_id); render(); if(state.expanded.has(run.run_id)){await loadFinding(run);render();} });
  const group=node("div","action-group");
  if(run.phase === "paused" || ["blocked","blocked_auth","blocked_github_auth"].includes(run.phase)){const resume=node("button","","恢复");resume.onclick=()=>runAction(run,"resume");group.append(resume);}
  else if(!terminal.has(run.phase)){const pause=node("button","","暂停");pause.onclick=()=>runAction(run,"pause");group.append(pause);}
  if(!terminal.has(run.phase)){const reconcile=node("button","","立即核对");reconcile.onclick=()=>runAction(run,"reconcile");const cancel=node("button","danger","取消");cancel.onclick=()=>runAction(run,"cancel");group.append(reconcile,cancel);}
  actions.append(toggle,group); card.append(head,body,actions); if(state.expanded.has(run.run_id))card.append(taskDetail(run)); return card;
}
function matches(run){if(state.filter==="active")return active.has(run.phase);if(state.filter==="done")return terminal.has(run.phase);return true;}
function render(){
  rememberFindingScroll();
  $("runCount").textContent=state.runs.length; $("activeCount").textContent=state.runs.filter(r=>active.has(r.phase)).length; $("doneCount").textContent=state.runs.filter(r=>terminal.has(r.phase)).length;
  const list=$("runList");list.replaceChildren();const runs=state.runs.filter(matches);
  if(!runs.length){const empty=node("div","empty");empty.append(node("span","","00"),node("h2","",state.connected?"目前没有符合条件的任务":"连接后查看自迭代任务"),node("p","",state.connected?"在与 Saturday 的会话中明确要求启动自迭代，任务会出现在这里。":"Artifact 只展示和管理任务，不负责创建任务。"));list.append(empty);return;}
  runs.forEach(run=>list.append(taskCard(run)));
}
async function loadEvents(run){try{const body=await api(`/api/runs/${run.run_id}/events?after=0`);state.events.set(run.run_id,body.events||[]);}catch{state.events.set(run.run_id,[]);}}
async function loadFinding(run,finding=selectedFinding(run)){if(!finding)return;const key=findingKey(run,finding);if(state.findings.has(key))return;try{state.findings.set(key,await api(`/api/runs/${run.run_id}/findings/${finding.version}`));}catch(error){state.findings.set(key,{error:error.message});}}
async function downloadFinding(run,finding){try{const response=await api(`/api/runs/${run.run_id}/findings/${finding.version}/download`,{},true);const url=URL.createObjectURL(await response.blob());const a=node("a");a.href=url;a.download=`finding-v${finding.version}.zip`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}catch(error){toast(error.message);}}
async function refresh(silent=false){if(state.refreshing||!state.apiUrl)return;state.refreshing=true;try{const body=await api("/api/runs");state.runs=body.runs||[];await Promise.all(state.runs.map(loadEvents));setConnection(true,"公开实时");$("lastSync").textContent=`更新于 ${clock(new Date().toISOString())}`;render();if(!silent)toast("状态已刷新");}catch(error){setConnection(false,"连接失败");if(!silent)toast(error.message);}finally{state.refreshing=false;}}
async function runAction(run,action){if(action!=="pause"&&!state.token){$("operatorToken").value="";$("connectionDialog").showModal();toast("该管理操作需要授权");return;}if(action==="cancel"&&!confirm("确认取消这个任务？已有会话、PR 和历史文件都会保留。"))return;try{const updated=await api(`/api/runs/${run.run_id}/${action}`,{method:"POST"});const index=state.runs.findIndex(item=>item.run_id===run.run_id);if(index>=0)state.runs[index]=updated;await loadEvents(updated);render();toast(action==="pause"?"任务已软暂停":action==="resume"?"任务已恢复":action==="cancel"?"任务已取消":"核对完成");}catch(error){if(/401|unauthorized/i.test(error.message)){state.token="";sessionStorage.removeItem("catsloop.operatorToken");}toast(error.message);}}

$("connectionButton").onclick=()=>{$("operatorToken").value=state.token;$("connectionDialog").showModal();};
$("refreshButton").onclick=()=>refresh();
document.querySelectorAll("[data-close]").forEach(button=>button.onclick=()=>button.closest("dialog").close());
document.querySelectorAll("[data-filter]").forEach(button=>button.onclick=()=>{state.filter=button.dataset.filter;document.querySelectorAll("[data-filter]").forEach(item=>item.classList.toggle("active",item===button));render();});
$("connectionForm").onsubmit=async(event)=>{event.preventDefault();state.token=$("operatorToken").value;sessionStorage.setItem("catsloop.operatorToken",state.token);$("connectionDialog").close();toast("管理授权已保存");};
setInterval(()=>{document.querySelectorAll(".live-total").forEach(item=>item.textContent=elapsed(item.dataset.start,item.dataset.end));document.querySelectorAll(".timing .live").forEach(item=>item.textContent=`已运行 ${elapsed(item.dataset.start)}`);},1000);
setInterval(()=>refresh(true),5000);
refresh(true);

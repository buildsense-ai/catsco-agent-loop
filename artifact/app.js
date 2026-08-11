const defaultApiUrl = location.protocol === "https:"
  ? `${location.protocol}//${location.hostname}:19993`
  : "http://127.0.0.1:19992";

const state = {
  apiUrl: sessionStorage.getItem("catsloop.apiUrl") || defaultApiUrl,
  token: sessionStorage.getItem("catsloop.operatorToken") || "",
  runs: [],
  filter: "all",
  connected: false,
  refreshing: false,
  expanded: new Set(),
  events: new Map(),
  eventCursors: new Map(),
  findings: new Map(),
};

const terminalPhases = new Set(["completed", "cancelled", "blocked", "blocked_auth", "blocked_github_auth"]);
const activePhases = new Set(["queued", "monday_finding", "developer_implementing", "waiting_ci", "monday_review", "recovering"]);
const phaseLabels = {
  queued: "等待调度",
  monday_finding: "审查者正在调查",
  developer_implementing: "开发者正在实现",
  waiting_ci: "正在验证 CI",
  monday_review: "审查者正在复核",
  recovering: "正在恢复任务",
  blocked: "任务已阻塞",
  blocked_auth: "会话认证阻塞",
  blocked_github_auth: "GitHub 认证阻塞",
  cancelled: "任务已取消",
  completed: "已批准，循环结束",
};
const cycleLabels = {
  active: "复核中",
  revision_requested: "需要修改",
  approved: "已批准",
  superseded: "已归档",
};
const ciLabels = { pending: "检查中", success: "已通过", failure: "未通过", none: "尚未开始" };
const episodeLabels = { running: "运行中", waiting: "等待中", completed: "已结束", failed: "失败", cancelled: "已取消", stale: "状态过期" };
const eventLabels = {
  run_created: "任务已创建",
  message_dispatched: "任务消息已发送",
  phase_changed: "处理阶段已推进",
  agent_activity: "智能体有新进展",
  finding_validated: "发现报告 ZIP 已验证",
  github_delivery: "已发现 PR 交付",
  ci_observed: "CI 状态已更新",
  review_cycle_started: "新一轮复核已开始",
  review_observed: "已发现审核证据",
  controller_restarted: "调度器已重启",
  head_changed: "PR 出现新提交",
  run_resumed: "任务已恢复",
  recovery_scheduled: "已安排恢复尝试",
  run_cancelled: "任务已取消",
};

const $ = (id) => document.getElementById(id);

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(id, value, fallback = "—") {
  $(id).textContent = value === undefined || value === null || value === "" ? fallback : String(value);
}

function short(value, length = 10) {
  if (!value) return "—";
  return value.length > length ? value.slice(0, length) : value;
}

function taskTitle(request) {
  const normalized = String(request || "未命名任务").replace(/\s+/g, " ").trim();
  const first = normalized.match(/^.*?[。！？!?](?:\s|$)|^.*?\.(?:\s|$)/)?.[0]?.trim();
  const value = first && first.length >= 10 ? first : normalized;
  return value.length > 74 ? `${value.slice(0, 71).trim()}…` : value;
}

function age(value) {
  if (!value) return "—";
  const ms = Date.now() - Date.parse(value);
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function clock(value) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function durationText(start, end) {
  const elapsed = Math.max(0, Date.parse(end || new Date().toISOString()) - Date.parse(start));
  if (!Number.isFinite(elapsed)) return "—";
  const seconds = Math.floor(elapsed / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function effectivePhase(run) {
  return run.phase === "recovering" && run.resume_phase ? run.resume_phase : run.phase;
}

function stageIndex(run) {
  if (run.phase === "completed") return 5;
  return { queued: 0, monday_finding: 1, developer_implementing: 2, waiting_ci: 3, monday_review: 4 }[effectivePhase(run)] ?? 0;
}

function setConnection(connected, label) {
  state.connected = connected;
  $("connectionState").dataset.state = connected ? "online" : "offline";
  setText("healthText", label, connected ? "已连接" : "未连接");
}

function toast(message, kind = "ok") {
  const node = $("toast");
  node.textContent = message;
  node.classList.toggle("error", kind === "error");
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 3200);
}

async function request(path, options = {}, expectJson = true) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch(new URL(path, `${state.apiUrl.replace(/\/$/, "")}/`), {
      ...options,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${state.token}`,
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.error || `请求失败（${response.status}）`);
      error.status = response.status;
      throw error;
    }
    return expectJson ? await response.json() : response;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("调度器响应超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function handleError(error, silent = false) {
  setConnection(false, error.status === 401 ? "令牌无效" : "连接异常");
  if (!silent) toast(error.message || String(error), "error");
  if (error.status === 401 && !$("connectionDialog").open) openConnection();
}

function runMatchesFilter(run) {
  if (state.filter === "active") return activePhases.has(run.phase);
  if (state.filter === "done") return terminalPhases.has(run.phase);
  return true;
}

function actorStatus(run) {
  if (run.phase === "recovering") return "调度器正在尝试恢复";
  return phaseLabels[run.phase] || "正在处理";
}

function waitingText(run) {
  if (run.phase === "queued") return "等待可用执行位置";
  if (run.phase === "monday_finding") return "等待发现报告 ZIP";
  if (run.phase === "developer_implementing") return run.pr ? "等待 PR 的新提交" : "等待开发者创建 PR";
  if (run.phase === "waiting_ci") return "等待当前提交通过 CI";
  if (run.phase === "monday_review") return "等待批准，或评论与新发现报告";
  if (run.phase === "completed") return "当前提交已经批准，PR 保持未合并";
  if (run.phase === "cancelled") return "任务已经停止，历史信息仍然保留";
  if (run.phase.startsWith("blocked")) return run.last_error || "需要人工处理后恢复";
  return "正在核对最新状态";
}

function renderProgress(run) {
  const labels = ["需求", "调查", "开发", "CI", "复核"];
  const current = stageIndex(run);
  const progress = create("div", "task-progress");
  labels.forEach((label, index) => {
    const step = create("span", `phase-step${index < current ? " done" : ""}${index === current && current < 5 ? " current" : ""}`);
    step.append(create("i", "", index < current || current === 5 ? "✓" : ""), create("span", "", label));
    progress.append(step);
  });
  return progress;
}

function episodeText(agent) {
  const episode = agent?.episode;
  if (!episode) return "尚未开始";
  return `${episodeLabels[episode.state] || "状态未知"} · ${age(agent.episode_observed_at)}`;
}

function appendFact(list, label, value) {
  const item = create("div");
  item.append(create("dt", "", label), create("dd", "", value || "—"));
  list.append(item);
}

function renderMarkdown(container, markdown) {
  container.replaceChildren();
  const lines = String(markdown || "").replace(/\r/g, "").split("\n");
  let list = null;
  let code = null;
  const flushList = () => { list = null; };
  for (const raw of lines) {
    if (raw.startsWith("```")) {
      flushList();
      if (code) code = null;
      else { code = create("pre"); container.append(code); }
      continue;
    }
    if (code) {
      code.textContent += `${raw}\n`;
      continue;
    }
    if (!raw.trim()) { flushList(); continue; }
    const heading = raw.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushList();
      container.append(create(`h${heading[1].length}`, "", heading[2]));
      continue;
    }
    const bullet = raw.match(/^\s*[-*+]\s+(.+)$/);
    if (bullet) {
      if (!list) { list = create("ul"); container.append(list); }
      list.append(create("li", "", bullet[1]));
      continue;
    }
    flushList();
    container.append(create("p", "", raw));
  }
  if (!container.childNodes.length) container.append(create("p", "", "发现报告中没有可显示的正文。"));
}

function eventDescription(event) {
  switch (event.type) {
    case "phase_changed": return `任务已进入“${phaseLabels[event.phase] || "下一"}”阶段。`;
    case "agent_activity": return "检测到受控会话出现了新的智能体活动。";
    case "finding_validated": return "新的发现报告 ZIP 已通过格式与完整性校验。";
    case "github_delivery": return "已核对到开发者提交的 PR 与当前提交。";
    case "ci_observed": return "已核对当前 PR 提交对应的 CI 结果。";
    case "review_cycle_started": return "当前 PR 提交已经绑定到新的复核轮次。";
    case "review_observed": return "已发现配置审查账号留下的 GitHub 审核证据。";
    case "controller_restarted": return "调度器重启后会先核对既有交付，再决定是否续发。";
    case "head_changed": return "PR 出现新提交，上一提交的批准与 CI 不再有效。";
    default: return "调度器记录了一次可追溯的状态变化。";
  }
}

function renderAgents(run) {
  const list = create("div", "agent-statuses");
  for (const [name, initial, agent] of [["审查者", "审", run.monday], ["开发者", "开", run.developer]]) {
    const line = create("div", "agent-line");
    const copy = create("div");
    copy.append(create("b", "", name), create("small", "", agent?.topic_id ? `会话 ${agent.topic_id}` : "会话尚未创建"));
    line.append(create("span", "agent-icon", initial), copy, create("span", "", episodeText(agent)));
    list.append(line);
  }
  return list;
}

function renderCycles(run) {
  const list = create("div", "cycle-list");
  const cycles = [...(run.review_cycles || [])].sort((a, b) => b.cycle - a.cycle);
  if (!cycles.length) {
    list.append(create("p", "", "CI 通过后，这里会记录每次复核及其绑定的提交。"));
    return list;
  }
  for (const cycle of cycles) {
    const row = create("div", "cycle-line");
    const copy = create("div");
    copy.append(create("b", "", `提交 ${short(cycle.head_sha, 10)}`), create("small", "", cycle.finding ? `发现报告 v${cycle.finding.version}` : "本轮没有发现报告 ZIP"));
    const ending = create("span", "cycle-ending", cycleLabels[cycle.status] || cycle.status);
    if (cycle.finding) {
      const download = create("button", "inline-download", "下载 ZIP");
      download.type = "button";
      download.addEventListener("click", (event) => { event.stopPropagation(); downloadFinding(run, cycle.finding); });
      ending.append(download);
    }
    row.append(create("b", "", `第 ${cycle.cycle} 次`), copy, ending);
    list.append(row);
  }
  return list;
}

function renderEvents(run) {
  const list = create("div", "event-list");
  const events = [...(state.events.get(run.run_id) || [])].reverse().slice(0, 8);
  if (!events.length) {
    list.append(create("p", "", "尚无阶段事件。"));
    return list;
  }
  for (const event of events) {
    const row = create("div", "event-line");
    const copy = create("div");
    copy.append(create("b", "", eventLabels[event.type] || "状态已更新"), create("small", "", eventDescription(event)));
    row.append(create("time", "", clock(event.at)), copy);
    list.append(row);
  }
  return list;
}

function renderDetail(run) {
  const detail = create("div", "task-detail");
  const toolbar = create("div", "detail-toolbar");
  const links = create("div", "detail-links");
  if (run.pr?.url) {
    const pr = create("a", "detail-link", `打开 PR #${run.pr.number} ↗`);
    pr.href = run.pr.url;
    pr.target = "_blank";
    pr.rel = "noopener noreferrer";
    links.append(pr);
  }
  if (run.latest_finding) {
    const zip = create("button", "detail-link", `下载发现报告 v${run.latest_finding.version}（ZIP）`);
    zip.type = "button";
    zip.addEventListener("click", () => downloadFinding(run, run.latest_finding));
    links.append(zip);
  }
  const actions = create("div", "detail-actions");
  const reconcile = create("button", "secondary-button", "立即核对");
  reconcile.type = "button";
  reconcile.addEventListener("click", () => runAction(run, "reconcile"));
  actions.append(reconcile);
  if (["blocked", "blocked_auth", "blocked_github_auth"].includes(run.phase)) {
    const resume = create("button", "secondary-button", "恢复任务");
    resume.type = "button";
    resume.addEventListener("click", () => runAction(run, "resume"));
    actions.append(resume);
  }
  if (!terminalPhases.has(run.phase)) {
    const cancel = create("button", "danger-button", "取消任务");
    cancel.type = "button";
    cancel.addEventListener("click", () => runAction(run, "cancel"));
    actions.append(cancel);
  }
  toolbar.append(links, actions);

  const grid = create("div", "detail-grid");
  const primary = create("div", "detail-primary");
  primary.append(create("p", "section-label", "完整实现要求"), create("p", "request-copy", run.request));
  const findingHead = create("div", "finding-head");
  findingHead.append(create("p", "section-label", "报告正文（FINDING.md）"), create("small", "", run.latest_finding ? `版本 ${run.latest_finding.version} · ${Math.ceil(run.latest_finding.size / 1024)} KB` : "尚未收到 ZIP"));
  primary.append(findingHead);
  const markdown = create("div", "markdown-view markdown-placeholder");
  const cached = run.latest_finding ? state.findings.get(`${run.run_id}:${run.latest_finding.version}`) : null;
  if (cached?.markdown) {
    markdown.classList.remove("markdown-placeholder");
    renderMarkdown(markdown, cached.markdown);
  } else if (cached?.error) {
    markdown.textContent = `暂时无法读取报告正文：${cached.error}`;
  } else {
    markdown.textContent = run.latest_finding ? "正在读取 FINDING.md…" : "审查者交付发现报告 ZIP 后，这里会显示其中的 FINDING.md。";
  }
  primary.append(markdown);

  const side = create("aside", "detail-side");
  side.append(create("p", "section-label", "任务信息"));
  const facts = create("dl", "facts");
  appendFact(facts, "任务编号", run.run_id);
  appendFact(facts, "当前分支", run.branch);
  appendFact(facts, "当前提交", short(run.pr?.head_sha, 14));
  appendFact(facts, "CI 状态", ciLabels[run.ci?.state] || "尚未开始");
  side.append(facts, create("p", "section-label", "会话状态"), renderAgents(run));
  const cycles = create("section", "cycle-section");
  cycles.append(create("p", "section-label", "复核记录"), renderCycles(run));
  side.append(cycles);
  const events = create("section", "event-section");
  events.append(create("p", "section-label", "最近进展"), renderEvents(run));
  side.append(events);
  grid.append(primary, side);
  detail.append(toolbar, grid);
  return detail;
}

function renderTask(run, index) {
  const card = create("article", `task-card${terminalPhases.has(run.phase) ? " terminal" : ""}${state.expanded.has(run.run_id) ? " open" : ""}`);
  card.dataset.phase = run.phase;
  const summary = create("button", "task-summary");
  summary.type = "button";
  summary.setAttribute("aria-expanded", String(state.expanded.has(run.run_id)));
  const number = create("span", "task-number", String(index + 1).padStart(2, "0"));
  const main = create("div", "task-main");
  const cycle = run.review_cycle?.cycle || run.review_cycles?.length || 0;
  main.append(create("h2", "", taskTitle(run.request)));
  const meta = create("p");
  meta.append(create("b", "", run.repo), create("span", "", "·"), document.createTextNode(`第 ${Math.max(1, run.iteration || 1)} 轮${cycle ? ` · 第 ${cycle} 次复核` : ""}`));
  main.append(meta);
  const status = create("div", "task-state");
  const end = terminalPhases.has(run.phase) ? run.updated_at : "";
  const timer = create("time", "task-timer", durationText(run.created_at, end));
  timer.dataset.start = run.created_at;
  if (end) timer.dataset.end = end;
  status.append(create("strong", "", actorStatus(run)), create("span", "", waitingText(run)), timer);
  summary.append(number, main, renderProgress(run), status, create("span", "task-chevron", "⌄"));
  summary.addEventListener("click", async () => {
    if (state.expanded.has(run.run_id)) state.expanded.delete(run.run_id);
    else state.expanded.add(run.run_id);
    renderRuns();
    if (state.expanded.has(run.run_id)) {
      await Promise.all([loadEvents(run.run_id), loadFinding(run)]);
      renderRuns();
    }
  });
  card.append(summary);
  if (state.expanded.has(run.run_id)) card.append(renderDetail(run));
  return card;
}

function renderRuns() {
  const active = state.runs.filter((run) => activePhases.has(run.phase)).length;
  const done = state.runs.filter((run) => terminalPhases.has(run.phase)).length;
  setText("activeCount", active, "0");
  setText("doneCount", done, "0");
  setText("runCount", `${state.runs.length} 个任务`, "0 个任务");
  const list = $("runList");
  list.replaceChildren();
  const runs = state.runs.filter(runMatchesFilter);
  if (!runs.length) {
    const empty = create("div", "empty-state");
    empty.append(create("span", "", "01"), create("h2", "", state.connected ? "这个筛选下没有任务" : "连接后查看任务"), create("p", "", state.connected ? "切换筛选条件，或者明确创建一个新的自迭代任务。" : "请先连接任务调度器。"));
    const start = create("button", "primary-button", state.connected ? "新建任务" : "连接设置");
    start.type = "button";
    start.addEventListener("click", state.connected ? openNewRun : openConnection);
    empty.append(start);
    list.append(empty);
    return;
  }
  runs.forEach((run, index) => list.append(renderTask(run, index)));
}

async function loadEvents(runId) {
  const after = state.eventCursors.get(runId) || 0;
  try {
    const body = await request(`/api/runs/${runId}/events?after=${after}`);
    const current = state.events.get(runId) || [];
    const seen = new Set(current.map((event) => event.seq));
    const incoming = (body.events || []).filter((event) => !seen.has(event.seq));
    const combined = [...current, ...incoming].sort((a, b) => a.seq - b.seq);
    state.events.set(runId, combined);
    state.eventCursors.set(runId, combined.at(-1)?.seq || after);
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function loadFinding(run) {
  const finding = run.latest_finding;
  if (!finding) return;
  const key = `${run.run_id}:${finding.version}`;
  if (state.findings.has(key)) return;
  try {
    state.findings.set(key, await request(`/api/runs/${run.run_id}/findings/${finding.version}`));
  } catch (error) {
    state.findings.set(key, { error: error.message });
  }
}

async function downloadFinding(run, finding) {
  try {
    const response = await request(`/api/runs/${run.run_id}/findings/${finding.version}/download`, {}, false);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = `finding-v${finding.version}.zip`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  } catch (error) {
    handleError(error);
  }
}

async function refresh({ silent = false } = {}) {
  if (state.refreshing || !state.token) return;
  state.refreshing = true;
  try {
    const body = await request("/api/runs");
    state.runs = body.runs || [];
    setConnection(true, "已连接");
    setText("lastSync", `更新于 ${clock(new Date().toISOString())}`);
    for (const runId of state.expanded) await loadEvents(runId);
    renderRuns();
    if (!silent) toast("任务状态已刷新");
  } catch (error) {
    handleError(error, silent);
  } finally {
    state.refreshing = false;
  }
}

async function runAction(run, action) {
  if (action === "cancel" && !window.confirm("确认取消这个任务？会话、PR 和历史状态都会保留。")) return;
  try {
    const updated = await request(`/api/runs/${run.run_id}/${action}`, { method: "POST" });
    const index = state.runs.findIndex((item) => item.run_id === run.run_id);
    if (index >= 0) state.runs[index] = updated;
    await loadEvents(run.run_id);
    renderRuns();
    toast(action === "reconcile" ? "已完成机械核对" : action === "resume" ? "任务已恢复" : "任务已取消");
  } catch (error) {
    handleError(error);
  }
}

function openConnection() {
  $("apiUrl").value = state.apiUrl;
  $("operatorToken").value = state.token;
  $("connectionDialog").showModal();
}

function openNewRun() {
  if (!state.token || !state.connected) {
    openConnection();
    toast("请先连接任务调度器", "error");
    return;
  }
  $("newRunDialog").showModal();
  $("requestInput").focus();
}

$("connectionButton").addEventListener("click", openConnection);
$("newRunButton").addEventListener("click", openNewRun);
$("emptyStartButton").addEventListener("click", openNewRun);
$("refreshButton").addEventListener("click", () => refresh());

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((item) => item.classList.toggle("active", item === button));
    renderRuns();
  });
});

$("connectionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.apiUrl = $("apiUrl").value.trim().replace(/\/$/, "");
  state.token = $("operatorToken").value;
  try {
    const body = await request("/api/runs");
    sessionStorage.setItem("catsloop.apiUrl", state.apiUrl);
    sessionStorage.setItem("catsloop.operatorToken", state.token);
    state.runs = body.runs || [];
    setConnection(true, "已连接");
    $("connectionDialog").close();
    setText("lastSync", `更新于 ${clock(new Date().toISOString())}`);
    renderRuns();
    toast("任务调度器已连接");
  } catch (error) {
    handleError(error);
  }
});

$("newRunForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const run = await request("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        request: $("requestInput").value.trim(),
        repo: $("repoInput").value.trim(),
        base_branch: $("baseBranchInput").value.trim(),
        monday_agent_uid: Number($("mondayUidInput").value),
        developer_agent_uid: Number($("developerUidInput").value),
      }),
    });
    $("newRunDialog").close();
    $("newRunForm").reset();
    $("baseBranchInput").value = "main";
    $("mondayUidInput").value = "553";
    $("developerUidInput").value = "365";
    state.runs.unshift(run);
    state.expanded.add(run.run_id);
    renderRuns();
    toast("任务已创建并进入队列");
  } catch (error) {
    handleError(error);
  } finally {
    if (submit) submit.disabled = false;
  }
});

setInterval(() => {
  document.querySelectorAll(".task-timer").forEach((node) => {
    node.textContent = durationText(node.dataset.start, node.dataset.end || "");
  });
}, 1_000);
setInterval(() => refresh({ silent: true }), 5_000);

if (state.token) refresh({ silent: true });
else {
  setConnection(false, "未连接");
  renderRuns();
}

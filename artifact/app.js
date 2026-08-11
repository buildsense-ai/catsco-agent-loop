const defaultApiUrl = location.protocol === "https:"
  ? `${location.protocol}//${location.hostname}:19993`
  : "http://127.0.0.1:19992";

const state = {
  apiUrl: sessionStorage.getItem("catsloop.apiUrl") || defaultApiUrl,
  token: sessionStorage.getItem("catsloop.operatorToken") || "",
  runs: [],
  selectedId: null,
  events: [],
  filter: "all",
  connected: false,
  refreshing: false,
  eventCursor: 0,
  eventsExpanded: false,
};

const terminalPhases = new Set(["completed", "cancelled", "blocked", "blocked_auth", "blocked_github_auth"]);
const activePhases = new Set(["queued", "monday_finding", "developer_implementing", "waiting_ci", "monday_review", "recovering"]);
const stageOrder = ["monday_finding", "developer_implementing", "waiting_ci", "monday_review", "completed"];
const phaseLabels = {
  queued: "排队",
  monday_finding: "Monday 调查",
  developer_implementing: "Developer 实现",
  waiting_ci: "等待 CI",
  monday_review: "Monday 审核",
  recovering: "恢复中",
  blocked: "已阻塞",
  blocked_auth: "CatsCo 认证阻塞",
  blocked_github_auth: "GitHub 认证阻塞",
  cancelled: "已取消",
  completed: "已完成",
};
const cycleLabels = {
  active: "审核中",
  revision_requested: "需要修改",
  approved: "已批准",
  superseded: "已归档",
};

const $ = (id) => document.getElementById(id);

function create(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function setText(id, value, fallback = "—") {
  $(id).textContent = value === undefined || value === null || value === "" ? fallback : String(value);
}

function short(value, length = 10) {
  if (!value) return "—";
  return value.length > length ? value.slice(0, length) : value;
}

function age(value) {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - parsed) / 1000));
  if (seconds < 10) return "刚刚";
  if (seconds < 60) return `${seconds} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

function clock(value) {
  if (!value) return "—";
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function effectivePhase(run) {
  return run.phase === "recovering" && run.resume_phase ? run.resume_phase : run.phase;
}

function selectedRun() {
  return state.runs.find((run) => run.run_id === state.selectedId) || null;
}

function toast(message, kind = "ok") {
  const node = $("toast");
  node.textContent = message;
  node.classList.toggle("error", kind === "error");
  node.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => node.classList.remove("show"), 3600);
}

function setConnection(connected, label) {
  state.connected = connected;
  $("connectionState").dataset.state = connected ? "online" : "offline";
  setText("healthText", label, connected ? "已连接" : "未连接");
}

async function api(path, options = {}) {
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
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Controller 响应超时");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function runMatchesFilter(run) {
  if (state.filter === "active") return activePhases.has(run.phase);
  if (state.filter === "done") return terminalPhases.has(run.phase);
  return true;
}

function taskTitle(request) {
  const normalized = String(request || "未命名任务").replace(/\s+/g, " ").trim();
  const firstSentence = normalized.match(/^.*?[。！？!?](?:\s|$)|^.*?\.(?:\s|$)/)?.[0]?.trim();
  const candidate = firstSentence && firstSentence.length >= 12 ? firstSentence : normalized;
  return candidate.length > 96 ? `${candidate.slice(0, 93).trim()}…` : candidate;
}

function renderRuns() {
  const list = $("runList");
  list.replaceChildren();
  setText("runCount", state.runs.length, "0");
  const runs = state.runs.filter(runMatchesFilter);
  if (!runs.length) {
    list.append(create("div", "sidebar-empty", state.connected ? "这个筛选下没有任务。" : "连接 Controller 后显示任务。"));
    return;
  }

  for (const run of runs) {
    const item = create("button", `run-item${run.run_id === state.selectedId ? " active" : ""}`);
    item.type = "button";
    item.append(create("strong", "", run.request));
    item.append(create("small", "", `${run.repo} · R${run.iteration}`));
    const meta = create("div", "run-item-meta");
    meta.append(
      create("span", `phase-pill${terminalPhases.has(run.phase) ? " terminal" : ""}`, phaseLabels[run.phase] || run.phase),
      create("time", "", age(run.updated_at)),
    );
    item.append(meta);
    item.addEventListener("click", () => selectRun(run.run_id));
    list.append(item);
  }
}

function renderPhase(run) {
  const phase = effectivePhase(run);
  const index = run.phase === "completed" ? stageOrder.length - 1 : stageOrder.indexOf(phase);
  const nodes = [...document.querySelectorAll("[data-stage]")];
  nodes.forEach((node, nodeIndex) => {
    node.classList.toggle("active", nodeIndex === index && run.phase !== "completed");
    node.classList.toggle("done", run.phase === "completed" || nodeIndex < index);
    const connector = node.nextElementSibling;
    if (connector?.tagName === "I") connector.classList.toggle("done", run.phase === "completed" || nodeIndex < index);
  });
}

function episodeText(agent) {
  if (!agent?.episode) return { label: "未观测", state: "" };
  const snapshot = agent.episode.state || "unknown";
  return { label: `${snapshot} · ${age(agent.episode_observed_at)}`, state: snapshot };
}

function renderAgents(run) {
  setText("mondayTopic", run.monday?.topic_id || "Topic 尚未创建");
  setText("developerTopic", run.developer?.topic_id || "Topic 尚未创建");
  setText("topicCount", `${Number(Boolean(run.monday?.topic_id)) + Number(Boolean(run.developer?.topic_id))} / 2`);
  for (const [name, agent] of [["monday", run.monday], ["developer", run.developer]]) {
    const observation = episodeText(agent);
    const node = $(`${name}Episode`);
    node.textContent = observation.label;
    node.className = `episode-pill${observation.state ? ` ${observation.state}` : ""}`;
  }
}

function renderHistory(run) {
  const list = $("historyList");
  list.replaceChildren();
  const cycles = [...(run.review_cycles || [])].sort((a, b) => b.cycle - a.cycle);
  setText("historyCount", `${cycles.length} CYCLE / ${(run.finding_history || []).length} ZIP`);
  if (!cycles.length) {
    list.append(create("p", "", "CI 通过后，这里会保留每轮审核及其 ZIP。"));
    return;
  }
  for (const cycle of cycles) {
    const item = create("div", "history-item");
    item.append(create("b", "", `C${cycle.cycle}`));
    const detail = create("div");
    detail.append(
      create("strong", "", `Head ${short(cycle.head_sha, 12)}`),
      create("small", "", cycle.finding
        ? `ZIP v${cycle.finding.version} · ${short(cycle.finding.sha256, 12)}`
        : cycle.evidence
          ? `${cycle.evidence.kind} · ${cycle.evidence.state || "comment"}`
          : "没有本轮 ZIP"),
    );
    item.append(detail, create("span", cycle.status, cycleLabels[cycle.status] || cycle.status));
    list.append(item);
  }
}

function renderTimeline() {
  const list = $("timeline");
  const toggle = $("eventToggle");
  list.replaceChildren();
  setText("eventCount", `${state.events.length} EVENTS`);
  if (!state.events.length) {
    toggle.hidden = true;
    list.append(create("li", "timeline-empty", "暂无事件。"));
    return;
  }
  const limit = state.eventsExpanded ? 120 : 18;
  for (const event of [...state.events].reverse().slice(0, limit)) {
    const item = create("li");
    item.append(create("time", "", clock(event.at)), create("i"));
    const copy = create("div");
    copy.append(
      create("strong", "", event.type.replaceAll("_", " ")),
      create("p", "", event.message),
    );
    item.append(copy);
    list.append(item);
  }
  toggle.hidden = state.events.length <= 18;
  toggle.textContent = state.eventsExpanded ? "收起" : `展开全部 +${state.events.length - 18}`;
}

function renderDetail() {
  const run = selectedRun();
  $("emptyState").hidden = Boolean(run);
  $("runView").hidden = !run;
  if (!run) return;

  setText("runId", run.run_id);
  setText("runTitle", taskTitle(run.request));
  setText("runRequest", run.request);
  setText("repoLabel", `${run.repo} · ${run.base_branch}`);
  setText("activeActor", run.active_actor);
  setText("waitingFor", run.waiting_for);
  setText("activityLabel", `${run.activity_state || "quiet"} · 最近活动 ${age(run.last_activity_at)}`);
  $("activityDot").className = run.activity_state || "quiet";

  const prLink = $("prLink");
  prLink.hidden = !run.pr?.url;
  if (run.pr?.url) prLink.href = run.pr.url;
  renderPhase(run);

  const cycle = run.review_cycle;
  setText("cycleBadge", cycle ? `CYCLE ${cycle.cycle}` : "未开始");
  setText("cycleHead", cycle ? short(cycle.head_sha, 14) : "—");
  setText("cycleStatus", cycle ? cycleLabels[cycle.status] || cycle.status : "—");
  setText("cycleHint", cycle
    ? cycle.completion_reason || `本轮仅接受绑定 Head ${short(cycle.head_sha, 10)} 的证据。`
    : "CI 通过后创建审核轮次。");

  setText("iteration", String(run.iteration).padStart(2, "0"));
  setText("mondayAttempts", run.monday_attempt);
  setText("developerAttempts", run.developer_attempt);
  setText("recoveryAttempts", run.recovery_attempt);
  setText("ciState", run.ci?.state || "未观测");
  $("ciState").dataset.state = run.ci?.state || "unknown";
  setText("headSha", short(run.pr?.head_sha, 12));
  setText("checkCount", run.ci?.checks?.length ?? 0);
  setText("lastProgress", age(run.last_progress_at));

  const finding = run.latest_finding;
  setText("findingLabel", finding ? `Finding v${finding.version}` : "尚未交付");
  setText("findingMeta", finding ? `${Math.ceil(finding.size / 1024)} KB · ${short(finding.sha256, 13)}` : "等待 Monday ZIP");
  setText("prLabel", run.pr ? `PR #${run.pr.number}` : "尚未创建");
  setText("branchLabel", run.branch);
  setText("reviewLabel", cycle?.evidence ? cycleLabels[cycle.status] || cycle.status : "等待审核");
  setText("reviewMeta", cycle?.evidence ? `${cycle.evidence.author} · ${cycle.evidence.state || cycle.evidence.kind}` : "当前 Head 尚无审核证据");

  renderAgents(run);
  renderHistory(run);
  setText("terminalReason", run.terminal_reason || "Controller 只核对证据，不替 Agent comment、approve 或 merge。");
  $("resumeButton").hidden = !["blocked", "blocked_auth", "blocked_github_auth"].includes(run.phase);
  $("cancelButton").hidden = terminalPhases.has(run.phase);
  renderTimeline();
}

async function loadEvents(runId, reset = false) {
  if (reset) {
    state.events = [];
    state.eventCursor = 0;
  }
  const body = await api(`/api/runs/${runId}/events?after=${state.eventCursor}`);
  const incoming = body.events || [];
  if (incoming.length) {
    const seen = new Set(state.events.map((event) => event.seq));
    state.events.push(...incoming.filter((event) => !seen.has(event.seq)));
    state.events.sort((a, b) => a.seq - b.seq);
    state.eventCursor = state.events.at(-1)?.seq || state.eventCursor;
  }
  renderTimeline();
}

async function selectRun(runId) {
  try {
    if (state.selectedId !== runId) state.eventsExpanded = false;
    state.selectedId = runId;
    const detail = await api(`/api/runs/${runId}`);
    const index = state.runs.findIndex((run) => run.run_id === runId);
    if (index >= 0) state.runs[index] = detail;
    else state.runs.unshift(detail);
    await loadEvents(runId, true);
    renderRuns();
    renderDetail();
  } catch (error) {
    handleError(error);
  }
}

$("eventToggle").addEventListener("click", () => {
  state.eventsExpanded = !state.eventsExpanded;
  renderTimeline();
});

async function refresh({ silent = false } = {}) {
  if (!state.token || state.refreshing) return;
  state.refreshing = true;
  try {
    const body = await api("/api/runs");
    state.runs = body.runs || [];
    if (state.selectedId && !state.runs.some((run) => run.run_id === state.selectedId)) state.selectedId = null;
    if (!state.selectedId && state.runs.length) {
      state.selectedId = state.runs[0].run_id;
      state.events = [];
      state.eventCursor = 0;
      state.eventsExpanded = false;
    }
    setConnection(true, "Controller online");
    setText("lastSync", clock(new Date().toISOString()));
    renderRuns();
    renderDetail();
    if (state.selectedId) await loadEvents(state.selectedId);
    if (!silent) toast("状态已刷新");
  } catch (error) {
    handleError(error, silent);
  } finally {
    state.refreshing = false;
  }
}

function handleError(error, silent = false) {
  setConnection(false, error.status === 401 ? "Token 无效" : "连接异常");
  if (!silent) toast(error.message || String(error), "error");
  if (error.status === 401) $("connectionDialog").showModal();
}

function openConnection() {
  $("apiUrl").value = state.apiUrl;
  $("operatorToken").value = state.token;
  $("connectionDialog").showModal();
}

function openNewRun() {
  if (!state.token || !state.connected) {
    openConnection();
    toast("请先连接 Controller", "error");
    return;
  }
  $("newRunDialog").showModal();
  $("requestInput").focus();
}

async function runAction(action) {
  const run = selectedRun();
  if (!run) return;
  if (action === "cancel" && !window.confirm("确认取消这个 Run？Topic、PR 和历史状态都会保留。")) return;
  try {
    const updated = await api(`/api/runs/${run.run_id}/${action}`, { method: "POST" });
    const index = state.runs.findIndex((item) => item.run_id === run.run_id);
    if (index >= 0) state.runs[index] = updated;
    await loadEvents(run.run_id);
    renderRuns();
    renderDetail();
    toast(action === "reconcile" ? "已完成机械核对" : action === "resume" ? "Run 已恢复" : "Run 已取消");
  } catch (error) {
    handleError(error);
  }
}

$("connectionButton").addEventListener("click", openConnection);
$("newRunButton").addEventListener("click", openNewRun);
$("emptyStartButton").addEventListener("click", openNewRun);
$("refreshButton").addEventListener("click", () => refresh());
$("reconcileButton").addEventListener("click", () => runAction("reconcile"));
$("resumeButton").addEventListener("click", () => runAction("resume"));
$("cancelButton").addEventListener("click", () => runAction("cancel"));

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
    const body = await api("/api/runs");
    sessionStorage.setItem("catsloop.apiUrl", state.apiUrl);
    sessionStorage.setItem("catsloop.operatorToken", state.token);
    state.runs = body.runs || [];
    if (!state.selectedId && state.runs.length) {
      state.selectedId = state.runs[0].run_id;
      state.events = [];
      state.eventCursor = 0;
      state.eventsExpanded = false;
    }
    setConnection(true, "Controller online");
    $("connectionDialog").close();
    renderRuns();
    renderDetail();
    if (state.selectedId) await loadEvents(state.selectedId);
    toast("Controller 已连接");
  } catch (error) {
    handleError(error);
  }
});

$("newRunForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  if (submit) submit.disabled = true;
  try {
    const run = await api("/api/runs", {
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
    await selectRun(run.run_id);
    toast("Run 已创建并进入队列");
  } catch (error) {
    handleError(error);
  } finally {
    if (submit) submit.disabled = false;
  }
});

if (state.token) refresh({ silent: true });
else setConnection(false, "未连接");

setInterval(() => refresh({ silent: true }), 5_000);

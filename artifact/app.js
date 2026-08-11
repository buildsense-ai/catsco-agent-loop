const state = {
  apiUrl: sessionStorage.getItem("catsloop.apiUrl") || (location.protocol === "https:" ? `${location.protocol}//${location.hostname}:19993` : "http://127.0.0.1:19992"),
  token: sessionStorage.getItem("catsloop.operatorToken") || "",
  runs: [],
  selected: null,
  events: [],
  poller: null,
};

const $ = (id) => document.getElementById(id);
const terminal = new Set(["completed", "cancelled", "blocked", "blocked_auth", "blocked_github_auth"]);
const stages = ["monday_finding", "developer_implementing", "waiting_ci", "monday_review", "completed"];

async function api(path, options = {}) {
  const response = await fetch(new URL(path, state.apiUrl), {
    ...options,
    headers: { authorization: `Bearer ${state.token}`, ...(options.body ? { "content-type": "application/json" } : {}), ...options.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

function toast(message) {
  $("toast").textContent = message;
  $("toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("toast").classList.remove("show"), 3500);
}

function health(ok, label) {
  $("healthDot").classList.toggle("online", ok);
  $("healthText").textContent = label;
}

function short(value, length = 10) {
  if (!value) return "—";
  return value.length > length ? value.slice(0, length) : value;
}

function age(value) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function create(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function episodeObservation(agent, isActive) {
  if (!agent?.episode) return "not observed";
  const observed = agent.episode_observed_at ? `observed ${age(agent.episode_observed_at)}` : "observation time unknown";
  return `${agent.episode.state} · ${observed} · ${isActive ? "ACTIVE" : "inactive snapshot"}`;
}

function renderRuns() {
  const list = $("runList");
  list.replaceChildren();
  if (!state.runs.length) {
    list.append(create("div", "empty-rail", "还没有显式创建的 Run"));
    return;
  }
  for (const run of state.runs) {
    const button = create("button", `run-item${state.selected?.run_id === run.run_id ? " active" : ""}`);
    button.type = "button";
    button.append(create("strong", "", run.request));
    const meta = create("span");
    meta.append(create("em", "", run.phase.replaceAll("_", " ")), create("b", "", `R${run.iteration}`));
    button.append(meta);
    button.addEventListener("click", () => selectRun(run.run_id));
    list.append(button);
  }
}

function setText(id, value) { $(id).textContent = value ?? "—"; }

function renderDetail() {
  const run = state.selected;
  $("emptyState").hidden = Boolean(run);
  $("runView").hidden = !run;
  if (!run) return;
  setText("runId", run.run_id);
  setText("runTitle", run.request);
  setText("activeActor", run.active_actor);
  setText("waitingFor", run.waiting_for);
  setText("phase", run.phase.replaceAll("_", " "));
  setText("lastProgress", `progress ${age(run.last_progress_at)}`);
  setText("activityState", run.activity_state?.replaceAll("_", " ") || "quiet");
  setText("lastActivity", `activity ${age(run.last_activity_at)}`);
  setText("iteration", String(run.iteration).padStart(2, "0"));
  setText("attempts", `M ${run.monday_attempt} · D ${run.developer_attempt} · R ${run.recovery_attempt}`);
  setText("ciState", run.ci?.state || "not observed");
  setText("headSha", short(run.pr?.head_sha, 12));
  setText("repo", `${run.repo} @ ${run.base_branch}`);
  setText("branch", run.branch);
  setText("finding", run.latest_finding ? `v${run.latest_finding.version} · ${short(run.latest_finding.sha256, 14)} · ${Math.ceil(run.latest_finding.size / 1024)} KB` : "—");
  setText("mondayTopic", run.monday.topic_id || "—");
  setText("mondayObservation", episodeObservation(run.monday, run.active_actor === "monday"));
  setText("developerTopic", run.developer.topic_id || "—");
  setText("developerObservation", episodeObservation(run.developer, run.active_actor === "developer"));
  const pr = $("pullRequest");
  pr.replaceChildren();
  if (run.pr?.url) {
    const anchor = create("a", "", `PR #${run.pr.number}`);
    anchor.href = run.pr.url; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
    pr.append(anchor);
  } else pr.textContent = "—";
  const currentStage = stages.includes(run.phase) ? stages.indexOf(run.phase) : run.phase === "completed" ? 4 : -1;
  document.querySelectorAll("[data-stage]").forEach((node, index) => {
    node.classList.toggle("active", index === currentStage);
    node.classList.toggle("done", index < currentStage || run.phase === "completed");
  });
  $("resumeButton").hidden = !["blocked", "blocked_auth", "blocked_github_auth"].includes(run.phase);
  $("cancelButton").hidden = terminal.has(run.phase);
  renderTimeline();
}

function renderTimeline() {
  const list = $("timeline");
  list.replaceChildren();
  for (const event of [...state.events].reverse()) {
    const item = create("li");
    item.append(create("time", "", new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })), create("b"));
    const copy = create("div");
    copy.append(create("strong", "", event.type.replaceAll("_", " ")), create("span", "", event.message));
    item.append(copy);
    list.append(item);
  }
  setText("eventCount", `${state.events.length} EVENTS`);
}

async function refresh() {
  if (!state.token) return;
  try {
    const body = await api("/api/runs");
    state.runs = body.runs;
    if (state.selected) state.selected = state.runs.find((run) => run.run_id === state.selected.run_id) || null;
    renderRuns(); renderDetail(); health(true, "Controller online");
    if (state.selected) {
      const events = await api(`/api/runs/${state.selected.run_id}/events?after=0`);
      state.events = events.events;
      renderTimeline();
    }
  } catch (error) {
    health(false, "连接失败");
    toast(error.message);
  }
}

async function selectRun(runId) {
  state.selected = state.runs.find((run) => run.run_id === runId) || await api(`/api/runs/${runId}`);
  state.events = (await api(`/api/runs/${runId}/events?after=0`)).events;
  renderRuns(); renderDetail();
}

function openConnection() {
  $("apiUrl").value = state.apiUrl;
  $("operatorToken").value = state.token;
  $("connectionDialog").showModal();
}

function openNewRun() {
  if (!state.token) { openConnection(); return; }
  $("newRunDialog").showModal();
}

$("connectionButton").addEventListener("click", openConnection);
$("newRunButton").addEventListener("click", openNewRun);
$("emptyStartButton").addEventListener("click", openNewRun);
document.querySelectorAll(".close-button").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
$("connectionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.apiUrl = $("apiUrl").value.replace(/\/$/, "");
  state.token = $("operatorToken").value;
  try {
    await api("/api/runs");
    sessionStorage.setItem("catsloop.apiUrl", state.apiUrl);
    sessionStorage.setItem("catsloop.operatorToken", state.token);
    $("connectionDialog").close();
    await refresh();
  } catch (error) { toast(error.message); }
});
$("newRunForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const run = await api("/api/runs", { method: "POST", body: JSON.stringify({
      request: $("request").value,
      repo: $("repoInput").value,
      base_branch: $("baseBranch").value,
      monday_agent_uid: Number($("mondayUid").value),
      developer_agent_uid: Number($("developerUid").value),
    }) });
    $("newRunDialog").close();
    $("newRunForm").reset(); $("baseBranch").value = "main"; $("mondayUid").value = "553"; $("developerUid").value = "365";
    await refresh(); await selectRun(run.run_id); toast("Run 已创建并排队");
  } catch (error) { toast(error.message); }
});

for (const [id, action] of [["reconcileButton", "reconcile"], ["resumeButton", "resume"], ["cancelButton", "cancel"]]) {
  $(id).addEventListener("click", async () => {
    if (!state.selected) return;
    try {
      await api(`/api/runs/${state.selected.run_id}/${action}`, { method: "POST" });
      await refresh(); toast(`${action} 已提交`);
    } catch (error) { toast(error.message); }
  });
}

if (state.token) refresh(); else openConnection();
state.poller = setInterval(refresh, 5000);

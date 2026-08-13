import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("Artifact is a display and control surface, not a Run creation entrypoint", async () => {
  const [html, script] = await Promise.all([
    readFile(new URL("../artifact/index.html", import.meta.url), "utf8"),
    readFile(new URL("../artifact/app.js", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(html, /newRun|新建任务|创建任务/);
  assert.doesNotMatch(script, /POST[\s\S]{0,120}["'`]\/api\/runs["'`]/);
  assert.match(script, /Artifact 只展示和管理任务，不负责创建任务/);
  assert.match(script, /runAction\(run,"pause"\)/);
  assert.match(script, /finding-v/);
  assert.match(script, /run\.pr\?\.url/);
  assert.doesNotMatch(html, /id="apiUrl"|接口地址/);
  assert.match(script, /window\.location\.hostname}:19993/);
  assert.match(script, /refresh\(true\)/);
  assert.match(script, /collapseStatusEvents/);
  assert.match(script, /statusKey\(previous\) === statusKey\(item\)/);
  assert.match(script, /item\.actor === "controller"/);
  assert.match(script, /action!=="pause"&&!state\.token/);
});

test("Artifact keeps a fixed latest Finding download beside the heading without removing history", async () => {
  const script = await readFile(new URL("../artifact/app.js", import.meta.url), "utf8");
  const elements = new Map<string, FakeArtifactElement>();

  class FakeArtifactElement {
    className = "";
    textContent = "";
    dataset: Record<string, string> = {};
    childNodes: FakeArtifactElement[] = [];
    lastChild?: FakeArtifactElement;
    style: Record<string, string> = {};
    href = "";
    download = "";
    type = "";
    value = "";
    onclick?: () => void;
    onsubmit?: () => void;

    constructor(readonly tagName = "div") {}
    append(...children: FakeArtifactElement[]) {
      this.childNodes.push(...children);
      this.lastChild = this.childNodes.at(-1);
    }
    addEventListener() {}
    classList = { add() {}, remove() {}, toggle() {} };
  }

  const document = {
    createElement: (tag: string) => new FakeArtifactElement(tag),
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, new FakeArtifactElement());
      return elements.get(id);
    },
    querySelectorAll: () => [],
    body: new FakeArtifactElement("body"),
  };
  const context = vm.createContext({
    console,
    Date,
    Intl,
    Map,
    Set,
    URL,
    document,
    window: { location: { protocol: "https:", hostname: "artifact.example" } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => new Promise(() => {}),
    requestAnimationFrame: () => 0,
    setInterval: () => 0,
    setTimeout: () => 0,
    clearTimeout() {},
    confirm: () => true,
  });
  vm.runInContext(script, context);

  const run = {
    run_id: "run_demo",
    request: "Improve the Finding download.",
    latest_finding: { version: 2 },
    finding_history: [{ version: 1, validated_at: "2026-08-13T00:00:00Z" }, { version: 2, validated_at: "2026-08-13T00:01:00Z" }],
  };
  Object.assign(context, { runFixture: run });
  const detail = vm.runInContext("taskDetail(runFixture)", context) as FakeArtifactElement;
  const latestDownload = findByClass(detail, "finding-download");
  assert.ok(latestDownload, "a latest Finding should expose a fixed ZIP download in task details");
  assert.equal(latestDownload.textContent, "下载 ZIP · v2 ↓");
  assert.match(latestDownload.href, /\/api\/runs\/run_demo\/findings\/2\/download$/);
  assert.equal(findByClass(detail, "finding-heading")?.childNodes[0]?.textContent, "最新 Finding · v2");

  Object.assign(context, { runWithoutFinding: { run_id: "run_empty", request: "No Finding yet." } });
  const emptyDetail = vm.runInContext("taskDetail(runWithoutFinding)", context) as FakeArtifactElement;
  assert.equal(findByClass(emptyDetail, "finding-download"), undefined, "the fixed download must stay hidden without a Finding");

  Object.assign(context, {
    historyItem: {
      type: "finding_validated", icon: "MON", name: "Monday", cycle: 1, title: "Finding ZIP 已验证",
      message: "validated", at: "2026-08-13T00:00:00Z", data: { version: 1 },
    },
  });
  const historyCard = vm.runInContext("eventCard(runFixture, historyItem, false)", context) as FakeArtifactElement;
  const historicalDownload = findByClass(historyCard, "zip-link");
  assert.ok(historicalDownload, "older Finding activity links should remain available");
  assert.equal(historicalDownload.textContent, "finding-v1.zip ↓");
  assert.match(historicalDownload.href, /\/api\/runs\/run_demo\/findings\/1\/download$/);
});

test("Artifact updates the current phase elapsed time every second", async () => {
  const script = await readFile(new URL("../artifact/app.js", import.meta.url), "utf8");
  const intervals: Array<{ callback: () => void; delay: number }> = [];
  const selectorNodes = new Map<string, FakeElement[]>();
  const elements = new Map<string, FakeElement>();
  let now = Date.parse("2026-08-12T10:00:00.000Z");

  class FakeElement {
    className = "";
    textContent = "";
    dataset: Record<string, string> = {};
    childNodes: FakeElement[] = [];
    lastChild?: FakeElement;
    onclick?: () => void;
    onsubmit?: () => void;
    style: Record<string, string> = {};
    value = "";
    type = "";
    href = "";
    target = "";
    rel = "";

    constructor(readonly tagName = "div") {}
    append(...children: FakeElement[]) {
      this.childNodes.push(...children);
      this.lastChild = this.childNodes.at(-1);
    }
    addEventListener() {}
    classList = { add() {}, remove() {}, toggle() {} };
  }

  class FakeDate extends Date {
    constructor(value?: string | number | Date) {
      super(value === undefined ? now : value);
    }
    static now() { return now; }
  }

  const document = {
    createElement: (tag: string) => new FakeElement(tag),
    getElementById: (id: string) => {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    querySelectorAll: (selector: string) => selectorNodes.get(selector) ?? [],
    body: new FakeElement("body"),
  };
  const context = vm.createContext({
    console,
    Date: FakeDate,
    Intl,
    Map,
    Set,
    URL,
    document,
    window: { location: { protocol: "http:", hostname: "localhost" } },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    fetch: () => new Promise(() => {}),
    requestAnimationFrame: () => 0,
    setInterval: (callback: () => void, delay: number) => { intervals.push({ callback, delay }); return intervals.length; },
    setTimeout: () => 0,
    clearTimeout() {},
    confirm: () => true,
  });

  vm.runInContext(script, context);
  const run = { phase: "developer_implementing", phase_started_at: "2026-08-12T09:59:58.000Z" };
  const item = { icon: "DEV", name: "Developer", cycle: 1, title: "开发中", message: "working", at: run.phase_started_at, startedAt: run.phase_started_at, data: {} };
  Object.assign(context, { runFixture: run, itemFixture: item });
  const card = vm.runInContext("eventCard(runFixture, itemFixture, true)", context) as FakeElement;
  const live = findByClass(card, "live");
  assert.ok(live, "a running current phase should render a live timer");
  assert.equal(live.dataset.start, run.phase_started_at);
  assert.equal(live.textContent, "已运行 00:02");

  selectorNodes.set(".timing .live", [live]);
  const oneSecondTimer = intervals.find((interval) => interval.delay === 1000);
  assert.ok(oneSecondTimer, "the production script should install a one-second timer");
  now += 1_000;
  oneSecondTimer.callback();
  assert.equal(live.textContent, "已运行 00:03");

  now += 4_000;
  oneSecondTimer.callback();
  assert.equal(live.textContent, "已运行 00:07", "the timer should recalculate from timestamps instead of accumulating ticks");

  const paused = vm.runInContext("eventCard({ ...runFixture, phase: 'paused' }, itemFixture, true)", context) as FakeElement;
  assert.equal(findByClass(paused, "live"), undefined, "paused phases should keep a fixed duration");
});

function findByClass(root: FakeElement, className: string): FakeElement | undefined {
  if (root.className.split(/\s+/).includes(className)) return root;
  for (const child of root.childNodes) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return undefined;
}

interface FakeElement {
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  childNodes: FakeElement[];
}

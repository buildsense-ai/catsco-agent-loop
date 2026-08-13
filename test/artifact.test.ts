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
  assert.match(script, /window\.location\.hostname}:19992/);
  assert.match(script, /https:\/\/\$\{window\.location\.hostname}:19993/);
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
    target = "";
    rel = "";
    download = "";
    type = "";
    value = "";
    selected = false;
    scrollTop = 0;
    attributes: Record<string, string> = {};
    listeners: Record<string, Array<() => void | Promise<void>>> = {};
    onclick?: () => void;
    onsubmit?: () => void;

    constructor(readonly tagName = "div") {}
    append(...children: FakeArtifactElement[]) {
      this.childNodes.push(...children);
      this.lastChild = this.childNodes.at(-1);
    }
    addEventListener(type: string, listener: () => void | Promise<void>) { (this.listeners[type] ||= []).push(listener); }
    setAttribute(name: string, value: string) { this.attributes[name] = value; }
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

  const markdown = [
    "# Safe heading",
    "",
    "- first item",
    "- **bold item** with `inline code`",
    "",
    "1. ordered item",
    "",
    "> quoted text",
    "",
    "```js",
    "const answer = 42;",
    "```",
    "",
    "[safe link](https://example.com/docs) and [relative link](./evidence.txt)",
    "",
    "<script>globalThis.pwned = true</script>",
    "<img src=x onerror=globalThis.pwned=true>",
    "[bad scheme](javascript:alert(1)) [encoded bad](jav&#x61;script:alert(1))",
    "[hex overflow](&#x110000;) [decimal overflow](&#1114112;)",
  ].join("\n");
  Object.assign(context, { markdownFixture: markdown });
  const rendered = vm.runInContext("renderFindingMarkdown(markdownFixture)", context) as FakeArtifactElement;
  assert.equal(textOf(findByTag(rendered, "h1")), "Safe heading");
  assert.ok(findByTag(rendered, "ul"), "unordered lists should use semantic DOM");
  assert.ok(findByTag(rendered, "ol"), "ordered lists should use semantic DOM");
  assert.equal(textOf(findByTag(rendered, "strong")), "bold item");
  assert.ok(findAllByTag(rendered, "code").some((element) => element.textContent === "inline code"));
  assert.equal(textOf(findByTag(rendered, "pre")), "const answer = 42;");
  assert.equal(textOf(findByTag(rendered, "blockquote")), "quoted text");
  assert.equal(findByTag(rendered, "script"), undefined, "raw HTML must never create script elements");
  assert.equal(findByTag(rendered, "img"), undefined, "raw HTML must never create event-bearing elements");
  const links = findAllByTag(rendered, "a") as Array<FakeArtifactElement>;
  assert.deepEqual(links.map((link) => link.href), ["https://example.com/docs", "./evidence.txt"]);
  assert.equal(links[0]?.target, "_blank");
  assert.equal(links[0]?.rel, "noopener noreferrer");
  assert.equal(links[1]?.target, "");

  vm.runInContext('state.findings.set("run_demo:2", { markdown: "# Version 2" }); state.findings.set("run_demo:1", { markdown: "# Version 1" });', context);
  const latestDetail = vm.runInContext("taskDetail(runFixture)", context) as FakeArtifactElement;
  assert.equal(textOf(findByTag(findByClass(latestDetail, "finding-markdown")!, "h1")), "Version 2");
  const selector = findByTag(latestDetail, "select") as FakeArtifactElement;
  assert.deepEqual(selector.childNodes.map((option) => option.value), ["1", "2"]);
  assert.equal(selector.childNodes[1]?.selected, true);

  vm.runInContext('state.selectedFindings.set("run_demo", 1)', context);
  const historicalDetail = vm.runInContext("taskDetail(runFixture)", context) as FakeArtifactElement;
  assert.equal(findByClass(historicalDetail, "finding-heading")?.childNodes[0]?.textContent, "历史 Finding · v1");
  assert.equal(textOf(findByTag(findByClass(historicalDetail, "finding-markdown")!, "h1")), "Version 1");
  assert.equal(findByClass(historicalDetail, "finding-download")?.textContent, "下载 ZIP · v1 ↓");
  assert.match((findByClass(historicalDetail, "finding-download") as FakeArtifactElement).href, /\/findings\/1\/download$/);

  const requested: string[] = [];
  Object.assign(context, {
    runHistory: { run_id: "run_history", latest_finding: { version: 2 }, finding_history: [{ version: 1 }, { version: 2 }] },
    fetch: async (input: URL) => {
      requested.push(String(input));
      return { ok: true, json: async () => ({ markdown: "# Historical response" }) };
    },
  });
  vm.runInContext('state.selectedFindings.set("run_history", 1)', context);
  await vm.runInContext("loadFinding(runHistory)", context);
  assert.match(requested[0] || "", /\/api\/runs\/run_history\/findings\/1$/);
  assert.equal(vm.runInContext('state.findings.get("run_history:1").markdown', context), "# Historical response");
});

test("Artifact styles keep rendered Findings scrollable and readable on narrow screens", async () => {
  const styles = await readFile(new URL("../artifact/styles.css", import.meta.url), "utf8");
  assert.match(styles, /\.finding-copy\s*\{[^}]*max-height:\s*220px;[^}]*overflow:\s*auto;/s);
  assert.match(styles, /\.finding-markdown pre\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.match(styles, /\.finding-copy\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  assert.match(styles, /\.detail\s*>\s*\*\s*\{[^}]*min-width:\s*0;/s);
  assert.match(styles, /@media \(max-width:\s*780px\)[\s\S]*\.finding-heading\s*\{[^}]*flex-direction:\s*column;/);
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

function findByTag(root: FakeElement, tagName: string): FakeElement | undefined {
  if (root.tagName === tagName) return root;
  for (const child of root.childNodes) {
    const match = findByTag(child, tagName);
    if (match) return match;
  }
  return undefined;
}

function findAllByTag(root: FakeElement, tagName: string): FakeElement[] {
  return [
    ...(root.tagName === tagName ? [root] : []),
    ...root.childNodes.flatMap((child) => findAllByTag(child, tagName)),
  ];
}

function textOf(root: FakeElement | undefined): string {
  if (!root) return "";
  return root.textContent + root.childNodes.map(textOf).join("");
}

interface FakeElement {
  tagName?: string;
  className: string;
  textContent: string;
  dataset: Record<string, string>;
  childNodes: FakeElement[];
}

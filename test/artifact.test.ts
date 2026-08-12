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

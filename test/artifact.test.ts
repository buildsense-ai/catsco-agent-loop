import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
});

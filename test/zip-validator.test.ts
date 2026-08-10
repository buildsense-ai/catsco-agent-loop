import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import yazl from "yazl";
import { validateFindingZip } from "../src/zip-validator.js";

async function makeZip(entries: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "catsloop-zip-"));
  const path = join(root, "test.zip");
  const zip = new yazl.ZipFile();
  for (const [name, value] of Object.entries(entries)) zip.addBuffer(Buffer.from(value), name);
  zip.end();
  await new Promise<void>((resolve, reject) => zip.outputStream.pipe(createWriteStream(path)).on("close", resolve).on("error", reject));
  return path;
}

test("accepts required Finding contract", async () => {
  const path = await makeZip({ "package/FINDING.md": "ok", "package/manifest.json": "{}" });
  const result = await validateFindingZip(path);
  assert.equal(result.entries.length, 2);
});

test("rejects incomplete Finding contract", async () => {
  const path = await makeZip({ "FINDING.md": "missing manifest" });
  await assert.rejects(validateFindingZip(path), /manifest\.json/);
});

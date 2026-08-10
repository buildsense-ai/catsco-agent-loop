import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const testDirectory = resolve("test");
const files = readdirSync(testDirectory)
  .filter((name) => name.endsWith(".test.ts"))
  .sort()
  .map((name) => join(testDirectory, name));

if (!files.length) throw new Error("No test files found");
const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);

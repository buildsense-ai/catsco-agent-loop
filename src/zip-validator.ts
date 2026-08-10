import { open } from "yauzl";
import { LoopError } from "./errors.js";

export async function validateFindingZip(path: string): Promise<{ entries: string[] }> {
  const zip = await new Promise<import("yauzl").ZipFile>((resolve, reject) => {
    open(path, { lazyEntries: true, autoClose: true }, (error, value) => error ? reject(error) : resolve(value));
  });
  if (!zip) throw new LoopError("Unable to open Finding ZIP", "invalid_finding_zip");
  return await new Promise((resolve, reject) => {
    const entries: string[] = [];
    let finding = false;
    let manifest = false;
    zip.on("entry", (entry) => {
      const name = entry.fileName.replaceAll("\\", "/");
      if (name.startsWith("/") || /^[A-Za-z]:\//.test(name) || name.split("/").includes("..") || name.includes("\0")) {
        zip.close();
        reject(new LoopError(`Unsafe ZIP entry: ${name}`, "unsafe_finding_zip"));
        return;
      }
      entries.push(name);
      const base = name.split("/").filter(Boolean).at(-1)?.toLowerCase();
      if (base === "finding.md") finding = true;
      if (base === "manifest.json") manifest = true;
      if (entries.length > 20_000) {
        zip.close();
        reject(new LoopError("Finding ZIP contains too many entries", "finding_zip_bomb"));
        return;
      }
      zip.readEntry();
    });
    zip.once("error", (error) => reject(new LoopError(`Invalid Finding ZIP: ${error.message}`, "invalid_finding_zip")));
    zip.once("end", () => {
      if (!finding || !manifest) {
        reject(new LoopError("Finding ZIP must contain FINDING.md and manifest.json", "invalid_finding_contract"));
        return;
      }
      resolve({ entries });
    });
    zip.readEntry();
  });
}

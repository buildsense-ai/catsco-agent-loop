import { open } from "yauzl";
import { LoopError } from "./errors.js";

export async function readFindingMarkdown(path: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
  const zip = await new Promise<import("yauzl").ZipFile>((resolve, reject) => {
    open(path, { lazyEntries: true, autoClose: true }, (error, value) => error ? reject(error) : resolve(value));
  });
  if (!zip) throw new LoopError("Unable to open Finding ZIP", "invalid_finding_zip");

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      zip.close();
      reject(error);
    };
    zip.on("entry", (entry) => {
      const base = entry.fileName.replaceAll("\\", "/").split("/").filter(Boolean).at(-1)?.toLowerCase();
      if (base !== "finding.md") {
        zip.readEntry();
        return;
      }
      if (entry.uncompressedSize > maxBytes) {
        fail(new LoopError("FINDING.md exceeds display limit", "finding_markdown_too_large"));
        return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error("Unable to read FINDING.md"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            stream.destroy(new LoopError("FINDING.md exceeds display limit", "finding_markdown_too_large"));
            return;
          }
          chunks.push(chunk);
        });
        stream.once("error", fail);
        stream.once("end", () => {
          if (settled) return;
          settled = true;
          zip.close();
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
      });
    });
    zip.once("error", fail);
    zip.once("end", () => fail(new LoopError("Finding ZIP does not contain FINDING.md", "invalid_finding_contract")));
    zip.readEntry();
  });
}

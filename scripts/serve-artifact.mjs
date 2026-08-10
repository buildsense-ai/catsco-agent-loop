import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../artifact/", import.meta.url));
const port = Number(process.env.PORT || 4173);
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };

createServer(async (request, response) => {
  try {
    const requested = decodeURIComponent(new URL(request.url || "/", "http://localhost").pathname);
    const relative = requested === "/" ? "index.html" : requested.slice(1);
    const path = normalize(join(root, relative));
    if (!path.startsWith(root)) throw new Error("unsafe path");
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    response.writeHead(200, { "content-type": mime[extname(path)] || "application/octet-stream", "cache-control": "no-store" });
    createReadStream(path).pipe(response);
  } catch {
    response.writeHead(404); response.end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`artifact preview http://127.0.0.1:${port}`));

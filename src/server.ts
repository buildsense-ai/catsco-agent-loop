import { join } from "node:path";
import { createLoopApi } from "./app.js";
import { CatscoClient } from "./catsco-client.js";
import { loadConfig } from "./config.js";
import { LoopController } from "./controller.js";
import { GithubClient } from "./github-client.js";
import { RunStore } from "./store.js";

export async function main(): Promise<void> {
  const config = loadConfig();
  const store = new RunStore(config.stateDir, config.activityStallMs);
  const catsco = new CatscoClient(config, join(config.stateDir, "..", "catsco-token.json"));
  const github = new GithubClient(config.noChecksGraceMs);
  const controller = new LoopController(config, store, catsco, github);
  await controller.initialize();
  const api = createLoopApi(controller, store);
  const address = await api.listen(config.host, config.port);
  controller.startScheduler();
  console.log(`catsco-agent-loop listening on ${address.address}:${address.port}`);

  const shutdown = async () => {
    controller.stopScheduler();
    await api.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

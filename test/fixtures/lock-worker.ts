import { appendFile } from "node:fs/promises";

import { withFileLock } from "../../src/fs/atomic.js";

const [lockPath, eventsPath] = process.argv.slice(2);
if (!lockPath || !eventsPath) {
  throw new Error("lock worker requires lock and events paths");
}

await withFileLock(lockPath, async () => {
  await appendFile(eventsPath, `start ${process.pid}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await appendFile(eventsPath, `end ${process.pid}\n`);
});

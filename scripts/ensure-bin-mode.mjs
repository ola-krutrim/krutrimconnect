import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") {
  const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
  await chmod(cli, 0o755);
}

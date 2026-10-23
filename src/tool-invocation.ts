import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Launch Windows npm Node shims without passing model IDs or prompts through cmd.exe. */
export function toolInvocation(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command, args: [...args] };
  const candidates = path.isAbsolute(command) || command.includes("\\") || command.includes("/")
    ? [command] : (env.PATH ?? env.Path ?? process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    const files = path.extname(candidate) ? [candidate] : [candidate + ".exe", candidate + ".com", candidate + ".cmd", candidate];
    for (const file of files) {
      if (!existsSync(file) || !statSync(file).isFile()) continue;
      if (!/\.(?:cmd|bat)$/iu.test(file)) return { command: file, args: [...args] };
      if (statSync(file).size > 64 * 1024) throw new Error("Unsupported Windows tool launcher; install a native executable or standard npm Node shim.");
      const shim = readFileSync(file, "utf8");
      const script = [...shim.matchAll(/"%(?:dp0%|~dp0)[\\/]([^"\r\n]+)"/giu)]
        .map(match => path.resolve(path.dirname(file), match[1]!))
        .find(target => !/node\.exe$/iu.test(target) && existsSync(target) && statSync(target).isFile() && statSync(target).size < 2 * 1024 * 1024 && /^#!.*\bnode\b/u.test(readFileSync(target, "utf8")));
      if (script) return { command: process.execPath, args: [script, ...args] };
      throw new Error("Unsupported Windows tool launcher; install a native executable or standard npm Node shim.");
    }
  }
  return { command, args: [...args] };
}

import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const musl = process.platform === "linux" && !(process.report.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime;
// fs-native-extensions does not ship a musl prebuild. Use our minimal N-API
// binding to the same Linux OFD locking primitive on musl; no runtime compiler.
const binding = (musl ? require(fileURLToPath(new URL("../../dist/musl-lock.node", import.meta.url))) : require("fs-native-extensions")) as {
  tryLock(fd: number): boolean;
  unlock(fd: number): void;
};
export const tryLock = binding.tryLock;
export const unlock = binding.unlock;

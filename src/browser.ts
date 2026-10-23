import { ConfigurationError } from "./errors.js";
import {
  runProcess,
  type ProcessOptions,
  type ProcessResult,
} from "./process.js";

export const KRUTRIM_SIGN_IN_URL = "https://cloud.olakrutrim.com/signIn";

export interface BrowserOpenCommand {
  command: string;
  args: readonly string[];
}

export type BrowserProcessRunner = (
  command: string,
  args: readonly string[],
  options?: ProcessOptions,
) => Promise<ProcessResult>;

export interface OpenKrutrimSignInOptions {
  platform?: NodeJS.Platform;
  run?: BrowserProcessRunner;
}

function assertFixedSignInUrl(): void {
  const url = new URL(KRUTRIM_SIGN_IN_URL);
  if (
    url.protocol !== "https:" ||
    url.origin !== "https://cloud.olakrutrim.com" ||
    url.pathname !== "/signIn" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ConfigurationError("The Krutrim sign-in URL failed its fixed-origin safety check.");
  }
}

export function browserOpenCommand(
  platform: NodeJS.Platform = process.platform,
): BrowserOpenCommand {
  assertFixedSignInUrl();
  if (platform === "darwin") {
    return { command: "open", args: [KRUTRIM_SIGN_IN_URL] };
  }
  if (platform === "linux") {
    return { command: "xdg-open", args: [KRUTRIM_SIGN_IN_URL] };
  }
  if (platform === "win32") {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", "start", "", KRUTRIM_SIGN_IN_URL],
    };
  }
  throw new ConfigurationError(
    `Automatic browser opening is not supported on ${platform}. Open ${KRUTRIM_SIGN_IN_URL} manually.`,
  );
}

export async function openKrutrimSignInPage(
  options: OpenKrutrimSignInOptions = {},
): Promise<void> {
  const launch = browserOpenCommand(options.platform ?? process.platform);
  const runner = options.run ?? runProcess;
  let result: ProcessResult;
  try {
    result = await runner(launch.command, launch.args, {
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024,
    });
  } catch (error) {
    throw new ConfigurationError(
      `Could not open a browser automatically. Open ${KRUTRIM_SIGN_IN_URL} manually.`,
      { cause: error },
    );
  }
  if (result.code !== 0) {
    throw new ConfigurationError(
      `Could not open a browser automatically. Open ${KRUTRIM_SIGN_IN_URL} manually.`,
    );
  }
}

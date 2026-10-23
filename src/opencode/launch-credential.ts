import { timingSafeEqual } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { ConfigurationError } from "../errors.js";
import {
  atomicWriteFile,
  ensurePrivateDirectory,
  removeFileDurably,
  sha256,
} from "../fs/atomic.js";

const BRIDGE_TOKEN_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_CREDENTIAL_BYTES = 256;

export interface OpenCodeLaunchCredentialRecord {
  existed: boolean;
  content: Buffer;
  sha256: string | null;
  mode?: number;
}

function assertBridgeToken(token: string): void {
  if (!BRIDGE_TOKEN_PATTERN.test(token)) {
    throw new ConfigurationError("The OpenCode launch credential is invalid.");
  }
}

export async function readOpenCodeLaunchCredential(
  credentialFile: string,
): Promise<OpenCodeLaunchCredentialRecord> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(credentialFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { existed: false, content: Buffer.alloc(0), sha256: null };
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ConfigurationError(
      `OpenCode launch credential path is not a regular file: ${credentialFile}`,
    );
  }
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new ConfigurationError(
      `OpenCode launch credential is group- or world-accessible: ${credentialFile}`,
    );
  }
  if (info.size > MAX_CREDENTIAL_BYTES) {
    throw new ConfigurationError(
      `OpenCode launch credential is unexpectedly large: ${credentialFile}`,
    );
  }
  const content = await readFile(credentialFile);
  return {
    existed: true,
    content,
    sha256: sha256(content),
    mode: info.mode & 0o777,
  };
}

export async function writeOpenCodeLaunchCredential(
  credentialFile: string,
  token: string,
): Promise<OpenCodeLaunchCredentialRecord> {
  assertBridgeToken(token);
  const previous = await readOpenCodeLaunchCredential(credentialFile);
  await ensurePrivateDirectory(path.dirname(credentialFile));
  await atomicWriteFile(credentialFile, token, {
    mode: 0o600,
    expectedSha256: previous.sha256,
  });
  return previous;
}

export async function restoreOpenCodeLaunchCredential(
  credentialFile: string,
  previous: OpenCodeLaunchCredentialRecord,
): Promise<void> {
  const current = await readOpenCodeLaunchCredential(credentialFile);
  if (!previous.existed) {
    await removeFileDurably(credentialFile);
    return;
  }
  await atomicWriteFile(credentialFile, previous.content, {
    mode: previous.mode ?? 0o600,
    expectedSha256: current.sha256,
  });
}

export async function removeOpenCodeLaunchCredential(
  credentialFile: string,
): Promise<boolean> {
  const current = await readOpenCodeLaunchCredential(credentialFile);
  if (!current.existed) {
    return false;
  }
  await removeFileDurably(credentialFile);
  return true;
}

export async function openCodeLaunchCredentialIsReady(
  credentialFile: string,
): Promise<boolean> {
  try {
    const current = await readOpenCodeLaunchCredential(credentialFile);
    return current.existed && BRIDGE_TOKEN_PATTERN.test(current.content.toString("utf8"));
  } catch {
    return false;
  }
}

export async function openCodeLaunchCredentialMatches(
  credentialFile: string,
  expectedToken: string,
): Promise<boolean> {
  assertBridgeToken(expectedToken);
  try {
    const current = await readOpenCodeLaunchCredential(credentialFile);
    if (!current.existed) {
      return false;
    }
    const expected = Buffer.from(expectedToken, "utf8");
    return current.content.length === expected.length &&
      timingSafeEqual(current.content, expected);
  } catch {
    return false;
  }
}

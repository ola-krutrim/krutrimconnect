import type { CredentialValidationDescription } from "../auth.js";

export type SecretBackend =
  | "macos-keychain"
  | "linux-secret-service"
  | "windows-credential-manager"
  | "restricted-file";

export interface SecretReader {
  read(): Promise<string | null>;
}

export interface SecretStore extends SecretReader {
  readonly backend: SecretBackend;
  readonly isFallback: boolean;
  write(secret: string): Promise<void>;
  delete(): Promise<boolean>;
}

export interface StoredSecretResult {
  backend: SecretBackend;
  usedFallback: boolean;
  keychainFailure?: string;
  removedStaleBackends: SecretBackend[];
  cleanupFailures: SecretBackend[];
  validation: CredentialValidationDescription;
}

export interface RemovedSecretResult {
  changed: boolean;
  removedBackends: SecretBackend[];
  missingBackends: SecretBackend[];
  removedBackendRecord: boolean;
}

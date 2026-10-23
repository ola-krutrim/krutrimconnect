export class KrutrimConnectError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "KrutrimConnectError";
    this.code = code;
  }
}

export class CapabilityError extends KrutrimConnectError {
  constructor(message: string) {
    super("CAPABILITY_UNVERIFIED", message);
    this.name = "CapabilityError";
  }
}

export class ConfigurationError extends KrutrimConnectError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFIGURATION_ERROR", message, options);
    this.name = "ConfigurationError";
  }
}

export class SecretStoreError extends KrutrimConnectError {
  constructor(message: string, options?: ErrorOptions) {
    super("SECRET_STORE_ERROR", message, options);
    this.name = "SecretStoreError";
  }
}

export class InferenceError extends KrutrimConnectError {
  constructor(message: string, options?: ErrorOptions) {
    super("INFERENCE_ERROR", message, options);
    this.name = "InferenceError";
  }
}

export class AtomicWriteError extends KrutrimConnectError {
  readonly committed: boolean;

  constructor(message: string, committed: boolean, options?: ErrorOptions) {
    super("ATOMIC_WRITE_ERROR", message, options);
    this.name = "AtomicWriteError";
    this.committed = committed;
  }
}

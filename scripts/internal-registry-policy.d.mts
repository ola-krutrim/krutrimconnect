export interface InternalPackageJson {
  name?: string;
  version?: string;
  publishConfig?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InternalPublishContext {
  packageJson: InternalPackageJson;
  confirmation?: string;
  actions?: string;
  eventName?: string;
  repository?: string;
  repositoryPrivate?: string;
  ref?: string;
}

export const INTERNAL_PACKAGE_NAME: "@ola-silicon/krutrimconnect";
export const INTERNAL_REGISTRY: "https://npm.pkg.github.com/";
export const INTERNAL_TAG: "internal";

export function expectedInternalConfirmation(version: string): string;
export function assertInternalPublishContext(input: InternalPublishContext): void;
export function prepareInternalPackageJson(packageJson: InternalPackageJson): InternalPackageJson;

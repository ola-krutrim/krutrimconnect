export const INTERNAL_PACKAGE_NAME = "@ola-silicon/krutrimconnect";
export const INTERNAL_REGISTRY = "https://npm.pkg.github.com/";
export const INTERNAL_TAG = "internal";

const SOURCE_PACKAGE_NAME = "krutrimconnect";
const EXPECTED_REPOSITORY = "ola-silicon/Krutrim_Connect";
const EXPECTED_REF = "refs/heads/internal";
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-next\.\d+)?$/u;

export function expectedInternalConfirmation(version) {
  return `publish ${INTERNAL_PACKAGE_NAME}@${version} as ${INTERNAL_TAG}`;
}

export function assertInternalPublishContext({
  packageJson,
  confirmation,
  actions,
  eventName,
  repository,
  repositoryPrivate,
  ref,
}) {
  if (!packageJson || packageJson.name !== SOURCE_PACKAGE_NAME) {
    throw new Error(`Internal publication requires source package ${SOURCE_PACKAGE_NAME}.`);
  }
  if (
    typeof packageJson.version !== "string" ||
    !RELEASE_VERSION_PATTERN.test(packageJson.version)
  ) {
    throw new Error("Internal publication requires an X.Y.Z or X.Y.Z-next.N version.");
  }
  if (actions !== "true" || eventName !== "workflow_dispatch") {
    throw new Error("Internal publication only runs from a manually dispatched GitHub Action.");
  }
  if (repository !== EXPECTED_REPOSITORY || ref !== EXPECTED_REF) {
    throw new Error(`Internal publication is restricted to ${EXPECTED_REPOSITORY} internal.`);
  }
  if (repositoryPrivate !== "true") {
    throw new Error("Internal publication requires explicitly confirmed private repository visibility.");
  }
  const expected = expectedInternalConfirmation(packageJson.version);
  if (confirmation !== expected) {
    throw new Error(`Confirmation must exactly equal: ${expected}`);
  }
}

export function prepareInternalPackageJson(packageJson) {
  if (!packageJson || packageJson.name !== SOURCE_PACKAGE_NAME) {
    throw new Error(`Expected source package ${SOURCE_PACKAGE_NAME}.`);
  }
  if (
    typeof packageJson.version !== "string" ||
    !RELEASE_VERSION_PATTERN.test(packageJson.version)
  ) {
    throw new Error("Internal package requires an X.Y.Z or X.Y.Z-next.N version.");
  }
  return {
    ...packageJson,
    name: INTERNAL_PACKAGE_NAME,
    publishConfig: {
      registry: INTERNAL_REGISTRY,
      access: "restricted",
      provenance: false,
      tag: INTERNAL_TAG,
    },
  };
}

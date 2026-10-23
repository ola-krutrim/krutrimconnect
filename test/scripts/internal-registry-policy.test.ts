import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  assertInternalPublishContext,
  expectedInternalConfirmation,
  INTERNAL_PACKAGE_NAME,
  INTERNAL_REGISTRY,
  type InternalPublishContext,
  prepareInternalPackageJson,
} from "../../scripts/internal-registry-policy.mjs";

const sourcePackage = {
  name: "krutrimconnect",
  version: "0.1.0",
  bin: { krutrimconnect: "dist/cli.js" },
  publishConfig: { access: "public", provenance: true },
};

function passingContext() {
  return {
    packageJson: sourcePackage,
    confirmation: "publish @ola-silicon/krutrimconnect@0.1.0 as internal",
    actions: "true",
    eventName: "workflow_dispatch",
    repository: "ola-silicon/Krutrim_Connect",
    repositoryPrivate: "true",
    ref: "refs/heads/internal",
  };
}

describe("internal registry policy", () => {
  it("declares workflow visibility in the public policy type", () => {
    const context: InternalPublishContext = { ...passingContext(), repositoryPrivate: "true" };
    expect(() => assertInternalPublishContext(context)).not.toThrow();
  });

  it.each(["false", "", undefined, "TRUE", "1", true, false])(
    "rejects missing or non-explicit private visibility %s", (repositoryPrivate) => {
      // Deliberately exercise malformed runtime input outside the typed API.
      const context = { ...passingContext(), repositoryPrivate } as unknown as InternalPublishContext;
      expect(() => assertInternalPublishContext(context)).toThrow(/private/u);
    },
  );

  it.each(["true", "false", undefined])(
    "uses explicitly supplied workflow visibility in the runtime guard: %s", (visibility) => {
      const version = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
      const result = spawnSync(process.execPath, ["scripts/internal-registry.mjs", "guard"], {
        cwd: new URL("../../", import.meta.url),
        encoding: "utf8",
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_EVENT_NAME: "workflow_dispatch",
          GITHUB_REPOSITORY: "ola-silicon/Krutrim_Connect",
          GITHUB_REF: "refs/heads/internal",
          INTERNAL_PUBLISH_CONFIRMATION: expectedInternalConfirmation(version),
          ...(visibility === undefined ? {} : { INTERNAL_REPOSITORY_PRIVATE: visibility }),
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(visibility === "true" ? 0 : 1);
      if (visibility !== "true") expect(result.stderr).toMatch(/private/u);
    },
  );

  it("requires the exact scoped-package confirmation", () => {
    expect(expectedInternalConfirmation(sourcePackage.version))
      .toBe("publish @ola-silicon/krutrimconnect@0.1.0 as internal");
    expect(() => assertInternalPublishContext(passingContext())).not.toThrow();
    expect(() => assertInternalPublishContext({
      ...passingContext(),
      confirmation: "publish",
    })).toThrow(/exactly equal/u);
  });

  it.each(["refs/heads/main", "refs/heads/feature", "refs/tags/internal", undefined])(
    "rejects publication from ref %s", (ref) => {
      const { ref: _ref, ...context } = passingContext();
      expect(() => assertInternalPublishContext({
        ...context, ...(ref === undefined ? {} : { ref }),
      })).toThrow(/restricted/u);
    },
  );

  it("only permits a manual internal-branch Action in the expected repository", () => {
    expect(() => assertInternalPublishContext({
      ...passingContext(),
      repository: "someone/Krutrim_Connect",
    })).toThrow(/restricted/u);
    expect(() => assertInternalPublishContext({
      ...passingContext(),
      eventName: "push",
    })).toThrow(/manually dispatched/u);
  });

  it("accepts stable and next versions but rejects unsupported prereleases", () => {
    expect(() => assertInternalPublishContext(passingContext())).not.toThrow();
    expect(() => assertInternalPublishContext({
      ...passingContext(),
      packageJson: { ...sourcePackage, version: "0.1.0-next.8" },
      confirmation: "publish @ola-silicon/krutrimconnect@0.1.0-next.8 as internal",
    })).not.toThrow();
    expect(() => assertInternalPublishContext({
      ...passingContext(),
      packageJson: { ...sourcePackage, version: "0.1.0-beta.1" },
    })).toThrow(/X\.Y\.Z or X\.Y\.Z-next\.N/u);
  });

  it("prepares a scoped private package without changing its CLI binary", () => {
    const prepared = prepareInternalPackageJson(sourcePackage);
    expect(prepared.name).toBe(INTERNAL_PACKAGE_NAME);
    expect(prepared.version).toBe(sourcePackage.version);
    expect(prepared.bin).toEqual(sourcePackage.bin);
    expect(prepared.publishConfig).toEqual({
      registry: INTERNAL_REGISTRY,
      access: "restricted",
      provenance: false,
      tag: "internal",
    });
    expect(sourcePackage.name).toBe("krutrimconnect");
  });
});

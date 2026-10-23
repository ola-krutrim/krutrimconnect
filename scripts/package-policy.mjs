export const REQUIRED_PACKAGE_PATHS = [
  "package.json",
  "README.md",
  "SECURITY.md",
  "LICENSE",
  "NOTICE",
  "licenses/MIT-legacy.txt",
  "docs/legal/PRIVACY_POLICY.md",
  "docs/legal/TERMS_AND_CONDITIONS.md",
  "docs/legal/LICENSE_SCOPE.md",
  "dist/cli.js",
  "dist/version.js",
  "schemas/README.md",
  "schemas/codex-config.schema.json",
  "docs/user-guide.md",
  "docs/legal/USER_NOTICES.md",
];

export function assertPackedManifest(packed) {
  if (!packed || !Array.isArray(packed.files) || typeof packed.filename !== "string") {
    throw new Error("npm pack returned an invalid manifest.");
  }

  const paths = new Set(packed.files.map((entry) => entry.path));
  for (const required of REQUIRED_PACKAGE_PATHS) {
    if (!paths.has(required)) {
      throw new Error("The npm artifact is missing " + required + ".");
    }
  }
  for (const entry of paths) {
    if (
      entry.startsWith("docs/hld/") ||
      /^docs\/phase-/u.test(entry) ||
      /(?:roadmap|RELEASE_REVIEW|POC-Architecture)/u.test(entry) ||
      entry.startsWith("src/") ||
      entry.startsWith("test/") ||
      entry === ".env" ||
      entry.startsWith(".env.")
    ) {
      throw new Error("The npm artifact contains forbidden release content: " + entry);
    }
  }
}

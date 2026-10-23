import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "release/**"],
    environment: "node",
    coverage: {
      reporter: ["text", "html"],
    },
  },
});

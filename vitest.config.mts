import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));
const serverOnlyStub = fileURLToPath(
  new URL("./src/test/server-only-stub.ts", import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: [
      // 'server-only' throws outside the react-server condition; tests run in plain node.
      { find: /^server-only$/, replacement: serverOnlyStub },
      { find: /^@\//, replacement: `${src}/` },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test/setup.ts"],
    pool: "forks",
  },
});

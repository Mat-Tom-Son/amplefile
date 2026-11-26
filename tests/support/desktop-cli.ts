import { fileURLToPath } from "node:url";

// The Linux native suite builds the current Rust client before running these tests.
export const testCli = process.platform === "darwin"
  ? fileURLToPath(new URL("../../desktop/cli/amplefile", import.meta.url))
  : process.platform === "linux" ? process.env.AMPLEFILE_TEST_LINUX_CLI : undefined;

export const desktopCliTest = { skip: testCli ? false : "Requires the Mac shim or a freshly built Linux CLI" };

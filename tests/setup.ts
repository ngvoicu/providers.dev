import { afterAll } from "vitest";
import { removeTempDataDirs } from "./helpers.ts";

// Runs once per test file, after its last test and whether or not they passed. A file that builds many datasets
// (tests/pi-fence.test.ts) leaves many folders: removing them took longer than vitest's 10 s hook limit on a runner.
afterAll(removeTempDataDirs, 120_000);

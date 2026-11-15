import { afterAll } from "vitest";
import { removeTempDataDirs } from "./helpers.ts";

// Runs once per test file, after its last test and whether or not they passed.
afterAll(removeTempDataDirs);

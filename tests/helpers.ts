import Database from "better-sqlite3";
import { demoSeed } from "../src/lib/demo-data";
import type { DemoSeed } from "../src/lib/contracts";
import { createStore } from "../src/lib/store";

export function createTestStore(seed: DemoSeed = demoSeed) {
  const store = createStore(new Database(":memory:"));
  store.seed(seed);
  return store;
}

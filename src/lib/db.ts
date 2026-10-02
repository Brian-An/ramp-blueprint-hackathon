import "server-only";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { demoSeed } from "./demo-data";
import { createStore } from "./store";

const connection = globalThis as typeof globalThis & { invoiceStore?: ReturnType<typeof createStore> };

export function getStore(): ReturnType<typeof createStore> {
  if (!connection.invoiceStore) {
    const path = process.env.DATABASE_PATH ?? resolve(process.cwd(), ".data/demo.sqlite");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    const store = createStore(new Database(path));
    try { store.seed(demoSeed); }
    catch (error) { store.close(); throw error; }
    connection.invoiceStore = store;
  }
  return connection.invoiceStore;
}

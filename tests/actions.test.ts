import { afterEach, expect, it, vi } from "vitest";
import { createTestStore } from "./helpers";
import { POST } from "../src/app/api/actions/[id]/route";
vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: undefined as ReturnType<typeof createTestStore> | undefined }));
vi.mock("../src/lib/db", () => ({ getStore: () => state.store }));
afterEach(() => state.store?.close());
it("protects action writes and maps input and state errors", async () => {
  state.store = createTestStore();
  const request = (body: unknown, origin = "http://localhost") => new Request("http://localhost/api/actions/missing", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });
  const context = { params: Promise.resolve({ id: "missing" }) };
  const command = { operation: "approve", generationId: state.store.getSettings().generationId, expectedVersion: 1 };
  expect((await POST(request(command, "https://foreign.example"), context)).status).toBe(400);
  expect((await POST(request({}), context)).status).toBe(400);
  expect((await POST(request(command), context)).status).toBe(404);
  const response = await POST(request({ ...command, generationId: "old" }), context);
  expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: "STALE_CONTEXT", runId: expect.any(String) } });
  expect(state.store.snapshot().outbox).toEqual([]);
});

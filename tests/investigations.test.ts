import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestStore } from "./helpers";
import { demoSeed } from "../src/lib/demo-data";
import { poProposal } from "./fixtures/model";
import { createLiveTransport } from "../src/lib/agent/model";
import { investigateInvoice } from "../src/lib/agent/run";
import { POST } from "../src/app/api/investigations/route";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ store: undefined as ReturnType<typeof createTestStore> | undefined }));
vi.mock("../src/lib/db", () => ({ getStore: () => state.store }));
const stores: ReturnType<typeof createTestStore>[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function store() { const value = createTestStore(); stores.push(value); state.store = value; return value; }
function request(body: unknown, origin = "http://127.0.0.1:3000") {
  return new Request("http://127.0.0.1:3000/api/investigations", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
}
function providerResponse(output: unknown[], status = "completed") {
  return Response.json({ id: "resp_test", object: "response", created_at: 1790880000, status, error: null, incomplete_details: null, model: "gpt-6-astra", output, parallel_tool_calls: true, tools: [], tool_choice: "auto", usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } });
}
function resultOutput(text: string) { return [{ type: "message", id: "msg_final", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] }]; }
function configured() { vi.stubEnv("OPENAI_API_KEY", "test-key"); vi.stubEnv("OPENAI_MODEL", "gpt-6-astra"); vi.stubEnv("AGENT_MODE", "live"); }

describe("Responses SDK boundary", () => {
  it("preserves reasoning items and call IDs with strict schemas, capped output and no retries", async () => {
    configured(); const db = store(); let turn = 0;
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.max_output_tokens).toBe(4000);
      expect(body.store).toBe(false);
      expect(body.include).toEqual(["reasoning.encrypted_content"]);
      expect(body.text.format.strict).toBe(true);
      expect(body.tools.every((tool: { strict: boolean }) => tool.strict)).toBe(true);
      if (turn++ === 0) return providerResponse([
        { type: "reasoning", id: "reason_1", summary: [], encrypted_content: "opaque" },
        { type: "function_call", id: "fc_1", call_id: "call_thread", name: "get_email_thread", arguments: JSON.stringify({ threadId: "THREAD-101" }), status: "completed" },
      ]);
      expect(body.input).toContainEqual({ type: "reasoning", id: "reason_1", summary: [], encrypted_content: "opaque" });
      expect(body.input).toContainEqual(expect.objectContaining({ type: "function_call_output", call_id: "call_thread" }));
      return providerResponse(resultOutput(JSON.stringify(poProposal)));
    });
    expect(await investigateInvoice(db, "INV-101", createLiveTransport())).toEqual(poProposal);
  });
  it.each([
    ["MODEL_REFUSED", [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: "Cannot comply" }] }], "completed"],
    ["MODEL_INCOMPLETE", [], "incomplete"],
    ["INVALID_PROPOSAL", resultOutput("not JSON"), "completed"],
    ["INVALID_TOOL_ARGUMENTS", [{ type: "function_call", id: "fc_1", call_id: "c1", name: "get_invoice", arguments: "{", status: "completed" }], "completed"],
  ])("rejects provider %s without effects", async (code, output, status) => {
    configured(); const db = store(); vi.stubGlobal("fetch", async () => providerResponse(output, status));
    await expect(investigateInvoice(db, "INV-101", createLiveTransport())).rejects.toThrow(code);
    expect(db.snapshot().actions).toEqual([]);
  });
  it("does not retry provider failures or expose provider details", async () => {
    configured(); const db = store(); let requests = 0;
    vi.stubGlobal("fetch", async () => { requests++; return Response.json({ error: { message: "secret provider details", type: "server_error" } }, { status: 500 }); });
    await expect(investigateInvoice(db, "INV-101", createLiveTransport())).rejects.toThrow(/^MODEL_FAILED$/);
    expect(requests).toBe(1);
  });
});

describe("investigation HTTP boundary", () => {
  it("persists fixture proposals once and reuses the unchanged result", async () => {
    vi.stubEnv("AGENT_MODE", "fixture"); const db = store(); const body = { invoiceId: "INV-101", generationId: db.getSettings().generationId, contextVersion: 1 };
    const first = await POST(request(body)); expect(first.status).toBe(200);
    const value = await first.json(); expect(value.action.status).toBe("pending");
    expect(await (await POST(request(body))).json()).toEqual(value);
    expect(db.snapshot().investigations).toHaveLength(1); expect(db.snapshot().actions).toHaveLength(1); expect(db.snapshot().outbox).toEqual([]);
  });
  it("uses a future wait fixture for INV-105 and a corrected-invoice task after Acme supplies the PO", async () => {
    vi.stubEnv("AGENT_MODE", "fixture"); const db = store();
    const response = await POST(request({ invoiceId: "INV-105", generationId: db.getSettings().generationId, contextVersion: 1 }));
    expect(await response.json()).toMatchObject({ proposal: { blocker: "promised_payment", action: { kind: "wait", followUpDate: "2026-10-05" } } });
    const reply = demoSeed.events.find(event => event.id === "REPLY-101-PO");
    if (!reply) throw new Error("Fixture reply missing");
    const withReply = createTestStore({ ...demoSeed, emails: [...demoSeed.emails, reply.email] }); stores.push(withReply); state.store = withReply;
    const corrected = await POST(request({ invoiceId: "INV-101", generationId: withReply.getSettings().generationId, contextVersion: 1 }));
    expect(await corrected.json()).toMatchObject({ proposal: { action: { kind: "owner_task", task: "Add PO 4821 to INV-101 and submit the corrected invoice." }, evidence: [{ emailId: "EMAIL-101-PO" }] } });
  });
  it.each([
    [{}, 400],
    [{ invoiceId: "missing", generationId: "generation", contextVersion: 1 }, 404],
    [{ invoiceId: "INV-101", generationId: "stale", contextVersion: 1 }, 409],
  ])("maps invalid input and scope %#", async (body, expected) => {
    store(); expect((await POST(request(body))).status).toBe(expected);
  });
  it("rejects cross-origin requests before mutating records", async () => {
    const db = store(); expect((await POST(request({ invoiceId: "INV-101", generationId: db.getSettings().generationId, contextVersion: 1 }, "https://untrusted.example"))).status).toBe(400);
    expect(db.snapshot().investigations).toEqual([]);
  });
  it("reports missing live credentials safely and keeps browsing available", async () => {
    vi.stubEnv("OPENAI_API_KEY", ""); vi.stubEnv("AGENT_MODE", "live"); const db = store();
    const response = await POST(request({ invoiceId: "INV-101", generationId: db.getSettings().generationId, contextVersion: 1 }));
    expect(response.status).toBe(503); expect(await response.json()).toMatchObject({ error: { code: "MODEL_NOT_CONFIGURED" } }); expect(db.snapshot().agentReady).toBe(false);
  });
  it("rejects concurrent requests and releases the lock after failure", async () => {
    configured(); const db = store(); const body = { invoiceId: "INV-101", generationId: db.getSettings().generationId, contextVersion: 1 };
    let release: (() => void) | undefined;
    vi.stubGlobal("fetch", async () => { await new Promise<void>(resolve => { release = resolve; }); return Response.json({ error: { message: "secret details", type: "server_error" } }, { status: 500 }); });
    const pending = POST(request(body));
    await vi.waitFor(() => expect(release).toBeDefined());
    expect((await POST(request(body))).status).toBe(409);
    release?.(); const response = await pending; expect(response.status).toBe(502);
    expect(JSON.stringify(await response.json())).not.toContain("secret details");
    vi.stubEnv("AGENT_MODE", "fixture"); expect((await POST(request(body))).status).toBe(200);
  });
  it("maps caller cancellation to 504 and releases the lock", async () => {
    configured(); const db = store(); const body = { invoiceId: "INV-101", generationId: db.getSettings().generationId, contextVersion: 1 };
    const controller = new AbortController(); controller.abort();
    const input = request(body); const cancelled = new Request(input, { signal: controller.signal });
    expect((await POST(cancelled)).status).toBe(504);
    vi.stubEnv("AGENT_MODE", "fixture"); expect((await POST(request(body))).status).toBe(200);
  });
});

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { RunError, type RunErrorCode } from "./agent/errors";

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}

export function assertSameOriginJson(request: Request): void {
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if ((origin && origin !== new URL(request.url).origin) || (site && site !== "same-origin" && site !== "none")) throw new HttpError(400, "INVALID_REQUEST", "Use this workspace to submit changes.");
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") throw new HttpError(400, "INVALID_REQUEST", "Send a JSON request.");
}

const runMessages: Record<RunErrorCode, [number, string]> = {
  INVOICE_NOT_FOUND: [404, "The invoice is unavailable."],
  MODEL_NOT_CONFIGURED: [503, "Add OPENAI_API_KEY to the server .env file and restart to enable Live AI. Invoice browsing and demo controls remain available."],
  STALE_CONTEXT: [409, "Invoice data changed. Refresh the workspace and investigate again."],
  IN_FLIGHT: [409, "An investigation is already running for this invoice."],
  TIMEOUT: [504, "The investigation exceeded its time budget or was cancelled. Try again."],
  MODEL_FAILED: [502, "The AI service could not complete the investigation. Try again."],
  MODEL_REFUSED: [502, "The AI service declined this investigation."],
  MODEL_INCOMPLETE: [502, "The AI service returned an incomplete investigation. Try again."],
  INVALID_PROPOSAL: [502, "The AI service returned an invalid proposal. Try again."],
  INVALID_EVIDENCE: [502, "The AI conclusion could not be verified against its sources. Try again."],
  INVALID_TOOL_ARGUMENTS: [502, "The AI service requested an invalid read. Try again."],
  RUN_LIMIT: [502, "The investigation reached its read limit. Try again."],
};
export function errorResponse(error: unknown): Response {
  const runId = randomUUID();
  let status = 500; let code = "INTERNAL_ERROR"; let message = "The request could not be completed.";
  if (error instanceof RunError) { code = error.code; [status, message] = runMessages[error.code]; }
  else if (error instanceof HttpError) { status = error.status; code = error.code; message = error.message; }
  else if (error instanceof z.ZodError || error instanceof SyntaxError) { status = 400; code = "INVALID_REQUEST"; message = "The request is invalid."; }
  // Record only diagnostic IDs and typed codes, never credentials, prompts, or provider errors.
  if (status >= 500) console.error("invoice_request_failed", { runId, code });
  return Response.json({ error: { code, message, runId } }, { status, headers: { "Cache-Control": "no-store" } });
}

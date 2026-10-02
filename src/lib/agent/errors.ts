export type RunErrorCode = "INVOICE_NOT_FOUND" | "MODEL_NOT_CONFIGURED" | "MODEL_FAILED" | "MODEL_REFUSED" | "MODEL_INCOMPLETE" | "INVALID_PROPOSAL" | "INVALID_EVIDENCE" | "INVALID_TOOL_ARGUMENTS" | "RUN_LIMIT" | "TIMEOUT" | "STALE_CONTEXT" | "IN_FLIGHT";
export class RunError extends Error {
  constructor(public readonly code: RunErrorCode) {
    super(code);
    this.name = "RunError";
  }
}

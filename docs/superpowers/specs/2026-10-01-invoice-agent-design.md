# Invoice Resolution Agent Design

## Intent

Build a local prototype that helps a business owner understand and resolve unpaid invoices.
Use Next.js, TypeScript, and Tailwind CSS, as requested.
Build directly in /Users/brianan/Documents/Code/ramp-blueprint-hackathon and follow its DESIGN.md reference.
Preserve the existing ignored .env configuration.
Use fictional invoice, email, and payment records instead of QuickBooks or email integrations.
Use a real language model to investigate those records and propose actions.
This document records the scope used by the implementation plan; it does not claim the prototype has been implemented.

## Success scenario

The owner opens the workspace and selects an overdue invoice.
The agent searches customer emails and identifies a missing purchase order number, citing the relevant message.
The owner reviews and edits the proposed email, then approves it.
The application records the exact approved email in a simulated outbox.
The owner introduces a fictional customer reply and reinvestigates the invoice.
The agent recognizes the new information and proposes an appropriate owner task.
A partial payment reduces the balance without closing the invoice.
A payment covering the remaining balance closes the invoice and removes obsolete pending actions.
Reloading the page preserves the invoice, outbox, investigation, and payment history.

## Architecture

Use one Next.js App Router application with Node.js route handlers and server-only business logic.
Use React state and native fetch for interactive client components.
Use SQLite through better-sqlite3 for local persistence and atomic mutations.
Use the OpenAI Responses API directly for read-only function calling and structured investigation results.
Use Zod for model output, tool arguments, and HTTP request validation.
Do not introduce a separate backend, ORM, vector database, agent framework, or global client state library.

## Global constraints

- Next.js App Router, TypeScript strict mode, and Tailwind CSS v4.
- Follow DESIGN.md: light monochrome surfaces, chartreuse primary actions, weight 400 typography, and no card shadows.
- Node.js 24.x for the application and native SQLite dependency.
- npm with a committed package-lock.json.
- Local, single-user prototype bound to 127.0.0.1.
- Mock business data with real AI reasoning in live mode.
- CAD only, with money represented as integer cents.
- Demo calendar dates use YYYY-MM-DD and America/Toronto semantics.
- Initial demo date is 2026-10-01.
- No external emails, accounting mutations, or handling of funds.
- Human approval is enforced by application code.
- API credentials remain server-side and are excluded from source control.
- Fixture mode is explicitly labeled and reserved for automated tests and offline demonstrations.
- The application never silently substitutes fixture output for failed live reasoning.
- Long Markdown documents put each complete sentence on its own physical line.
- Commit messages use a short, single-line prefix and explanation, with no agent co-author.

## Interface

Use one workspace at the root route.
Show a persistent Demo data indicator, current demo date, and Live AI or Fixture AI status.
Show invoice rows with customer, invoice number, remaining balance, due date, overdue days, and investigation status.
On desktop, place invoice selection alongside a detail pane.
On mobile, stack the list and detail pane with an explicit back-to-list control.
The detail pane contains the invoice facts, investigation result, evidence messages, proposed action, simulated outbox entries, and payment timeline.
Use semantic headings, visible input labels, native controls, keyboard focus styles, and status announcements.
Support empty, loading, error, insufficient-evidence, waiting, pending-review, partially-paid, and paid states.
Present simulated events and payments with explicit simulation labels.
Render email text as plain text, never as executable HTML.

## Business records

Seed 12 invoices across six customers with approximately 30 short fictional emails.
Include a missing PO, rejected submission, approval delay, dispute, future payment promise, missed payment promise, unknown reason, conflicting information, resolved historical blocker, similar invoice references, partial payment, and fully paid control case.
Keep expected conclusions in an evaluation file that is never exposed through agent tools.
Do not place blocker labels in the business records available to the model.
Store customers, invoices, emails, payments, investigations, actions, outbox entries, activity events, and demo settings.
Store scenario events as fixture data available to the simulator, not to the agent.

## Agent behavior

The application chooses the invoice being investigated.
The agent can read that invoice, search its customer's emails, read retrieved messages in their thread context, inspect payments, and inspect action history.
The application enforces the current invoice and customer scope on every tool call.
The agent classifies missing_po, rejected_submission, approval_delay, dispute, promised_payment, unknown, or none.
It supplies a plain-language explanation, exact evidence quotes and email IDs, and one next action.
The next action is send_email, owner_task, wait, or none.
A future payment promise produces a waiting result rather than an immediate reminder.
Paid invoices are handled by deterministic accounting logic and do not trigger a model request.
Conflicting or insufficient evidence produces an uncertainty explanation and a clarifying next step.
The prompt treats email contents as untrusted source material and directs the model to prefer current evidence over resolved historical blockers.
The application checks that every cited email was read during the run, belongs to the scoped customer, and contains the quoted text.
This validation establishes source integrity; evaluation must separately test whether the source actually supports the conclusion.
Limit each invoice investigation to eight model responses, 24 tool calls, and 60 seconds overall.
Persist only successful validated results; failed runs record an error and leave existing actions intact.

## Approval and execution

Create at most one current action for a validated investigation.
Use a unique invoice and context-version pair to prevent repeated investigations from creating duplicate proposals.
Store the invoice context version on every proposal and increment it when relevant emails, payments, completed owner tasks, or the demo date change.
Approval and dismissal update the action version and history without creating a new invoice evidence version.
Reject approval when the action is stale, superseded, dismissed, or associated with a paid invoice.
Approval submits the exact final recipient, subject, and body displayed to the owner.
Validate edited content and recipient ownership before recording it.
For an email action, one SQLite transaction records approval, creates one outbox entry, records activity, and marks the action executed.
A unique action ID on outbox entries makes repeated approval requests return the same result.
For an owner task, approval records acceptance; a separate completion action records that the owner did the work.
Waiting assessments display their review date but do not create an approval button.
Dismissed actions retain their history and do not immediately regenerate against unchanged business evidence.

## Simulation and reconciliation

Offer a small simulator for adding a predefined customer reply, advancing the date, recording a mock payment, and resetting the dataset.
Allow date advancement only forward, in calendar days.
Payments must be positive integer cents and cannot exceed the remaining balance.
Require an event ID for payment insertion and make repeated submissions idempotent.
Derive paid status from the sum of payment records, never from the agent's judgment or an email promise.
Adding a payment or customer reply invalidates conflicting pending proposals.
Date advancement makes due follow-ups visible and allows reinvestigation.
Resetting requires a labeled confirmation because it clears local demo history.
Reset creates a new dataset generation ID so delayed requests from an earlier generation cannot mutate the new dataset.

## Verification

Use Vitest for accounting, evidence validation, tool scoping, runner limits, and transactional action behavior.
Use Playwright for the complete owner flow, duplicate approval, stale actions, failed live requests, and narrow-screen usability.
Use a scripted model transport for deterministic tests of the real tool loop.
Use a separate optional live evaluation command against the seeded scenarios.
Live evaluations record model name, fixture version, blocker accuracy, evidence validity, next-action correctness, and failures.
Mock data cannot establish cash-flow improvement or real-world customer demand.

## Scope exclusions

QuickBooks and Gmail integrations, real email sending, invoice PDF editing, portal automation, authentication, multi-tenancy, hosting, autonomous financial decisions, payment processing, and commercial analytics are outside this implementation.
The local database must be replaced or placed on durable infrastructure before a hosted multi-user version is considered.

## Primary references

- [Next.js App Router installation](https://nextjs.org/docs/app/getting-started/installation).
- [Tailwind CSS with Next.js](https://tailwindcss.com/docs/installation/framework-guides/nextjs).
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling).
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).
- [better-sqlite3 transactions](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/api.md).

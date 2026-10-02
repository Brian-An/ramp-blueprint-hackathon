import { expect, test } from "@playwright/test";

test("reviews evidence, edits and approves one durable simulated email", async ({ page, request }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open invoice INV-101", exact: true }).click();
  await page.getByRole("button", { name: "Investigate invoice", exact: true }).click();
  await page.getByText("Source email", { exact: false }).first().click();
  await expect(page.getByText("We need your PO number before we can process INV-101.", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Email body", exact: true }).fill("Please send the PO for INV-101.\nReviewed by the owner.");
  await page.getByRole("button", { name: "Approve simulated email", exact: true }).click();
  const outbox = page.getByRole("region", { name: "Simulated outbox" });
  await expect(outbox).toContainText("Reviewed by the owner.");
  await page.reload();
  await expect(outbox).toContainText("Reviewed by the owner.");
  const snapshot = await (await request.get("/api/workspace")).json();
  expect(snapshot.outbox.filter((entry: { body: string }) => entry.body.includes("Reviewed by the owner."))).toHaveLength(1);
});

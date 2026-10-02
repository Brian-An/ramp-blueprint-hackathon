import { expect, test } from "@playwright/test";

// Reload catches client-only balances and accidental dataset recreation.
test("preserves partial and paid invoices across a browser reload", async ({ page, request }) => {
  const before = await (await request.get("/api/workspace")).json();
  await page.goto("/");
  await expect(page.getByText("Demo data", { exact: true })).toBeVisible();
  await expect(page.getByText("Fixture AI", { exact: true })).toBeVisible();
  const partial = page.getByRole("row").filter({ hasText: "INV-111" });
  await expect(partial).toContainText("$4,000.00");
  await expect(partial).toContainText("Partially paid");
  await expect(page.getByRole("row").filter({ hasText: "INV-112" })).toContainText("Paid");
  await page.reload();
  await expect(partial).toContainText("$4,000.00");
  const after = await (await request.get("/api/workspace")).json();
  expect(after.generationId).toBe(before.generationId);
  expect(after.invoices).toHaveLength(12);
  expect(after.payments).toHaveLength(2);
});

test("keeps the invoice list usable at a narrow screen width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Invoice workspace" })).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "INV-111" })).toContainText("$4,000.00");
  await expect(page.getByRole("row").filter({ hasText: "INV-101" }).getByText("$6,000.00", { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

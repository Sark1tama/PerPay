import { test, expect, record } from "./fixtures";
for (const theme of ["light", "dark"] as const) test(`${theme}: checkout status uses semantic badges with a single heading`, async ({ page, manifest }, info) => {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [scenario, title, variant] of [["open", "支付宝付款", "secondary"], ["fullEvidence", "收款已确认", "success"], ["disputed", "付款待核实", "destructive"], ["expired", "订单已过期", "secondary"], ["closed", "订单已关闭", "secondary"]]) {
    expect(manifest.checkouts[scenario!], `missing generated ${scenario} fixture`).toBeTruthy();
    await page.goto(manifest.origin + manifest.checkouts[scenario!]!);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title!);
    await expect(page.locator('[data-checkout-payment] [data-slot="badge"]').first()).toHaveAttribute("data-variant", variant!);
    if (scenario !== "open") {
      await expect(page.locator("[data-qr-image]")).toHaveCount(0);
      await expect(page.locator("[data-checkout-mobile-guide], [data-checkout-desktop-guide]")).toHaveCount(0);
    } else {
      const guide = page.locator("[data-checkout-mobile-guide]");
      await expect(guide).toBeVisible();
      await expect(guide.locator("strong")).toHaveText("精确金额");
      await expect(guide).toContainText("不要四舍五入");
    }
    await record(page, info, { scenario, variant });
  }
});

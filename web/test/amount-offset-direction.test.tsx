import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { SitePolicyFields } from "../src/components/SitePolicyFields";
import { mergeSitePolicy } from "../src/lib/site-configuration";
import type { SitePolicy } from "../src/api/client";

const policy: SitePolicy = {
  orders: { order_ttl_seconds: 300, amount_offset_maximum_cents: 99, amount_reuse_cooldown_seconds: 600, pending_order_limit: null },
  display: { checkout_name: "test", checkout_help_url: null, checkout_show_product_name: true },
  notification_delivery: { timeout_milliseconds: 5000, maximum_attempts: 3, retry_base_seconds: 5, retry_maximum_seconds: 60 },
};
function Editor({ section }: { section?: string | undefined }) {
  const [value, setValue] = useState(structuredClone(policy));
  return <><SitePolicyFields value={value} onChange={setValue} section={section} /><output aria-label="saved direction">{value.orders.amount_offset_direction ?? "UP"}</output></>;
}
describe("amount adjustment direction", () => {
  for (const section of [undefined, "orders"]) {
    it(`edits direction in ${section ?? "defaults"} with an upward default`, async () => {
      const user = userEvent.setup();
      render(<Editor section={section} />);
      expect(screen.getByRole("combobox", { name: "金额调整方向" })).toHaveTextContent("向上加价");
      await user.click(screen.getByRole("combobox", { name: "金额调整方向" }));
      await user.click(screen.getByRole("option", { name: "向下减价" }));
      expect(screen.getByLabelText("saved direction")).toHaveTextContent("DOWN");
      expect(screen.getByLabelText("最大调整金额（分）")).toHaveValue(99);
    });
  }
  it("preserves a local direction change while merging unrelated remote settings", () => {
    const draft = structuredClone(policy), remote = structuredClone(policy);
    draft.orders.amount_offset_direction = "DOWN";
    remote.orders.order_ttl_seconds = 600;
    const merged = mergeSitePolicy(policy, draft, remote);
    expect(merged.conflicts).toEqual([]);
    expect(merged.policy.orders.amount_offset_direction).toBe("DOWN");
    expect(merged.policy.orders.order_ttl_seconds).toBe(600);
    // Explicit UP is equivalent to the omitted default, so it must not overwrite a remote DOWN.
    const unchanged = structuredClone(policy);
    unchanged.orders.amount_offset_direction = "UP";
    expect(mergeSitePolicy(policy, unchanged, draft).policy.orders.amount_offset_direction).toBe("DOWN");
  });
});

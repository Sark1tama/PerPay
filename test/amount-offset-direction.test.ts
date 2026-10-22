import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { AppDatabase } from "../src/database/database.ts";
import { createOrderRequestSchema, MAX_REQUESTED_AMOUNT_CENTS, type AmountOffsetDirection } from "../src/orders/model.ts";
import { OrderError } from "../src/orders/service.ts";
import { createApp } from "../src/http/app.ts";
import { signApiRequest } from "../src/security/api-signature.ts";
import { SiteStore } from "../src/sites/store.ts";
import { LedgerStore } from "../src/ledger/store.ts";
import { readAdminLedgerPage } from "../src/ledger/admin-query.ts";
import { ReconciliationStore } from "../src/reconciliation/store.ts";
import { siteOrderPolicySchema } from "../src/sites/model.ts";
import { createConfiguredLegacyHttpServices } from "./http-fixture.ts";
import { createSitePaymentFixture as fixture } from "./site-payment-fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
const audit = { actorId: "admin" };
const request = (amount = 100, id = randomUUID()) => createOrderRequestSchema.parse({
  merchant_order_no: id, idempotency_key: id, amount_cents: amount, product_name: "offset test",
});
function configure(f: Fixture, clientId: string, direction: AmountOffsetDirection, maximum = 99) {
  const site = f.sites.get(clientId)!;
  site.configuration.policy.orders.amount_offset_direction = direction;
  site.configuration.policy.orders.amount_offset_maximum_cents = maximum;
  return f.sites.update(clientId, { revision: site.revision, configuration: site.configuration }, audit, f.now());
}
const exhausted = (error: unknown) => error instanceof OrderError &&
  error.code === "amount_slots_exhausted" && Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds! > 0;

describe("bidirectional amount allocation", () => {
  it("defaults to upward allocation and only accepts UP or DOWN when supplied", async () => {
    const f = await fixture();
    try {
      const site = f.createSite("default direction");
      assert.equal(f.orders.forSite(site.clientId).create(request()).order.payableAmountCents, 101);
      for (const value of ["down", "", null, 0]) {
        assert.equal(siteOrderPolicySchema.safeParse({ ...site.configuration.policy.orders, amount_offset_direction: value }).success, false);
      }
    } finally { f.close(); }
  });
  it("allocates 0.99, 0.98, 0.97 for one yuan and exhausts the configured range", async () => {
    const f = await fixture();
    try {
      const site = f.createSite("downward");
      configure(f, site.clientId, "DOWN", 3);
      const orders = f.orders.forSite(site.clientId);
      assert.deepEqual(Array.from({ length: 3 }, () => orders.create(request()).order.payableAmountCents), [99, 98, 97]);
      assert.throws(() => orders.create(request()), exhausted);
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });
  it("shares full amounts and cooldown across sites using opposite directions", async () => {
    const f = await fixture();
    try {
      const up = f.createSite("up"), down = f.createSite("down");
      configure(f, down.clientId, "DOWN", 3);
      const a = f.orders.forSite(up.clientId), b = f.orders.forSite(down.clientId);
      const first = a.create(request(98)).order;
      assert.equal(first.payableAmountCents, 99);
      assert.equal(b.create(request()).order.payableAmountCents, 98);
      a.close(first.orderId);
      assert.equal(b.create(request()).order.payableAmountCents, 97);
      assert.throws(() => b.create(request()), exhausted);
      f.setNow(f.now() + 600_001);
      assert.equal(b.create(request()).order.payableAmountCents, 99);
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });
  it("preserves old checkout amounts and idempotent replays when direction changes", async () => {
    const f = await fixture();
    try {
      const site = f.createSite("switch");
      const orders = f.orders.forSite(site.clientId), original = request();
      const first = orders.create(original).order;
      configure(f, site.clientId, "DOWN");
      assert.equal(orders.create(request()).order.payableAmountCents, 99);
      const replay = orders.create(original);
      assert.equal(replay.created, false);
      assert.equal(replay.order.orderId, first.orderId);
      assert.equal(replay.order.payableAmountCents, 101);
      assert.equal(orders.publicCheckout(first.checkoutToken).paymentInstructions?.payableAmountCents, 101);
      configure(f, site.clientId, "UP");
      assert.equal(orders.create(request()).order.payableAmountCents, 102);
    } finally { f.close(); }
  });
  it("never allocates zero and rejects a one-cent order without creating any payment rows", async () => {
    const f = await fixture();
    try {
      const site = f.createSite("small price"), orders = f.orders.forSite(site.clientId);
      const oldInput = request(1), old = orders.create(oldInput).order;
      configure(f, site.clientId, "DOWN");
      assert.equal(orders.create(request(2)).order.payableAmountCents, 1);
      assert.throws(() => orders.create(request(2)), exhausted);
      assert.throws(() => orders.create(request(1)), (error: unknown) => error instanceof OrderError && error.code === "amount_too_small");
      assert.equal(orders.create(oldInput).order.orderId, old.orderId);
      assert.equal(f.database.read(db => db.prepare("SELECT count(*) AS n FROM payment_orders").get()!.n), 2n);
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });
  it("keeps the upper bound valid in either direction", async () => {
    const f = await fixture();
    try {
      const site = f.createSite("large price"), orders = f.orders.forSite(site.clientId);
      assert.equal(orders.create(request(MAX_REQUESTED_AMOUNT_CENTS)).order.payableAmountCents, MAX_REQUESTED_AMOUNT_CENTS + 1);
      configure(f, site.clientId, "DOWN");
      assert.equal(orders.create(request(MAX_REQUESTED_AMOUNT_CENTS)).order.payableAmountCents, MAX_REQUESTED_AMOUNT_CENTS - 1);
    } finally { f.close(); }
  });
  it("copies direction from new-site defaults without changing existing sites", async () => {
    const f = await fixture();
    try {
      const old = f.createSite("existing"), defaults = f.sites.defaults();
      defaults.policy.orders.amount_offset_direction = "DOWN";
      f.sites.saveDefaults(defaults, audit, f.now());
      const next = f.createSite("new");
      assert.equal(f.orders.forSite(old.clientId).create(request()).order.payableAmountCents, 101);
      assert.equal(f.orders.forSite(next.clientId).create(request()).order.payableAmountCents, 99);
    } finally { f.close(); }
  });
  it("matches the discounted payment and records requested, payable and received amounts separately", async () => {
    const f = await fixture();
    try {
      const site = f.createSite("paid"); configure(f, site.clientId, "DOWN");
      const orders = f.orders.forSite(site.clientId), order = orders.create(request()).order;
      const timestamp = (value: number) => new Date(value + 8 * 3_600_000).toISOString().slice(0, 19).replace("T", " ");
      const ledger = new LedgerStore(f.database), now = order.createdAt + 2000;
      const run = ledger.startIngestRun({ providerAccountKey: f.snapshot.activeProviderAccountKey!, start: timestamp(order.createdAt - 60_000), end: timestamp(order.createdAt + 60_000), pageSize: 1, now });
      const id = randomUUID(), amount = "0.99", occurred = timestamp(order.createdAt + 1000);
      const result = ledger.recordPage({ ingestRunId: run.ingestRunId,
        page: { pageNo: 1, pageSize: 1, totalSize: 1, hasMore: false, details: [{ raw: { account_log_id: id, amount, direction: "CREDIT", occurred_at: occurred }, accountLogId: id, occurredAt: occurred, amount, direction: "CREDIT", alipayOrderNo: id, merchantOrderNo: null, transMemo: null, otherAccount: null }] },
        evidence: { httpStatus: 200, headers: {}, body: JSON.stringify({ id, amount }), traceId: id, signatureVerified: true }, now });
      const entry = result.normalized[0];
      assert.ok(entry && entry.kind === "created");
      const reconciliation = new ReconciliationStore(f.database);
      const candidates = reconciliation.manualLedgerPage({
        contextId: order.orderId, q: "0.99", view: "recommended", limit: 20, position: null,
        siteClientId: site.clientId,
      });
      assert.equal(candidates?.items.length, 1);
      assert.equal(candidates!.items[0]!.record.ledgerEntryId, entry.entry.ledgerEntryId);
      assert.equal(candidates!.items[0]!.recommendation?.amountMatch, true);
      const decision = reconciliation.reconcileEntry(entry.entry.ledgerEntryId, now + 1);
      assert.equal(decision.kind, "auto_settled");
      f.setNow(now + 2);
      const confirmed = orders.get(order.orderId);
      assert.equal(confirmed.requestedAmountCents, 100);
      assert.equal(confirmed.payableAmountCents, 99);
      assert.equal(confirmed.receivedAmountCents, 99);
      const matched = readAdminLedgerPage(f.database, {
        environment: "PRODUCTION", associationStatus: "MATCHED", hasReversals: false,
        minAmountCents: 99, maxAmountCents: 99, sortBy: "amount_cents",
      });
      assert.equal(matched.items.length, 1);
      assert.equal(matched.items[0]!.amount_cents, 99);
      assert.equal(matched.items[0]!.active_match?.order_id, order.orderId);
      assert.equal(matched.items[0]!.last_associated_at, new Date(now + 1).toISOString());
      assert.equal(readAdminLedgerPage(f.database, {
        environment: "PRODUCTION", associationStatus: "UNMATCHED",
      }).items.length, 0);
      const payload = f.database.read(db => JSON.parse(String(db.prepare("SELECT payload_json FROM outbox_events WHERE aggregate_id = ?").get(order.orderId)!.payload_json)));
      assert.equal(payload.requested_amount_cents, 100);
      assert.equal(payload.payable_amount_cents, 99);
      assert.equal(payload.received_amount_cents, 99);
      assert.equal(f.database.integrityCheck().ok, true);
    } finally { f.close(); }
  });
});

it("serves downward orders through the signed API and restores their policy and amounts from backup", async () => {
  const f = await fixture();
  try {
    const site = f.createSite("API direction");
    configure(f, site.clientId, "DOWN");
    const key = f.sites.rotateSecret(site.clientId, "api_secret", f.sites.get(site.clientId)!.revision, audit);
    const health = { enabled: true, state: "healthy" as const, inFlight: false, lastAttemptAt: Date.now(), lastSuccessAt: Date.now(), lastErrorCode: null, consecutiveFailures: 0 };
    const app = createApp({ ...f, startedAt: new Date(), ledgerHealth: () => health,
      reconciliationHealth: () => ({ ...health, pendingOrders: 0, continuationPending: false }) });
    async function post(amount: number) {
      const body = Buffer.from(JSON.stringify(request(amount))), target = "/api/v1/orders";
      const signed = signApiRequest({ clientId: site.clientId, secret: Buffer.from(key.secret, "base64url"),
        method: "POST", target, body, timestamp: String(Math.floor(Date.now() / 1000)), nonce: randomBytes(32).toString("base64url") });
      return app.request(target, { method: "POST", body, headers: { "content-type": "application/json",
        "x-perpay-signature-version": signed.version, "x-perpay-client-id": signed.clientId,
        "x-perpay-timestamp": signed.timestamp, "x-perpay-nonce": signed.nonce, "x-perpay-signature": signed.signature } });
    }
    const low = await post(1);
    assert.equal(low.status, 422);
    assert.equal((await low.json() as { error: { code: string } }).error.code, "amount_too_small");
    const response = await post(2);
    assert.equal(response.status, 201);
    const { data } = await response.json() as { data: { order_id: string; payable_amount_cents: number } };
    assert.equal(data.payable_amount_cents, 1);
    const backup = join(dirname(f.config.databasePath), "downward-backup.sqlite3");
    await f.database.backup(backup);
    const restored = await AppDatabase.open(backup, { masterKey: f.config.masterKey });
    try {
      assert.equal(new SiteStore(restored, f.config.masterKey).get(site.clientId)!.configuration.policy.orders.amount_offset_direction, "DOWN");
      assert.equal(restored.read(db => db.prepare("SELECT payable_amount_cents FROM payment_orders WHERE order_id = ?").get(data.order_id)!.payable_amount_cents), 1n);
      assert.equal(restored.integrityCheck().ok, true);
    } finally { restored.close(); }
  } finally { f.close(); }
});

it("upgrades existing open and closed orders without changing their financial snapshots or checkout tokens", async () => {
  const directory = mkdtempSync(join(tmpdir(), "perpay-offset-upgrade-"));
  const legacy = await createConfiguredLegacyHttpServices({ directory, apiSecret: null, collectionCodePayload: "https://qr.alipay.com/offset-upgrade" });
  let current: AppDatabase | undefined;
  try {
    legacy.orders.create(request());
    const closed = legacy.orders.create(request()).order;
    legacy.orders.close(closed.orderId);
    const tables = ["payment_orders", "amount_slots", "order_events", "checkout_sessions"];
    const before = tables.map(table => legacy.database.read(db => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    legacy.database.close();
    current = await AppDatabase.open(legacy.config.databasePath, { masterKey: legacy.config.masterKey });
    const after = tables.map(table => current!.read(db => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    assert.deepEqual(after, before);
    assert.equal(current.read(db => db.prepare("SELECT max(version) AS n FROM schema_migrations").get()!.n), 36n);
    assert.equal(current.integrityCheck().ok, true);
    const backup = join(directory, "backup.sqlite3");
    await current.backup(backup);
    const restored = await AppDatabase.open(backup, { masterKey: legacy.config.masterKey });
    try { assert.equal(restored.integrityCheck().ok, true); } finally { restored.close(); }
  } finally {
    legacy.database.close(); current?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("perpay-offset-upgrade-"));
    rmSync(directory, { recursive: true });
  }
});

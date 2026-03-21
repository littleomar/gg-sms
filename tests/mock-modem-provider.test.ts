import { describe, expect, it } from "bun:test";

import { MockModemProvider } from "../src/modem/mock-modem-provider";

describe("MockModemProvider", () => {
  it("drains seeded inbox messages on demand", async () => {
    const modem = new MockModemProvider();
    const received: string[] = [];

    modem.seedInbox([
      {
        remoteNumber: "+447700900123",
        body: "hello one",
        receivedAt: "2026-03-21T00:00:00.000Z",
      },
      {
        remoteNumber: "+447700900124",
        body: "hello two",
        receivedAt: "2026-03-21T00:00:01.000Z",
      },
    ]);

    await modem.start(async (message) => {
      received.push(`${message.remoteNumber}:${message.body}`);
    });

    await modem.drainInbox();
    await modem.drainInbox();

    expect(received).toEqual([
      "+447700900123:hello one",
      "+447700900124:hello two",
    ]);
  });

  it("simulates keepalive traffic through the modem transport", async () => {
    const modem = new MockModemProvider();

    const result = await modem.performKeepaliveRequest("https://example.com/generate_204", 5_000);
    const status = await modem.getStatus();

    expect(result.httpStatus).toBe(204);
    expect(result.protocol).toBe("https");
    expect(modem.keepaliveRequests).toHaveLength(1);
    expect(status.dataAttached).toBe(false);
    expect(status.pdpActive).toBe(false);
  });

  it("restores a previously enabled data session after keepalive", async () => {
    const modem = new MockModemProvider();
    await modem.setDataEnabled(true);

    await modem.performKeepaliveRequest("https://example.com/generate_204", 5_000);
    const status = await modem.getStatus();

    expect(status.dataAttached).toBe(true);
    expect(status.pdpActive).toBe(true);
    expect(status.ipAddress).toBe("10.0.0.2");
  });

  it("allows disabling data when it is already off", async () => {
    const modem = new MockModemProvider();

    await modem.setDataEnabled(false);
    const status = await modem.getStatus();

    expect(status.dataAttached).toBe(false);
    expect(status.pdpActive).toBe(false);
    expect(status.ipAddress).toBeNull();
  });
});

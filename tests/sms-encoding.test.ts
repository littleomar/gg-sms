import { describe, expect, it } from "bun:test";

import { ConcatenatedSmsAssembler, estimateSmsSegments, isGsm7Encodable } from "../src/sms/encoding";

describe("sms encoding helpers", () => {
  it("detects GSM-7 messages and estimates segment count", () => {
    expect(isGsm7Encodable("Hello world")).toBe(true);
    expect(estimateSmsSegments("Hello world")).toEqual({
      encoding: "gsm7",
      segments: 1,
      units: 11,
    });
  });

  it("switches to UCS2 for unicode messages", () => {
    const estimate = estimateSmsSegments("你好，giffgaff");
    expect(estimate.encoding).toBe("ucs2");
    expect(estimate.segments).toBe(1);
  });

  it("reassembles concatenated messages in order", () => {
    const assembler = new ConcatenatedSmsAssembler();
    const first = assembler.addPart({
      reference: "ref-1",
      partNumber: 1,
      totalParts: 2,
      remoteNumber: "+447700900123",
      receivedAt: "2026-03-20T10:00:00.000Z",
      body: "Hello ",
    });
    const second = assembler.addPart({
      reference: "ref-1",
      partNumber: 2,
      totalParts: 2,
      remoteNumber: "+447700900123",
      receivedAt: "2026-03-20T10:00:01.000Z",
      body: "world",
    });

    expect(first.completed).toBe(false);
    expect(second).toEqual({
      completed: true,
      body: "Hello world",
    });
  });
});

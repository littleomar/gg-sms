import { describe, expect, test } from "bun:test";

import { formatDisplayTime } from "../src/time";

describe("formatDisplayTime", () => {
  test("formats timestamps in UTC+8", () => {
    expect(formatDisplayTime("2026-03-21T00:30:45.000Z")).toBe("2026-03-21 08:30:45 UTC+8");
  });

  test("returns a friendly placeholder for empty values", () => {
    expect(formatDisplayTime(null)).toBe("未可用");
  });
});

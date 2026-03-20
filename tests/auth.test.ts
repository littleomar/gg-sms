import { describe, expect, it } from "bun:test";

import { isAdminUser } from "../src/bot/auth";

describe("isAdminUser", () => {
  it("accepts the configured admin user id", () => {
    expect(isAdminUser(123456789, "123456789")).toBe(true);
  });

  it("rejects other users", () => {
    expect(isAdminUser(987654321, "123456789")).toBe(false);
    expect(isAdminUser(undefined, "123456789")).toBe(false);
  });
});

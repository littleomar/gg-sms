import { describe, expect, it } from "bun:test";

import { DraftSessionService, InMemoryDraftSessionStore } from "../src/sms/draft-session-service";

describe("DraftSessionService", () => {
  it("runs the compose flow through password validation and confirm readiness", () => {
    let currentTime = new Date("2026-03-20T10:00:00.000Z");
    const service = new DraftSessionService({
      store: new InMemoryDraftSessionStore(),
      ttlMs: 5 * 60 * 1000,
      password: "secret",
      now: () => currentTime,
    });

    const compose = service.beginCompose("admin-chat");
    expect(compose.created).toBe(true);
    expect(compose.session.state).toBe("collect_recipient");

    const recipient = service.handleText("admin-chat", "+447700900123");
    expect(recipient.type).toBe("recipient_collected");

    const body = service.handleText("admin-chat", "Hello from gg-sms");
    expect(body.type).toBe("body_collected");
    if (body.type !== "body_collected") {
      throw new Error("unexpected state");
    }
    expect(body.session.state).toBe("preview");

    const preview = service.advancePreview("admin-chat", body.session.sessionId);
    expect(preview.ok).toBe(true);
    expect(preview.session?.state).toBe("password");

    const invalidPassword = service.handleText("admin-chat", "wrong-password");
    expect(invalidPassword.type).toBe("password_invalid");

    const validPassword = service.handleText("admin-chat", "secret");
    expect(validPassword.type).toBe("password_valid");
    if (validPassword.type !== "password_valid") {
      throw new Error("unexpected state");
    }

    const confirm = service.canConfirm("admin-chat", validPassword.session.sessionId);
    expect(confirm.ok).toBe(true);
    expect(confirm.session?.passwordVerified).toBe(true);

    service.complete("admin-chat");
    expect(service.getActiveSession("admin-chat")).toBeNull();
  });

  it("supports reply mode and expires stale drafts", () => {
    let currentTime = new Date("2026-03-20T10:00:00.000Z");
    const service = new DraftSessionService({
      store: new InMemoryDraftSessionStore(),
      ttlMs: 60_000,
      password: "secret",
      now: () => currentTime,
    });

    const reply = service.beginReply("admin-chat", "+447700900123", 42);
    expect(reply.created).toBe(true);
    expect(reply.session.state).toBe("collect_body");
    expect(reply.session.remoteNumber).toBe("+447700900123");

    currentTime = new Date("2026-03-20T10:02:30.000Z");
    expect(service.getActiveSession("admin-chat")).toBeNull();
  });
});

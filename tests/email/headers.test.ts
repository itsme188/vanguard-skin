import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import nodemailer from "nodemailer";

// Shape of the options object lib/email.ts passes to transporter.sendMail().
interface MockMailOptions {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  headers: Record<string, string>;
}

// Mock nodemailer to capture sendMail calls. Echo the header back the way
// nodemailer does (mime-node/index.js:922 returns the Message-ID header that
// was set rather than generating a new one) so the round trip is observable.
const mockSendMail = vi.fn(async (mail: MockMailOptions) => ({
  messageId: mail.headers?.["Message-ID"] ?? "<generated@example.com>",
  response: "250 2.0.0 OK",
}));
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      sendMail: mockSendMail,
    })),
  },
}));

import { sendEmail } from "@/lib/email";

describe("sendEmail headers", () => {
  beforeEach(() => {
    mockSendMail.mockClear();
    process.env.RESEND_API_KEY = "test-api-key";
    process.env.RESEND_FROM_DOMAIN = "myportfoliodesk.com";
    delete process.env.REPLY_TO_ADDRESS;
  });

  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_DOMAIN;
    delete process.env.REPLY_TO_ADDRESS;
  });

  it("includes List-Unsubscribe header with mailto format", async () => {
    await sendEmail({
      to: "recipient@example.com",
      subject: "Test",
      html: "<p>Test</p>",
    });

    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0][0];
    expect(call.headers).toBeDefined();
    expect(call.headers["List-Unsubscribe"]).toBe(
      "<mailto:unsubscribe@myportfoliodesk.com?subject=unsubscribe>"
    );
  });

  it("includes List-Unsubscribe-Post header", async () => {
    await sendEmail({
      to: "recipient@example.com",
      subject: "Test",
      html: "<p>Test</p>",
    });

    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0][0];
    expect(call.headers["List-Unsubscribe-Post"]).toBe(
      "List-Unsubscribe=One-Click"
    );
  });

  it("includes Message-ID header with UUID@domain format", async () => {
    await sendEmail({
      to: "recipient@example.com",
      subject: "Test",
      html: "<p>Test</p>",
    });

    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0][0];
    expect(call.headers["Message-ID"]).toBeDefined();

    // Check Message-ID format: <uuid@domain>
    const messageId = call.headers["Message-ID"] as string;
    expect(messageId).toMatch(
      /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@myportfoliodesk\.com>$/i
    );
  });

  it("defaults Reply-To to replies@domain when env var unset", async () => {
    await sendEmail({
      to: "recipient@example.com",
      subject: "Test",
      html: "<p>Test</p>",
    });

    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0][0];
    expect(call.replyTo).toBe("replies@myportfoliodesk.com");
  });

  it("uses REPLY_TO_ADDRESS env var when set", async () => {
    process.env.REPLY_TO_ADDRESS = "custom@example.com";

    await sendEmail({
      to: "recipient@example.com",
      subject: "Test",
      html: "<p>Test</p>",
    });

    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0][0];
    expect(call.replyTo).toBe("custom@example.com");
  });

  it("uses opts.replyTo parameter when provided (overrides env var)", async () => {
    process.env.REPLY_TO_ADDRESS = "env@example.com";

    await sendEmail({
      to: "recipient@example.com",
      subject: "Test",
      html: "<p>Test</p>",
      replyTo: "param@example.com",
    });

    expect(mockSendMail).toHaveBeenCalledOnce();
    const call = mockSendMail.mock.calls[0][0];
    expect(call.replyTo).toBe("param@example.com");
  });

  it("generates unique Message-IDs for multiple calls", async () => {
    await sendEmail({
      to: "recipient1@example.com",
      subject: "Test 1",
      html: "<p>Test 1</p>",
    });

    await sendEmail({
      to: "recipient2@example.com",
      subject: "Test 2",
      html: "<p>Test 2</p>",
    });

    expect(mockSendMail).toHaveBeenCalledTimes(2);
    const call1 = mockSendMail.mock.calls[0][0];
    const call2 = mockSendMail.mock.calls[1][0];

    const messageId1 = call1.headers["Message-ID"] as string;
    const messageId2 = call2.headers["Message-ID"] as string;

    expect(messageId1).not.toBe(messageId2);
  });
});

describe("sendEmail message id round trip", () => {
  beforeEach(() => {
    mockSendMail.mockClear();
    process.env.RESEND_API_KEY = "test-api-key";
    process.env.RESEND_FROM_DOMAIN = "myportfoliodesk.com";
    delete process.env.REPLY_TO_ADDRESS;
  });

  afterEach(() => {
    delete process.env.RESEND_API_KEY;
    delete process.env.RESEND_FROM_DOMAIN;
    delete process.env.REPLY_TO_ADDRESS;
  });

  it("sets the caller's Message-ID on the header and returns it with the provider response", async () => {
    const mine = "<11111111-2222-3333-4444-555555555555@myportfoliodesk.com>";
    const res = await sendEmail({
      to: "recipient@example.com", subject: "Test", html: "<p>Test</p>", messageId: mine,
    });
    expect(mockSendMail.mock.calls[0][0].headers["Message-ID"]).toBe(mine);
    expect(res).toEqual({ messageId: mine, response: "250 2.0.0 OK" });
  });

  it("still mints a <uuid@domain> id and returns it when the caller passes none", async () => {
    const res = await sendEmail({ to: "recipient@example.com", subject: "Test", html: "<p>Test</p>" });
    expect(res.messageId).toMatch(
      /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@myportfoliodesk\.com>$/i,
    );
    expect(mockSendMail.mock.calls[0][0].headers["Message-ID"]).toBe(res.messageId);
  });

  it("falls back to the id it set when the transport reports none, and to '' for a missing response", async () => {
    mockSendMail.mockResolvedValueOnce({} as never);
    const mine = "<aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee@myportfoliodesk.com>";
    const res = await sendEmail({
      to: "recipient@example.com", subject: "Test", html: "<p>Test</p>", messageId: mine,
    });
    expect(res).toEqual({ messageId: mine, response: "" });
  });
});

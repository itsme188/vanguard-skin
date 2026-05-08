import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import nodemailer from "nodemailer";

// Mock nodemailer to capture sendMail calls
const mockSendMail = vi.fn().mockResolvedValue({ messageId: "<test@example.com>" });
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

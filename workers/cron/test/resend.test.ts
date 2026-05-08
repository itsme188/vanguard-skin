import { describe, it, expect, beforeEach, vi } from "vitest";
import { sendEmail, ResendEnv, SendOptions } from "../src/resend";

// Mock global fetch
global.fetch = vi.fn();

describe("Worker Resend email sender", () => {
  let mockFetch: ReturnType<typeof vi.fn>;
  let env: ResendEnv;

  beforeEach(() => {
    mockFetch = global.fetch as ReturnType<typeof vi.fn>;
    mockFetch.mockClear();
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "test-email-id" }),
      text: async () => "success",
    });

    env = {
      RESEND_API_KEY: "test-api-key",
      RESEND_FROM_DOMAIN: "myportfoliodesk.com",
    };
  });

  it("should include List-Unsubscribe header in REST body", async () => {
    const opts: SendOptions = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test content</p>",
      fromLocalPart: "briefing",
    };

    await sendEmail(env, opts);

    expect(mockFetch).toHaveBeenCalledOnce();
    const call = mockFetch.mock.calls[0];
    const url = call[0];
    const fetchOpts = call[1];

    expect(url).toBe("https://api.resend.com/emails");
    const body = JSON.parse(fetchOpts.body as string) as Record<
      string,
      unknown
    >;
    const headers = body.headers as Record<string, string>;
    expect(headers["List-Unsubscribe"]).toBe(
      "<mailto:unsubscribe@myportfoliodesk.com?subject=unsubscribe>"
    );
  });

  it("should include List-Unsubscribe-Post header in REST body", async () => {
    const opts: SendOptions = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test content</p>",
      fromLocalPart: "digest",
    };

    await sendEmail(env, opts);

    const call = mockFetch.mock.calls[0];
    const fetchOpts = call[1];
    const body = JSON.parse(fetchOpts.body as string) as Record<
      string,
      unknown
    >;
    const headers = body.headers as Record<string, string>;

    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("should generate Message-ID matching <uuid@domain> pattern", async () => {
    const opts: SendOptions = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test content</p>",
      fromLocalPart: "earnings",
    };

    await sendEmail(env, opts);

    const call = mockFetch.mock.calls[0];
    const fetchOpts = call[1];
    const body = JSON.parse(fetchOpts.body as string) as Record<
      string,
      unknown
    >;
    const headers = body.headers as Record<string, string>;
    const messageId = headers["Message-ID"];

    // Should match <uuid@domain> format
    expect(messageId).toMatch(
      /^<[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@myportfoliodesk\.com>$/i
    );
  });

  it("should default reply_to to replies@domain when not provided", async () => {
    const opts: SendOptions = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test content</p>",
      fromLocalPart: "briefing",
    };

    await sendEmail(env, opts);

    const call = mockFetch.mock.calls[0];
    const fetchOpts = call[1];
    const body = JSON.parse(fetchOpts.body as string) as Record<
      string,
      unknown
    >;

    expect(body.reply_to).toBe("replies@myportfoliodesk.com");
  });

  it("should honor opts.replyTo when caller provides one", async () => {
    const opts: SendOptions = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test content</p>",
      fromLocalPart: "briefing",
      replyTo: "custom-reply@example.com",
    };

    await sendEmail(env, opts);

    const call = mockFetch.mock.calls[0];
    const fetchOpts = call[1];
    const body = JSON.parse(fetchOpts.body as string) as Record<
      string,
      unknown
    >;

    expect(body.reply_to).toBe("custom-reply@example.com");
  });

  it("should throw when RESEND_API_KEY is missing", async () => {
    const badEnv: ResendEnv = {
      RESEND_FROM_DOMAIN: "myportfoliodesk.com",
    };

    const opts: SendOptions = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test content</p>",
      fromLocalPart: "briefing",
    };

    await expect(sendEmail(badEnv, opts)).rejects.toThrow(
      "Resend env missing"
    );
  });

  it("should throw when RESEND_FROM_DOMAIN is missing", async () => {
    const badEnv: ResendEnv = {
      RESEND_API_KEY: "test-key",
    };

    const opts: SendOptions = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test content</p>",
      fromLocalPart: "briefing",
    };

    await expect(sendEmail(badEnv, opts)).rejects.toThrow(
      "Resend env missing"
    );
  });

  it("should throw on Resend API error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });

    const opts: SendOptions = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test content</p>",
      fromLocalPart: "briefing",
    };

    await expect(sendEmail(env, opts)).rejects.toThrow(
      "Resend send failed (401)"
    );
  });

  it("should set Authorization header with Bearer token", async () => {
    const opts: SendOptions = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test content</p>",
      fromLocalPart: "briefing",
    };

    await sendEmail(env, opts);

    const call = mockFetch.mock.calls[0];
    const fetchOpts = call[1];

    expect(fetchOpts.headers.Authorization).toBe("Bearer test-api-key");
  });

  it("should include all required fields in request body", async () => {
    const opts: SendOptions = {
      to: "recipient@example.com",
      subject: "Test Subject",
      html: "<p>Test content</p>",
      fromLocalPart: "digest",
    };

    await sendEmail(env, opts);

    const call = mockFetch.mock.calls[0];
    const fetchOpts = call[1];
    const body = JSON.parse(fetchOpts.body as string) as Record<
      string,
      unknown
    >;

    expect(body.from).toBe('Portfolio Desk <digest@myportfoliodesk.com>');
    expect(body.to).toEqual(["recipient@example.com"]);
    expect(body.subject).toBe("Test Subject");
    expect(body.html).toBe("<p>Test content</p>");
    expect(body.reply_to).toBe("replies@myportfoliodesk.com");
    expect(body.headers).toBeDefined();
  });
});

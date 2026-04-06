import type { gmail_v1 } from "googleapis";

interface DiscoveredSender {
  email: string;
  name: string;
  messageCount: number;
  latestSubject: string;
  latestDate: string;
}

/**
 * Search Gmail for likely newsletter senders.
 * Looks for emails with "unsubscribe" links (common in newsletters)
 * and groups by sender, returning the most frequent ones.
 */
export async function discoverNewsletterSenders(
  gmail: gmail_v1.Gmail,
  maxResults = 200
): Promise<DiscoveredSender[]> {
  // Gmail search for newsletter-like emails (have unsubscribe header or link)
  const response = await gmail.users.messages.list({
    userId: "me",
    q: "has:unsubscribe newer_than:90d",
    maxResults,
  });

  const messages = response.data.messages || [];
  if (messages.length === 0) return [];

  // Fetch headers for each message
  const senderMap = new Map<
    string,
    { name: string; count: number; latestSubject: string; latestDate: string }
  >();

  // Batch fetch — get headers only (minimal payload)
  for (const msg of messages) {
    try {
      const detail = await gmail.users.messages.get({
        userId: "me",
        id: msg.id!,
        format: "metadata",
        metadataHeaders: ["From", "Subject", "Date"],
      });

      const headers = detail.data.payload?.headers || [];
      const from =
        headers.find((h) => h.name?.toLowerCase() === "from")?.value || "";
      const subject =
        headers.find((h) => h.name?.toLowerCase() === "subject")?.value || "";
      const date =
        headers.find((h) => h.name?.toLowerCase() === "date")?.value || "";

      // Extract email from "Name <email>" format
      const emailMatch = from.match(/<([^>]+)>/);
      const email = emailMatch ? emailMatch[1].toLowerCase() : from.toLowerCase().trim();
      const name = emailMatch
        ? from.replace(/<[^>]+>/, "").replace(/"/g, "").trim()
        : email;

      if (!email || email.includes("noreply@google") || email.includes("mailer-daemon")) {
        continue;
      }

      const existing = senderMap.get(email);
      if (existing) {
        existing.count++;
        // Keep the most recent subject/date
        try {
          if (new Date(date) > new Date(existing.latestDate)) {
            existing.latestSubject = subject;
            existing.latestDate = date;
          }
        } catch {
          // Keep existing
        }
      } else {
        senderMap.set(email, {
          name: name || email,
          count: 1,
          latestSubject: subject,
          latestDate: date,
        });
      }
    } catch {
      // Skip individual message failures
    }
  }

  // Sort by frequency (most frequent = likely newsletters)
  const results: DiscoveredSender[] = [];
  for (const [email, data] of senderMap) {
    // Include all senders found with unsubscribe headers
    if (data.count >= 1) {
      let formattedDate: string;
      try {
        formattedDate = new Date(data.latestDate).toISOString().slice(0, 10);
      } catch {
        formattedDate = "unknown";
      }
      results.push({
        email,
        name: data.name,
        messageCount: data.count,
        latestSubject: data.latestSubject,
        latestDate: formattedDate,
      });
    }
  }

  results.sort((a, b) => b.messageCount - a.messageCount);
  return results.slice(0, 50); // Top 50
}

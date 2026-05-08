# Email deliverability audit — 2026-05-08

Baseline DNS state for `myportfoliodesk.com` before Phase 3 deliverability changes.

## DKIM ✓

```
$ dig +short TXT resend._domainkey.myportfoliodesk.com
"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC/2LPMlOQqBm37De6SsdJL2/2D2vdGSpmrqLLqm3OJm55EPthSNPYTcqsW7rujZM7lI44j60H8Fl/TxUQI1fCOUaXNI7ywPL8ePIJZ8YjtA5q8FxvrNgTVYeKN1UsxlAevjwdp32NsWURqIHlbd2yFEF8zSvuEnryqOKgHd0RWYQIDAQAB"
```

Resend selector `resend._domainkey` is published with the public key. DKIM signing on apex authorizes the `From: <localPart>@myportfoliodesk.com` header domain. ✅

## SPF (split: apex vs send subdomain)

```
$ dig +short TXT myportfoliodesk.com
"v=spf1 include:_spf.mx.cloudflare.net ~all"

$ dig +short TXT send.myportfoliodesk.com
"v=spf1 include:amazonses.com ~all"
```

This is the intentional subdomain-isolation pattern (per CLAUDE.md):
- **Apex SPF** authorizes Cloudflare's MX (inbound only).
- **`send.myportfoliodesk.com` SPF** authorizes Amazon SES (Resend's sending infrastructure). The bounce/return-path lives there.

DMARC alignment relies on DKIM (apex-aligned) since SPF is on a different subdomain than the `From` header. **DKIM alignment passes, so DMARC verdicts will be PASS once a record exists.** ✅ (intentional)

## DMARC ❌ NOT PUBLISHED

```
$ dig +short TXT _dmarc.myportfoliodesk.com
(empty)
```

**This is the most likely cause of Eli's email landing in junk on 2026-05-DD.** Gmail's 2024+ "Sender Guidelines" penalize domains without a DMARC record, regardless of DKIM/SPF status. Without `_dmarc.myportfoliodesk.com`, Gmail can't see that the domain owner has any policy at all — and treats the sender as low-reputation.

### Recommended DMARC record

Add this TXT record at `_dmarc.myportfoliodesk.com`:

```
v=DMARC1; p=none; rua=mailto:dmarc-reports@myportfoliodesk.com; pct=100; aspf=r; adkim=r;
```

Breakdown:
- `p=none` — monitoring only. Don't quarantine/reject failing messages yet. After 1-2 weeks of `rua` reports confirming SPF + DKIM alignment, escalate to `p=quarantine` then eventually `p=reject`.
- `rua=mailto:dmarc-reports@myportfoliodesk.com` — aggregate reports endpoint. Cloudflare Email Routing should forward this to a real inbox the user reads (or to a DMARC analyzer like Postmark, dmarcian, etc.).
- `pct=100` — apply policy to 100% of messages (only meaningful at `p=quarantine` / `reject`).
- `aspf=r; adkim=r` — relaxed alignment (subdomain → apex passes). This is what allows DKIM-on-apex + SPF-on-send-subdomain to both align under DMARC.

Publish via Cloudflare DNS dashboard → `myportfoliodesk.com` → DNS → Add record. TXT record at `_dmarc`.

## MX (inbound) ✓

```
$ dig +short MX myportfoliodesk.com
39 route2.mx.cloudflare.net.
63 route3.mx.cloudflare.net.
81 route1.mx.cloudflare.net.
```

Cloudflare Email Routing catch-all is active. Inbound mail (replies, DMARC reports, unsubscribe handler) flows through here. ✅

## MX (send subdomain — bounce handler) ✓

```
$ dig +short MX send.myportfoliodesk.com
10 feedback-smtp.us-east-1.amazonses.com.
```

Bounces and complaint feedback flow back to Amazon SES (Resend's transport). Standard subdomain-isolation pattern. ✅

## Resend dashboard ⏳ MANUAL CHECK NEEDED

User must verify in `https://resend.com/domains/myportfoliodesk.com`:
- [ ] Both `myportfoliodesk.com` and `send.myportfoliodesk.com` show as "Verified"
- [ ] Suppression list is empty (or, if non-empty, no addresses we send to are listed)
- [ ] Past 30d delivery stats: bounce rate <2%, complaint rate <0.1%
- [ ] No domain warnings or warm-up advisories

---

## Recommended priority order

| # | Action | Priority | Owner |
|---|---|---|---|
| 1 | **Publish DMARC TXT record** | 🔥 Highest — likely root cause of junk-folder placement | User (CF DNS) |
| 2 | Add Email Routing rule for `replies@myportfoliodesk.com` → user inbox | High — Phase 3.2 dependency | User (CF dashboard) |
| 3 | Add Email Routing rule for `dmarc-reports@myportfoliodesk.com` → user inbox or analyzer | High — collects DMARC verdicts so we can escalate to `p=quarantine` later | User (CF dashboard) |
| 4 | Resend dashboard suppression-list check | Medium | User (Resend UI) |
| 5 | Code: add `List-Unsubscribe`, `List-Unsubscribe-Post`, `Reply-To`, `Message-ID` headers | Medium — Phase 3.3 + 3.4 | This branch |

---

## Reference

- Gmail Sender Guidelines (2024+): https://support.google.com/mail/answer/81126
- DMARC.org tag reference: https://dmarc.org/overview/
- Cloudflare Email Routing docs: https://developers.cloudflare.com/email-routing/

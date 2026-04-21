import { AwsClient } from "aws4fetch";
import { readFileSync } from "node:fs";

/**
 * Cloudflare R2 client (S3-compatible).
 *
 * Env vars required:
 *   R2_ACCOUNT_ID        — usually same as CLOUDFLARE_ACCOUNT_ID
 *   R2_BUCKET_NAME       — bucket name (e.g., "vanguard-skin-statements")
 *   R2_ACCESS_KEY_ID     — S3-compatible access key (create in R2 dashboard)
 *   R2_SECRET_ACCESS_KEY — S3-compatible secret key
 *
 * Missing env vars = upload is a no-op (returns null). This lets the import
 * pipeline call `uploadStatementPdf()` unconditionally; R2 archival is purely
 * additive — never blocks imports, never throws on missing creds.
 */

function readEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  try {
    const content = readFileSync(
      `${process.cwd()}/.env.local`,
      "utf8"
    );
    for (const line of content.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && line.slice(0, eq).trim() === key) {
        return line.slice(eq + 1).trim();
      }
    }
  } catch {
    // no .env.local
  }
  return undefined;
}

interface R2Config {
  accountId: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

function getR2Config(): R2Config | null {
  const accountId = readEnv("R2_ACCOUNT_ID") ?? readEnv("CLOUDFLARE_ACCOUNT_ID");
  const bucket = readEnv("R2_BUCKET_NAME");
  const accessKeyId = readEnv("R2_ACCESS_KEY_ID");
  const secretAccessKey = readEnv("R2_SECRET_ACCESS_KEY");
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { accountId, bucket, accessKeyId, secretAccessKey };
}

function buildClient(cfg: R2Config): { client: AwsClient; endpoint: string } {
  const client = new AwsClient({
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    service: "s3",
    region: "auto",
  });
  const endpoint = `https://${cfg.accountId}.r2.cloudflarestorage.com/${cfg.bucket}`;
  return { client, endpoint };
}

/**
 * Build a deterministic R2 key for an archived source file.
 * Format: {sourceType}/{filename}
 *   e.g. "vanguard_pdf/03-2025 brokerage.pdf"
 *
 * Simple by design — disaster recovery doesn't benefit from a deeper path
 * hierarchy, and filenames typically already carry the date. Idempotent:
 * re-uploading the same source file overwrites the same key.
 */
export function buildStatementKey(params: {
  sourceType: string;
  filename: string;
}): string {
  return `${params.sourceType}/${params.filename}`;
}

/**
 * Upload a PDF buffer to R2. Returns the R2 key on success, null if R2 env
 * vars are missing, throws only on explicit upload failure (auth, network).
 */
export async function uploadStatementPdf(
  key: string,
  pdfBuffer: Buffer
): Promise<string | null> {
  const cfg = getR2Config();
  if (!cfg) return null;
  const { client, endpoint } = buildClient(cfg);

  const url = `${endpoint}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  const res = await client.fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/pdf",
    },
    body: new Uint8Array(pdfBuffer),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `R2 upload failed (${res.status} ${res.statusText}): ${body.slice(0, 200)}`
    );
  }

  return key;
}

/**
 * Check whether an object exists in R2. Useful for idempotency in backfill.
 */
export async function statementExists(key: string): Promise<boolean> {
  const cfg = getR2Config();
  if (!cfg) return false;
  const { client, endpoint } = buildClient(cfg);
  const url = `${endpoint}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
  const res = await client.fetch(url, { method: "HEAD" });
  return res.ok;
}

/**
 * Generate a pre-signed URL so a browser (or other client) can GET the object
 * for a limited window. Useful for a future "re-download" button without
 * streaming through the Electron server.
 */
export async function presignStatementDownload(
  key: string,
  expiresSeconds = 600
): Promise<string | null> {
  const cfg = getR2Config();
  if (!cfg) return null;
  const { client, endpoint } = buildClient(cfg);
  const url = `${endpoint}/${encodeURIComponent(key).replace(/%2F/g, "/")}?X-Amz-Expires=${expiresSeconds}`;
  const signed = await client.sign(url, { method: "GET", aws: { signQuery: true } });
  return signed.url;
}

export function isR2Configured(): boolean {
  return getR2Config() !== null;
}

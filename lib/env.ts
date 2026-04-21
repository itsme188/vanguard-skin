import { readFileSync } from "fs";
import { join } from "path";

/**
 * Read a key from .env.local, falling back when the system environment
 * shadows it with an empty string (e.g. ANTHROPIC_API_KEY="" from shell profile).
 */
function readEnvLocal(key: string): string | undefined {
  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of content.split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0 && line.slice(0, eq).trim() === key) {
        return line.slice(eq + 1).trim();
      }
    }
  } catch {
    // .env.local doesn't exist
  }
  return undefined;
}

function readEnv(key: string): string | undefined {
  return process.env[key] || readEnvLocal(key);
}

export function getAnthropicApiKey(): string | undefined {
  return readEnv("ANTHROPIC_API_KEY");
}

export function getOpenAIApiKey(): string | undefined {
  return readEnv("OPENAI_API_KEY");
}

export interface CloudflareGatewayConfig {
  accountId: string;
  gatewayId: string;
  token?: string;
}

/**
 * Returns Cloudflare AI Gateway config when both account + gateway IDs are set.
 * Missing values mean "no gateway" — provider factory transparently falls back
 * to direct Anthropic/OpenAI endpoints.
 */
export function getCloudflareGateway(): CloudflareGatewayConfig | undefined {
  const accountId = readEnv("CLOUDFLARE_ACCOUNT_ID");
  const gatewayId = readEnv("CLOUDFLARE_GATEWAY_ID");
  if (!accountId || !gatewayId) return undefined;
  return {
    accountId,
    gatewayId,
    token: readEnv("CLOUDFLARE_GATEWAY_TOKEN"),
  };
}

export function getCloudflareWorkersAIToken(): string | undefined {
  return readEnv("CLOUDFLARE_WORKERS_AI_TOKEN");
}

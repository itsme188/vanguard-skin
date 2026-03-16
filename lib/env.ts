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

export function getAnthropicApiKey(): string | undefined {
  return process.env.ANTHROPIC_API_KEY || readEnvLocal("ANTHROPIC_API_KEY");
}

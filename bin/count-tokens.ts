#!/usr/bin/env tsx
import Anthropic from "@anthropic-ai/sdk";
import { glob } from "glob";
import { readFileSync } from "fs";
import { join } from "path";

const FILE_PATTERNS: Record<string, string[]> = {
  TypeScript: ["src/**/*.ts", "src/**/*.tsx", "bin/**/*.ts"],
  Markdown: ["**/*.md", "!node_modules/**"],
  JSON: ["*.json", "!package-lock.json", "!node_modules/**"],
  HTML: ["src/**/*.html"],
  CSS: ["src/**/*.css"],
  WGSL: ["src/**/*.wgsl"],
};

// Read API key from file or environment
function getApiKey(): string {
  const keyFilePath = join(process.cwd(), ".anthropic_api_key");
  try {
    return readFileSync(keyFilePath, "utf-8").trim();
  } catch {
    return process.env.ANTHROPIC_API_KEY || "";
  }
}

// Initialize Anthropic client
const client = new Anthropic({
  apiKey: getApiKey(),
});

// Sleep helper for rate limiting
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function countTokensForFiles(
  files: string[],
  type: string,
): Promise<{ tokens: number; chars: number }> {
  if (files.length === 0) return { tokens: 0, chars: 0 };

  process.stdout.write(`${type}: reading ${files.length} files...`);

  // Read all files and concatenate content
  const contents: string[] = [];
  let totalChars = 0;

  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      contents.push(content);
      totalChars += content.length;
    } catch {
      // Skip files that can't be read
    }
  }

  if (contents.length === 0) return { tokens: 0, chars: totalChars };

  // Bundle all content together with separators
  const bundledContent = contents.join("\n\n---\n\n");

  process.stdout.write(`\r\x1b[K${type}: counting tokens via API...`);

  try {
    // Use Anthropic API to count tokens (beta endpoint)
    const result = await client.beta.messages.countTokens({
      model: "claude-sonnet-4-5-20250929",
      messages: [
        {
          role: "user",
          content: bundledContent,
        },
      ],
    });

    // Add a small delay to respect rate limits
    await sleep(500);

    return { tokens: result.input_tokens, chars: totalChars };
  } catch (error) {
    if (error instanceof Error) {
      console.error(`\nError counting tokens for ${type}:`, error.message);
    }
    return { tokens: 0, chars: totalChars };
  }
}

async function main() {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.error("Error: API key not found.\n");
    console.error(
      "Please either set ANTHROPIC_API_KEY environment variable or create a .anthropic_api_key file",
    );
    process.exit(1);
  }

  console.log(`Counting tokens using Anthropic's API...\n`);

  const results: Array<{
    type: string;
    tokens: number;
    files: number;
    chars: number;
  }> = [];
  let grandTotal = 0;
  let totalFiles = 0;
  let totalChars = 0;

  for (const [type, patterns] of Object.entries(FILE_PATTERNS)) {
    const files = await glob(patterns, { nodir: true });

    if (files.length > 0) {
      const { tokens, chars } = await countTokensForFiles(files, type);
      process.stdout.write("\r\x1b[K");
      console.log(
        `${type}: ${tokens.toLocaleString()} tokens (${files.length} files)`,
      );
      results.push({ type, tokens, files: files.length, chars });
      grandTotal += tokens;
      totalFiles += files.length;
      totalChars += chars;
    }
  }

  // Sort by token count descending
  results.sort((a, b) => b.tokens - a.tokens);

  // Calculate column widths
  const typeWidth = Math.max(...results.map((r) => r.type.length), 4);
  const tokenWidth = Math.max(
    ...results.map((r) => r.tokens.toLocaleString().length),
    6,
  );
  const fileWidth = Math.max(
    ...results.map((r) => r.files.toLocaleString().length),
    5,
  );
  const charWidth = Math.max(
    ...results.map((r) => r.chars.toLocaleString().length),
    5,
  );

  // Print summary table
  console.log();
  console.log(
    `${"Type".padEnd(typeWidth)}  ${"Tokens".padStart(tokenWidth)}  ${"Files".padStart(fileWidth)}  ${"Chars".padStart(charWidth)}  Chars/Token`,
  );
  console.log("-".repeat(typeWidth + tokenWidth + fileWidth + charWidth + 18));

  for (const { type, tokens, files, chars } of results) {
    const ratio = tokens > 0 ? (chars / tokens).toFixed(2) : "N/A";
    console.log(
      `${type.padEnd(typeWidth)}  ${tokens.toLocaleString().padStart(tokenWidth)}  ${files.toLocaleString().padStart(fileWidth)}  ${chars.toLocaleString().padStart(charWidth)}  ${ratio}`,
    );
  }

  console.log("-".repeat(typeWidth + tokenWidth + fileWidth + charWidth + 18));
  const totalRatio = (totalChars / grandTotal).toFixed(2);
  console.log(
    `${"TOTAL".padEnd(typeWidth)}  ${grandTotal.toLocaleString().padStart(tokenWidth)}  ${totalFiles.toLocaleString().padStart(fileWidth)}  ${totalChars.toLocaleString().padStart(charWidth)}  ${totalRatio}`,
  );

  console.log(
    `\nClaude context usage: ${((grandTotal / 200_000) * 100).toFixed(1)}% of 200K window`,
  );
}

main().catch(console.error);

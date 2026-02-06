#!/usr/bin/env tsx
import { countTokens } from "@anthropic-ai/tokenizer";
import { glob } from "glob";
import { readFileSync } from "fs";
import { Worker } from "worker_threads";
import { cpus } from "os";

const FILE_PATTERNS: Record<string, string[]> = {
  TypeScript: ["src/**/*.ts", "src/**/*.tsx", "bin/**/*.ts"],
  Markdown: ["**/*.md", "!node_modules/**"],
  JSON: ["*.json", "!package-lock.json", "!node_modules/**"],
  HTML: ["src/**/*.html"],
  CSS: ["src/**/*.css"],
  WGSL: ["src/**/*.wgsl"],
};

// Worker code as a string (runs in vanilla Node)
const workerCode = `
const { parentPort, workerData } = require('worker_threads');
const { readFileSync } = require('fs');
const { countTokens } = require('@anthropic-ai/tokenizer');

const files = workerData;
let tokens = 0;
let chars = 0;

for (const file of files) {
  try {
    const content = readFileSync(file, 'utf-8');
    chars += content.length;
    tokens += countTokens(content);
  } catch {}
}

parentPort.postMessage({ tokens, chars });
`;

// Main thread code
const NUM_WORKERS = Math.max(1, cpus().length - 1);

function clearLine() {
  process.stdout.write("\r\x1b[K");
}

function chunkArray<T>(array: T[], chunks: number): T[][] {
  const result: T[][] = [];
  const chunkSize = Math.ceil(array.length / chunks);
  for (let i = 0; i < array.length; i += chunkSize) {
    result.push(array.slice(i, i + chunkSize));
  }
  return result;
}

async function countTokensParallel(
  files: string[],
  type: string,
): Promise<{ tokens: number; chars: number }> {
  if (files.length === 0) return { tokens: 0, chars: 0 };

  // For small file counts, just run single-threaded
  if (files.length < NUM_WORKERS * 2) {
    let tokens = 0;
    let chars = 0;
    for (let i = 0; i < files.length; i++) {
      process.stdout.write(
        `\r\x1b[K${type}: ${i + 1}/${files.length} files...`,
      );
      try {
        const content = readFileSync(files[i], "utf-8");
        chars += content.length;
        tokens += countTokens(content);
      } catch {
        // Skip
      }
    }
    return { tokens, chars };
  }

  // Split files across workers
  const chunks = chunkArray(files, NUM_WORKERS);

  process.stdout.write(
    `${type}: processing ${files.length} files across ${chunks.length} workers...`,
  );

  const results = await Promise.all(
    chunks.map(
      (chunk) =>
        new Promise<{ tokens: number; chars: number }>((resolve, reject) => {
          const worker = new Worker(workerCode, {
            workerData: chunk,
            eval: true,
          });
          worker.on("message", resolve);
          worker.on("error", reject);
          worker.on("exit", (code) => {
            if (code !== 0)
              reject(new Error(`Worker exited with code ${code}`));
          });
        }),
    ),
  );

  return results.reduce(
    (acc, r) => ({ tokens: acc.tokens + r.tokens, chars: acc.chars + r.chars }),
    { tokens: 0, chars: 0 },
  );
}

async function main() {
  console.log(
    `Counting tokens using Anthropic's tokenizer (${NUM_WORKERS} workers)...\n`,
  );

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
      const { tokens, chars } = await countTokensParallel(files, type);
      clearLine();
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

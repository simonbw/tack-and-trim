#!/usr/bin/env node_modules/.bin/tsx

import fs from "fs";
import path from "path";
import { Project } from "ts-morph";
import yargs from "yargs";

async function moveFile(source: string, destination: string): Promise<void> {
  const sourcePath = path.resolve(source);
  const destPath = path.resolve(destination);

  // Initialize ts-morph project
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
    skipAddingFilesFromTsConfig: false,
  });

  // Validate inputs
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file does not exist: ${sourcePath}`);
  }

  if (![".ts", ".tsx"].some(ext => sourcePath.endsWith(ext))) {
    throw new Error("Source file must be a TypeScript file (.ts or .tsx)");
  }

  if (![".ts", ".tsx"].some(ext => destPath.endsWith(ext))) {
    throw new Error("Destination file must be a TypeScript file (.ts or .tsx)");
  }

  if (fs.existsSync(destPath)) {
    throw new Error(`Destination file already exists: ${destPath}`);
  }

  // Get the source file
  const sourceFile = project.getSourceFile(sourcePath);
  if (!sourceFile) {
    throw new Error(`Source file not found in project: ${sourcePath}`);
  }

  console.log(`Moving: ${sourcePath} -> ${destPath}`);

  // Check what will be affected
  const referencingFiles = sourceFile.getReferencingSourceFiles();
  if (referencingFiles.length > 0) {
    console.log(`Updating imports in ${referencingFiles.length} file(s):`);
    referencingFiles.forEach(file => {
      console.log(`  ${file.getFilePath()}`);
    });
  } else {
    console.log("No import references to update");
  }

  // Create destination directory if needed
  const destDir = path.dirname(destPath);
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    console.log(`Created directory: ${destDir}`);
  }

  // Move file and automatically update all imports
  sourceFile.move(destPath);

  // Save all changes
  await project.save();
  console.log("✓ File moved and imports updated successfully");
}

async function main() {
  const argv = await yargs(process.argv.slice(2))
    .scriptName("move-file")
    .usage("Safely move TypeScript files and update all import references")
    .help()
    .command(
      "$0 <source> <destination>",
      "Move a TypeScript file and update imports",
      (yargs) => {
        yargs
          .positional("source", {
            describe: "Source file path",
            type: "string",
            demandOption: true,
          })
          .positional("destination", {
            describe: "Destination file path",
            type: "string",
            demandOption: true,
          });
      },
    )
    .example(
      "$0 src/game/OldFile.ts src/game/util/NewFile.ts",
      "Move OldFile.ts to util folder",
    )
    .example(
      "$0 src/game/Component.tsx src/game/ui/Component.tsx",
      "Move a React component",
    ).argv;

  try {
    await moveFile(argv.source as string, argv.destination as string);
  } catch (error) {
    console.error("Failed to move file:", error);
    process.exit(1);
  }
}

main();

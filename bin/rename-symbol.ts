#!/usr/bin/env node_modules/.bin/tsx

import { Project } from "ts-morph";
import yargs from "yargs";

async function renameSymbol(filePath: string, oldName: string, newName: string): Promise<void> {
  // Initialize ts-morph project
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
    skipAddingFilesFromTsConfig: false,
  });

  // Get the source file
  const sourceFile = project.getSourceFile(filePath);
  if (!sourceFile) {
    throw new Error(`Source file not found: ${filePath}`);
  }

  console.log(`Searching for symbol "${oldName}" in ${filePath}`);

  // Try to find the symbol in different contexts
  let symbolToRename: any = null;
  let symbolType = "";

  // Check classes
  const classDeclaration = sourceFile.getClass(oldName);
  if (classDeclaration) {
    symbolToRename = classDeclaration;
    symbolType = "class";
  }

  // Check functions
  if (!symbolToRename) {
    const functionDeclaration = sourceFile.getFunction(oldName);
    if (functionDeclaration) {
      symbolToRename = functionDeclaration;
      symbolType = "function";
    }
  }

  // Check variables
  if (!symbolToRename) {
    const variableDeclaration = sourceFile.getVariableDeclaration(oldName);
    if (variableDeclaration) {
      symbolToRename = variableDeclaration;
      symbolType = "variable";
    }
  }

  // Check interfaces
  if (!symbolToRename) {
    const interfaceDeclaration = sourceFile.getInterface(oldName);
    if (interfaceDeclaration) {
      symbolToRename = interfaceDeclaration;
      symbolType = "interface";
    }
  }

  // Check enums
  if (!symbolToRename) {
    const enumDeclaration = sourceFile.getEnum(oldName);
    if (enumDeclaration) {
      symbolToRename = enumDeclaration;
      symbolType = "enum";
    }
  }

  // Check type aliases
  if (!symbolToRename) {
    const typeAlias = sourceFile.getTypeAlias(oldName);
    if (typeAlias) {
      symbolToRename = typeAlias;
      symbolType = "type alias";
    }
  }

  if (!symbolToRename) {
    throw new Error(`Symbol "${oldName}" not found in ${filePath}`);
  }

  console.log(`Found ${symbolType} "${oldName}"`);

  // Find references across the project
  const referencingFiles = new Set<string>();
  
  // For symbols that can be found across files, get referencing source files
  if (symbolToRename.findReferencesAsNodes) {
    const references = symbolToRename.findReferencesAsNodes();
    references.forEach((ref: any) => {
      referencingFiles.add(ref.getSourceFile().getFilePath());
    });
  }

  if (referencingFiles.size > 0) {
    console.log(`Updating references in ${referencingFiles.size} file(s):`);
    referencingFiles.forEach(filePath => {
      console.log(`  ${filePath}`);
    });
  } else {
    console.log("No cross-file references found");
  }

  // Perform the rename
  symbolToRename.rename(newName);

  // Save all changes
  await project.save();
  console.log(`✓ Successfully renamed "${oldName}" to "${newName}"`);
}

async function main() {
  const argv = await yargs(process.argv.slice(2))
    .scriptName("rename-symbol")
    .usage("Rename a symbol (class, function, variable, etc.) and update all references")
    .help()
    .command(
      "$0 <file> <oldName> <newName>",
      "Rename a symbol in a TypeScript file",
      (yargs) => {
        yargs
          .positional("file", {
            describe: "File containing the symbol to rename",
            type: "string",
            demandOption: true,
          })
          .positional("oldName", {
            describe: "Current name of the symbol",
            type: "string",
            demandOption: true,
          })
          .positional("newName", {
            describe: "New name for the symbol",
            type: "string",
            demandOption: true,
          });
      },
    )
    .example(
      "$0 src/game/Player.ts Player GamePlayer",
      "Rename Player class to GamePlayer",
    )
    .example(
      "$0 src/utils/helpers.ts calculateDistance computeDistance",
      "Rename function calculateDistance to computeDistance",
    ).argv;

  try {
    await renameSymbol(argv.file as string, argv.oldName as string, argv.newName as string);
  } catch (error) {
    console.error("Failed to rename symbol:", error);
    process.exit(1);
  }
}

main();
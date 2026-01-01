#!/usr/bin/env node_modules/.bin/tsx

import fs from "fs";
import path from "path";
import { Node, Project } from "ts-morph";
import yargs from "yargs";

async function moveSymbol(
  sourceFile: string,
  symbolName: string,
  destinationFile: string,
): Promise<void> {
  const sourcePath = path.resolve(sourceFile);
  const destPath = path.resolve(destinationFile);

  // Initialize ts-morph project
  const project = new Project({
    tsConfigFilePath: "./tsconfig.json",
    skipAddingFilesFromTsConfig: false,
  });

  // Validate source file
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Source file does not exist: ${sourcePath}`);
  }

  if (![".ts", ".tsx"].some((ext) => sourcePath.endsWith(ext))) {
    throw new Error("Source file must be a TypeScript file (.ts or .tsx)");
  }

  if (![".ts", ".tsx"].some((ext) => destPath.endsWith(ext))) {
    throw new Error("Destination file must be a TypeScript file (.ts or .tsx)");
  }

  // Get the source file
  const sourceFileObj = project.getSourceFile(sourcePath);
  if (!sourceFileObj) {
    throw new Error(`Source file not found in project: ${sourcePath}`);
  }

  console.log(`Searching for symbol "${symbolName}" in ${sourcePath}`);

  // Find the symbol to move
  let symbolToMove: any = null;
  let symbolType = "";

  // Check classes
  const classDeclaration = sourceFileObj.getClass(symbolName);
  if (classDeclaration) {
    symbolToMove = classDeclaration;
    symbolType = "class";
  }

  // Check functions
  if (!symbolToMove) {
    const functionDeclaration = sourceFileObj.getFunction(symbolName);
    if (functionDeclaration) {
      symbolToMove = functionDeclaration;
      symbolType = "function";
    }
  }

  // Check variables
  if (!symbolToMove) {
    const variableDeclaration =
      sourceFileObj.getVariableDeclaration(symbolName);
    if (variableDeclaration) {
      symbolToMove = variableDeclaration.getParent()?.getParent(); // Get the variable statement
      symbolType = "variable";
    }
  }

  // Check interfaces
  if (!symbolToMove) {
    const interfaceDeclaration = sourceFileObj.getInterface(symbolName);
    if (interfaceDeclaration) {
      symbolToMove = interfaceDeclaration;
      symbolType = "interface";
    }
  }

  // Check enums
  if (!symbolToMove) {
    const enumDeclaration = sourceFileObj.getEnum(symbolName);
    if (enumDeclaration) {
      symbolToMove = enumDeclaration;
      symbolType = "enum";
    }
  }

  // Check type aliases
  if (!symbolToMove) {
    const typeAlias = sourceFileObj.getTypeAlias(symbolName);
    if (typeAlias) {
      symbolToMove = typeAlias;
      symbolType = "type alias";
    }
  }

  if (!symbolToMove) {
    throw new Error(`Symbol "${symbolName}" not found in ${sourcePath}`);
  }

  console.log(`Found ${symbolType} "${symbolName}"`);

  // Get the text of the symbol to move
  const symbolText = symbolToMove.getFullText();

  // Handle destination file
  let destFileObj = project.getSourceFile(destPath);
  const destFileExists = fs.existsSync(destPath);

  if (!destFileExists) {
    // Create new file
    console.log(`Creating new file: ${destPath}`);
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
      console.log(`Created directory: ${destDir}`);
    }
    destFileObj = project.createSourceFile(destPath, "");
  } else {
    console.log(`Adding to existing file: ${destPath}`);
  }

  if (!destFileObj) {
    throw new Error(`Could not create or access destination file: ${destPath}`);
  }

  // Copy imports that the symbol might need
  const sourceImports = sourceFileObj.getImportDeclarations();
  const destImports = destFileObj.getImportDeclarations();
  const destImportModules = new Set(
    destImports.map((imp) => imp.getModuleSpecifierValue()),
  );

  // Find which imports might be needed by analyzing the symbol text
  const neededImports = sourceImports.filter((imp) => {
    const namedImports = imp.getNamedImports();
    const defaultImport = imp.getDefaultImport();
    const namespaceImport = imp.getNamespaceImport();

    // Check if any import is referenced in the symbol text
    const importNames = [
      ...namedImports.map((ni) => ni.getName()),
      defaultImport?.getText(),
      namespaceImport?.getText(),
    ].filter(Boolean);

    return importNames.some((name) => symbolText.includes(name!));
  });

  // Add needed imports to destination file
  neededImports.forEach((imp) => {
    const moduleSpec = imp.getModuleSpecifierValue();
    if (!destImportModules.has(moduleSpec)) {
      destFileObj!.addImportDeclaration({
        moduleSpecifier: moduleSpec,
        namedImports: imp.getNamedImports().map((ni) => ni.getName()),
        defaultImport: imp.getDefaultImport()?.getText(),
        namespaceImport: imp.getNamespaceImport()?.getText(),
      });
      console.log(`Added import for: ${moduleSpec}`);
    }
  });

  // Add the symbol to the destination file
  destFileObj.addStatements(symbolText);

  // Remove the symbol from source file
  symbolToMove.remove();

  // Clean up unused imports in source file
  const sourceImportsCopy = [...sourceFileObj.getImportDeclarations()];
  sourceImportsCopy.forEach((imp) => {
    const sourceText = sourceFileObj.getFullText();
    const namedImports = imp.getNamedImports();
    const defaultImport = imp.getDefaultImport();
    const namespaceImport = imp.getNamespaceImport();

    const importNames = [
      ...namedImports.map((ni) => ni.getName()),
      defaultImport?.getText(),
      namespaceImport?.getText(),
    ].filter(Boolean);

    const isUsed = importNames.some((name) => {
      // Create a regex that matches the name as a whole word
      const regex = new RegExp(`\\b${name}\\b`);
      return regex.test(sourceText.replace(imp.getFullText(), ""));
    });

    if (!isUsed) {
      const moduleSpec = imp.getModuleSpecifierValue();
      imp.remove();
      console.log(`Removed unused import: ${moduleSpec}`);
    }
  });

  // Update imports in other files that reference the moved symbol
  console.log(`Updating imports across the project...`);

  // Find all files that import from the source file
  const allFiles = project.getSourceFiles();
  const sourceRelativePath = path.relative(process.cwd(), sourcePath);
  const destRelativePath = path.relative(process.cwd(), destPath);

  allFiles.forEach((file) => {
    if (file === sourceFileObj || file === destFileObj) return;

    const imports = file.getImportDeclarations();
    imports.forEach((imp) => {
      const moduleSpec = imp.getModuleSpecifierValue();
      const resolvedModule = path.resolve(
        path.dirname(file.getFilePath()),
        moduleSpec,
      );

      // Check if this import references our source file
      if (
        resolvedModule === sourcePath ||
        moduleSpec.includes(sourceRelativePath.replace(/\.(ts|tsx)$/, ""))
      ) {
        const namedImports = imp.getNamedImports();
        const defaultImport = imp.getDefaultImport();

        // Check if the moved symbol is imported
        const importsMovedSymbol =
          namedImports.some((ni) => ni.getName() === symbolName) ||
          (defaultImport && defaultImport.getText() === symbolName);

        if (importsMovedSymbol) {
          // Calculate relative path from this file to destination
          const fileDir = path.dirname(file.getFilePath());
          const relativeDestPath = path
            .relative(fileDir, destPath)
            .replace(/\.(ts|tsx)$/, "");
          const normalizedPath = relativeDestPath.startsWith(".")
            ? relativeDestPath
            : `./${relativeDestPath}`;

          // Add import for destination file
          file.addImportDeclaration({
            moduleSpecifier: normalizedPath,
            namedImports: namedImports
              .filter((ni) => ni.getName() === symbolName)
              .map((ni) => ni.getName()),
            defaultImport:
              defaultImport && defaultImport.getText() === symbolName
                ? symbolName
                : undefined,
          });

          // Remove the symbol from the original import
          namedImports.forEach((ni) => {
            if (ni.getName() === symbolName) {
              ni.remove();
            }
          });

          if (defaultImport && defaultImport.getText() === symbolName) {
            imp.removeDefaultImport();
          }

          // Remove the entire import if no imports remain
          if (
            imp.getNamedImports().length === 0 &&
            !imp.getDefaultImport() &&
            !imp.getNamespaceImport()
          ) {
            imp.remove();
          }

          console.log(`Updated imports in: ${file.getFilePath()}`);
        }
      }
    });
  });

  // Save all changes
  await project.save();
  console.log(
    `✓ Successfully moved ${symbolType} "${symbolName}" from ${sourcePath} to ${destPath}`,
  );
}

async function main() {
  const argv = await yargs(process.argv.slice(2))
    .scriptName("move-symbol")
    .usage(
      "Move a symbol (class, function, variable, etc.) from one file to another",
    )
    .help()
    .command(
      "$0 <sourceFile> <symbolName> <destinationFile>",
      "Move a symbol between TypeScript files",
      (yargs) => {
        yargs
          .positional("sourceFile", {
            describe: "File containing the symbol to move",
            type: "string",
            demandOption: true,
          })
          .positional("symbolName", {
            describe: "Name of the symbol to move",
            type: "string",
            demandOption: true,
          })
          .positional("destinationFile", {
            describe: "Destination file (will be created if it doesn't exist)",
            type: "string",
            demandOption: true,
          });
      },
    )
    .example(
      "$0 src/game/Player.ts Player src/game/entities/Player.ts",
      "Move Player class to a new file in entities folder",
    )
    .example(
      "$0 src/utils/helpers.ts calculateDistance src/utils/math.ts",
      "Move calculateDistance function to existing math.ts file",
    ).argv;

  try {
    await moveSymbol(
      argv.sourceFile as string,
      argv.symbolName as string,
      argv.destinationFile as string,
    );
  } catch (error) {
    console.error("Failed to move symbol:", error);
    process.exit(1);
  }
}

main();

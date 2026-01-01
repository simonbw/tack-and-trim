# /bin

Utility scripts.

## `generate-asset-types.ts`

A script to generate typescript declaration (.d.ts) files for assets like images, sounds, and fonts so that they can be imported with type safety.

It also generates a `resources.ts` manifest file that these resources can be easily iterated through.

This script is run with `npm generate-manifest` or `npm watch-manifest`.

## `move-file.ts`

A TypeScript refactoring tool that safely moves TypeScript files and automatically updates all import references across the codebase using ts-morph.

**Features:**
- Moves TypeScript files to new locations
- Automatically updates all import/export statements that reference the moved file
- Calculates correct relative import paths
- Dry-run mode for previewing changes
- Comprehensive validation and error handling

**Usage:**
```bash
# Preview moving a file
npm run move-file src/game/OldFile.ts src/game/util/NewFile.ts --dry-run

# Actually move the file
npm run move-file src/game/OldFile.ts src/game/util/NewFile.ts

# Move with verbose output
npm run move-file src/game/Component.tsx src/game/ui/Component.tsx --verbose
```

**Safety Features:**
- Validates source file exists
- Prevents overwriting existing files
- Creates destination directories as needed
- Dry-run mode shows exactly what changes would be made
- Uses ts-morph for safe AST manipulation

This tool makes large refactoring operations much faster and less error-prone by eliminating the need to manually update import paths throughout the codebase.

## `move-symbol.ts`

A TypeScript refactoring tool that moves a symbol (class, function, variable, interface, enum, or type alias) from one file to another while updating all imports across the codebase.

**Supported Symbol Types:**
- Classes
- Functions
- Variables (const, let, var)
- Interfaces
- Enums
- Type aliases

**Features:**
- Moves the symbol definition to the destination file
- Automatically copies required imports to the destination
- Creates destination file if it doesn't exist
- Cleans up unused imports in the source file
- Updates all import statements across the project that reference the moved symbol

**Usage:**
```bash
# Move a class to a new file
npm run move-symbol src/game/Player.ts Player src/game/entities/Player.ts

# Move a function to an existing file
npm run move-symbol src/utils/helpers.ts calculateDistance src/utils/math.ts

# Move an interface
npm run move-symbol src/types/index.ts GameConfig src/types/config.ts
```

## `rename-symbol.ts`

A TypeScript refactoring tool that renames a symbol and automatically updates all references across the entire codebase using ts-morph.

**Supported Symbol Types:**
- Classes
- Functions
- Variables (const, let, var)
- Interfaces
- Enums
- Type aliases

**Features:**
- Renames the symbol definition
- Finds and updates all references across the project
- Reports which files contain references that will be updated

**Usage:**
```bash
# Rename a class
npm run rename-symbol src/game/Player.ts Player GamePlayer

# Rename a function
npm run rename-symbol src/utils/helpers.ts calculateDistance computeDistance

# Rename a type alias
npm run rename-symbol src/types/index.ts OldTypeName NewTypeName
```

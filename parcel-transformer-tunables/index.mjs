/**
 * Parcel transformer plugin for runtime-tunable values.
 *
 * Scans TypeScript files for `//#tunable` comment annotations above `let`
 * declarations and injects registration calls that wire each variable to
 * the global TunableRegistry via a setter callback.
 *
 * In production builds, this transformer is a no-op — the annotations are
 * just comments and the variables remain plain constants.
 *
 * Source syntax:
 *
 *   //#tunable { min: 0.1, max: 5 }
 *   let ZOOM_SPEED: number = 0.75;
 *
 *   //#tunable("Boat/Physics") { min: 0, max: 10 }
 *   let RUDDER_CHORD: number = 1.5;
 *
 * Dev output (injected after the declaration):
 *
 *   let ZOOM_SPEED: number = 0.75;
 *   (globalThis).__tunableRegistry?.register(
 *     "CameraController/ZOOM_SPEED", 0.75,
 *     { min: 0.1, max: 5 }, (v) => { ZOOM_SPEED = v; });
 */

import { Transformer } from "@parcel/plugin";
import path from "path";

export default new Transformer({
  async transform({ asset, options }) {
    // Only process TypeScript/JavaScript files
    if (!/\.(ts|tsx|js|jsx)$/.test(asset.filePath)) {
      return [asset];
    }

    // In production, tunables are just plain variables — no-op
    if (options.mode === "production") {
      return [asset];
    }

    const code = await asset.getCode();
    if (!code.includes("//#tunable")) {
      return [asset];
    }

    const moduleName = path.basename(
      asset.filePath,
      path.extname(asset.filePath),
    );

    const lines = code.split("\n");
    const result = [];
    let transformed = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Match: //#tunable  or  //#tunable { opts }  or  //#tunable("Group") { opts }
      const tunableMatch = line.match(
        /\/\/#tunable\s*(?:\("([^"]+)"\))?\s*(\{[^}]*\})?\s*$/,
      );

      if (tunableMatch && i + 1 < lines.length) {
        const nextLine = lines[i + 1];

        // Match: let NAME: type = value;  or  let NAME = value;
        const declMatch = nextLine.match(
          /^(\s*)let\s+(\w+)(?:\s*:\s*\w+)?\s*=\s*([^;]+);/,
        );

        if (declMatch) {
          const [, indent, varName, value] = declMatch;
          const explicitGroup = tunableMatch[1];
          const opts = tunableMatch[2] || "{}";
          const group = explicitGroup || moduleName;
          const entryPath = `${group}/${varName}`;

          // Keep the original comment and declaration unchanged
          result.push(line);
          result.push(nextLine);

          // Inject registration call after the declaration
          result.push(
            `${indent}(globalThis as any).__tunableRegistry?.register("${entryPath}", ${value.trim()}, ${opts}, (v: number) => { ${varName} = v; });`,
          );

          transformed = true;
          i++; // Skip the declaration line (already pushed)
          continue;
        }
      }

      result.push(line);
    }

    if (transformed) {
      asset.setCode(result.join("\n"));
    }

    return [asset];
  },
});

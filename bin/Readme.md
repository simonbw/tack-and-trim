# /bin

Utility scripts.

## `generate-asset-types.ts`

A script to generate typescript declaration (.d.ts) files for assets like images, sounds, and fonts so that they can be imported with type safety.

It also generates a `resources.ts` manifest file that these resources can be easily iterated through.

This script is run with `npm generate-manifest` or `npm watch-manifest`.

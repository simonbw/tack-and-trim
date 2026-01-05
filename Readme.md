# Tack and Trim

A game by Simon, built on a custom game engine.

## How to run locally

1. Make sure you have a recent version of [node.js](https://nodejs.org/en) installed
2. Clone this repo
3. Run `npm install` inside this repo
4. Run `npm start` to start the dev server
5. You should now be able to play the game at http://localhost:1234

## Structure of this project

### `src/`

The folder where all our source code (TypeScript) goes.

- `src/index.html` — This is the entrypoint to our code from the browser.
  This file then imports `src/game/index.tsx` which is the entrypoint to our typescript code.

- `src/core/` — This is the engine code that I (Simon) have built up over many years and games.
  See [src/core](src/core/) for more details about the engine.

- `src/game/`
  This is where our game's code lives.
  Basically all the code you'll be writing will probably live in here.

- `src/game/index.tsx` — The entrypoint for our TypeScript code on the page. All our code that runs can eventually be traced up to this file.

### `dist/`

This is where our compiled game goes.
You shouldn't need to poke around in here.

### `resources/`

This is where all of our assets like images, sound effects, music, fonts, etc. go.
The build system watches this folder for added/removed files and generates `.d.ts` files that make typescript aware that it can import these files. It also generates `resources.ts`, which contains lists of all the resources that we use to automatically preload them.

- `resources/audio` — This is where all of our audio files go.
- `resources/images` — This is where all of our images go.
- `resources/fonts` — This is where all of our fonts go.

## Technologies Used

This game is built on an engine I have cobbled together over the years.
There are a few big libraries in it that do the heavy lifting.

### TypeScript

The code for this project is written in [TypeScript](https://www.typescriptlang.org/), a superset of JavaScript that adds static type analysis.

### Pixi.js

This game uses a 2d rendering engine called [Pixi.js](https://pixijs.com/).

### Physics Engine

This game uses a custom 2D physics engine built specifically for this project. It features rigid body dynamics, constraint solving, collision detection, and more. See [src/core/physics/](src/core/physics/) for documentation.

### Parcel

This project uses [Parcel](https://parceljs.org/) as the bundler and dev server.
It handles everything with almost zero configuration and tends to _just work_.
Hopefully you shouldn't have to mess with this.

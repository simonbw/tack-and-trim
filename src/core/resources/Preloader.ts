import * as Pixi from "pixi.js";
import { ReactElement } from "react";
import { SoundName } from "../../../resources/resources";
import Game from "../Game";
import { ReactEntity } from "../ReactEntity";
import BaseEntity from "../entity/BaseEntity";
import Entity from "../entity/Entity";
import { getBiggestSounds, getTotalSoundBytes, loadSound } from "./sounds";

export type ResourceManifest = {
  images: { [name: string]: string };
  sounds: { [name: string]: string };
  fonts: { [name: string]: string };
};

interface RenderInfo {
  fonts: { loaded: number; total: number };
  images: { loaded: number; total: number };
  sounds: { loaded: number; total: number };
}

/**
 * A React-enabled asset preloader that loads images, sounds, and fonts
 * with progress tracking. Provides real-time loading feedback through
 * React UI components and resolves when all assets are ready.
 */
export default class ReactPreloader extends BaseEntity implements Entity {
  private _resolve!: () => void;
  private _promise!: Promise<void>;

  private progress: RenderInfo = {
    fonts: {
      loaded: 0,
      total: 0,
    },
    images: {
      loaded: 0,
      total: 0,
    },
    sounds: {
      loaded: 0,
      total: 0,
    },
  };

  constructor(
    private manifest: ResourceManifest,
    reactRender: (props: RenderInfo) => ReactElement
  ) {
    super();

    this._promise = new Promise((resolve) => {
      this._resolve = resolve;
    });

    this.addChild(new ReactEntity(() => reactRender(this.progress)));
  }

  async onAdd({ game }: { game: Game }) {
    await Promise.all([
      this.loadFonts(),
      this.loadSounds(game.audio),
      this.loadImages(),
    ]);
    const bytes = getTotalSoundBytes();

    console.groupCollapsed(
      `Audio Loaded: ${(bytes / 2 ** 20).toFixed(1)}MB total`
    );

    getBiggestSounds()
      .slice(0, 5)
      .forEach(([url, size]) =>
        console.info(url, "\n", `${(size / 1024).toFixed(1)}kB`)
      );

    console.groupEnd();
    this._resolve();
  }

  waitTillLoaded() {
    return this._promise;
  }

  async loadFonts() {
    this.progress.fonts.total = Object.values(this.manifest.fonts).length;
    this.progress.fonts.loaded = 0;

    try {
      await Promise.all(
        Object.entries(this.manifest.fonts).map(async ([name, src]) => {
          const fontFace = new FontFace(name, `url(${src})`);
          document.fonts.add(await fontFace.load());
          this.progress.fonts.loaded += 1;
        })
      );
    } catch (e) {
      console.error("Fonts failed to load", e);
    }
  }

  async loadSounds(audioContext: AudioContext) {
    this.progress.sounds.loaded = 0;
    this.progress.sounds.total = Object.values(this.manifest.sounds).length;

    await Promise.all(
      Object.entries(this.manifest.sounds).map(async ([name, url]) => {
        try {
          await loadSound(name as SoundName, url, audioContext);
        } catch (e) {
          console.warn(`Sound failed to load: ${url}, ${url}`, e);
        }
        this.progress.sounds.loaded += 1;
      })
    );
  }

  async loadImages() {
    this.progress.images.loaded = 0;
    this.progress.images.total = Object.values(this.manifest.images).length;

    Pixi.Assets.addBundle("images", this.manifest.images);

    try {
      await Pixi.Assets.loadBundle("images", (progressPercent) => {
        this.progress.images.loaded += 1;
      });
    } catch (e) {
      console.error("Images failed to load", e);
    }
  }

  onDestroy() {
    document.getElementById("preloader")?.remove();
  }
}

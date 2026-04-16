import { render, VNode } from "preact";
import { LayerName } from "../config/layers";
import { BaseEntity } from "./entity/BaseEntity";
import Entity, { GameEventMap } from "./entity/Entity";
import { on } from "./entity/handler";

/** Useful for rendering preact to the screen when you want it */
export class ReactEntity extends BaseEntity implements Entity {
  layer: LayerName = "hud";
  el!: HTMLDivElement;

  constructor(
    public getReactContent: () => VNode | null,
    public autoRender = true,
  ) {
    super();
  }

  reactRender() {
    render(this.getReactContent(), this.el);
  }

  @on("render")
  onRender({}: { dt: number }) {
    if (this.autoRender) {
      this.reactRender();
    }
  }

  @on("add")
  onAdd() {
    this.el = document.createElement("div");
    document.body.append(this.el);
  }

  @on("destroy")
  onDestroy(_data: GameEventMap["destroy"]) {
    render(null, this.el);
    this.el.remove();
  }
}

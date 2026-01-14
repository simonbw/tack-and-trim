import { render, VNode } from "preact";
import BaseEntity from "./entity/BaseEntity";
import Entity from "./entity/Entity";

/** Useful for rendering preact to the screen when you want it */
export class ReactEntity extends BaseEntity implements Entity {
  el!: HTMLDivElement;

  constructor(
    public getReactContent: () => VNode,
    public autoRender = true,
  ) {
    super();
  }

  reactRender() {
    render(this.getReactContent(), this.el);
  }

  onRender({}: { dt: number }) {
    if (this.autoRender) {
      this.reactRender();
    }
  }

  onAdd() {
    this.el = document.createElement("div");
    document.body.append(this.el);
  }

  onDestroy() {
    render(null, this.el);
    this.el.remove();
  }
}

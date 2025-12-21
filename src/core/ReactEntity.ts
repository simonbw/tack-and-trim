import React from "react";
import { createRoot, Root } from "react-dom/client";
import BaseEntity from "./entity/BaseEntity";
import Entity from "./entity/Entity";

/** Useful for rendering react to the screen when you want it */
export class ReactEntity extends BaseEntity implements Entity {
  el!: HTMLDivElement;

  reactRoot!: Root;

  constructor(
    public getReactContent: () => React.ReactElement,
    public autoRender = true
  ) {
    super();
  }

  reactRender() {
    this.reactRoot?.render(this.getReactContent());
  }

  onRender() {
    if (this.autoRender) {
      this.reactRender();
    }
  }

  onAdd() {
    this.el = document.createElement("div");
    document.body.append(this.el);
    this.reactRoot = createRoot(this.el);
  }

  onDestroy() {
    this.el.remove();
    this.reactRoot.unmount();
  }
}

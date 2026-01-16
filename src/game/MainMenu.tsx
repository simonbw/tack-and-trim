import { ReactEntity } from "../core/ReactEntity";
import { on } from "../core/entity/handler";
import { KeyCode } from "../core/io/Keys";
import "./MainMenu.css";

export class MainMenu extends ReactEntity {
  constructor() {
    super(() => (
      <div class="main-menu">
        <div class="main-menu__title">Tack & Trim</div>
        <div class="main-menu__prompt">Press Enter to Start</div>
      </div>
    ));
  }

  @on("keyDown")
  onKeyDown({ key }: { key: KeyCode }) {
    if (key === "Enter" || key === "Space") {
      this.game!.dispatch("gameStart", {});
      this.destroy();
    }
  }
}

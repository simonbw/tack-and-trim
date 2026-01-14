import { render } from "preact";
import { EntityStudioApp } from "./EntityStudioApp";

const root = document.createElement("div");
document.body.appendChild(root);
render(<EntityStudioApp />, root);

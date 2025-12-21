import React from "react";
import { createRoot } from "react-dom/client";
import { EntityStudioApp } from "./EntityStudioApp";

const root = document.createElement("div");
document.body.appendChild(root);
createRoot(root).render(<EntityStudioApp />);

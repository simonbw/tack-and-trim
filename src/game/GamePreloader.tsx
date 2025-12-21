import React from "react";
import { RESOURCES } from "../../resources/resources.ts";
import ReactPreloader from "../core/resources/Preloader.ts";

export const GamePreloader = new ReactPreloader(
  RESOURCES,
  ({ fonts, images, sounds }) => (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        padding: "8rem",
        position: "absolute",
        inset: 0,
      }}
    >
      <div
        style={{
          color: "white",
          display: "flex",
          flexDirection: "column",
          fontFamily: `monospace`,
          fontSize: "1.5rem",
          gap: "1rem",
        }}
      >
        <span
          style={{
            fontFamily: `monospace`,
            fontSize: "2em",
          }}
        >
          Loading...
        </span>
        <label>
          <span>fonts</span>
          <progress
            style={{ display: "block" }}
            value={fonts.loaded}
            max={fonts.total}
          />
        </label>
        <label>
          <span>images</span>
          <progress
            style={{ display: "block" }}
            value={images.loaded}
            max={images.total}
          />
        </label>
        <label>
          <span>sounds</span>
          <progress
            style={{ display: "block" }}
            value={sounds.loaded}
            max={sounds.total}
          />
        </label>
      </div>
    </div>
  )
);

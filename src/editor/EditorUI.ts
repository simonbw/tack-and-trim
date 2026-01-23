/**
 * Editor UI entity.
 *
 * Renders the editor toolbar and panels using React/Preact.
 */

import { ReactEntity } from "../core/ReactEntity";
import { EditorController } from "./EditorController";
import { EditorDocument } from "./EditorDocument";
import { EditorToolbar } from "./ui/EditorToolbar";
import { ContourPanel } from "./ui/ContourPanel";
import { h, Fragment } from "preact";

export class EditorUI extends ReactEntity {
  constructor(
    private editorDoc: EditorDocument,
    private controller: EditorController,
  ) {
    super(
      () =>
        h(
          Fragment,
          null,
          h(EditorToolbar, {
            document: this.editorDoc,
            controller: this.controller,
          }),
          h(ContourPanel, { document: this.editorDoc }),
        ),
      true,
    );
  }
}

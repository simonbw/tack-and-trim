import { ContactMaterial, Material } from "p2";
import { objectEntries } from "../core/util/ObjectUtils";

export const Materials = {
  Wall: new Material(),
  Ball: new Material(),
  Peg: new Material(),
} as const;

const MaterialToName: { [id: number]: keyof typeof Materials } =
  Object.fromEntries(
    objectEntries(Materials).map(([name, material]) => [material.id, name])
  );

export function getMaterialName(material: Material): string {
  return MaterialToName[material.id];
}

// TODO: Make an editor for this
export const ContactMaterials: ReadonlyArray<ContactMaterial> = [
  new ContactMaterial(Materials.Ball, Materials.Ball, { restitution: 0.8 }),
  new ContactMaterial(Materials.Ball, Materials.Wall, { restitution: 0.8 }),
  new ContactMaterial(Materials.Ball, Materials.Peg, { restitution: 0.8 }),
];

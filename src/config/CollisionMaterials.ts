import { ContactMaterial, Material } from "../core/physics";
import { objectEntries } from "../core/util/ObjectUtils";

export const Materials = {
  Boat: new Material(),
} as const;

const MaterialToName: { [id: number]: keyof typeof Materials } =
  Object.fromEntries(
    objectEntries(Materials).map(([name, material]) => [material.id, name])
  );

export function getMaterialName(material: Material): string {
  return MaterialToName[material.id];
}

export const ContactMaterials: ReadonlyArray<ContactMaterial> = [
  new ContactMaterial(Materials.Boat, Materials.Boat, { restitution: 0.8 }),
];

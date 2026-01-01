/** Defines a physics material. */
export default class Material {
  static idCounter = 0;

  /** The material identifier */
  id: number;

  constructor(id?: number) {
    this.id = id ?? Material.idCounter++;
  }
}

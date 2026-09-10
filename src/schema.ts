import { Schema, MapSchema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") name: string = "Invitado";
  @type("string") body: string = "#3b82f6";
  @type("string") head: string = "#fbbf24";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;
  @type("number") rotY: number = 0;
  @type("boolean") moving: boolean = false;
}

export class VerseState extends Schema {
  // Timestamp de creación de la sala. Los clientes lo usan para
  // sincronizar eventos globales (ej. altura de la lava).
  @type("number") startedAt: number = 0;
  @type({ map: Player }) players = new MapSchema<Player>();
}

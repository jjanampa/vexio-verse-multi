import { Schema, MapSchema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") name: string = "Invitado";
  @type("string") body: string = "#3b82f6";
  @type("string") head: string = "#fbbf24";
  @type("string") pants: string = "#a4bd47";
  /** cosméticos equipados (ids de la tienda): 'auto' | 'none' | id */
  @type("string") hat: string = "";
  @type("string") back: string = "";
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("number") z: number = 0;
  @type("number") rotY: number = 0;
  @type("boolean") moving: boolean = false;
  // Campos de ronda (solo sala lava)
  @type("boolean") alive: boolean = true;
  @type("boolean") spectator: boolean = false;
  @type("number") score: number = 0;
  @type("number") wins: number = 0;
  @type("number") place: number = 0;
}

export class VerseState extends Schema {
  // Timestamp de creación de la sala. Los clientes lo usan para
  // sincronizar eventos globales (altura de la lava) en salas antiguas.
  @type("number") startedAt: number = 0;
  // Ronda de lava: lobby -> countdown -> running -> result
  @type("string") phase: string = "idle";
  @type("number") phaseEndsAt: number = 0;
  @type("number") roundStartedAt: number = 0;
  @type("number") round: number = 0;
  @type("number") aliveCount: number = 0;
  @type("number") roundPlayers: number = 0;
  // Desastres: catástrofe de la ronda en curso
  @type("string") disaster: string = "";
  @type({ map: Player }) players = new MapSchema<Player>();
}

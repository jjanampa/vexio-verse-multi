import { Room, Client } from "@colyseus/core";
import { Player, VerseState } from "./schema";

const HEX = /^#[0-9a-fA-F]{6}$/;
const clampNum = (v: unknown, min: number, max: number, fb: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fb;

const MOVE_BUDGET = 40; // mensajes de movimiento por segundo
const CHAT_COOLDOWN_MS = 1000;

// Registro de salas vivas para el endpoint /players de la página de inicio
export const liveRooms = new Set<VerseRoom>();

interface MoveMsg {
  x?: unknown;
  y?: unknown;
  z?: unknown;
  rotY?: unknown;
  moving?: unknown;
}

// Una misma clase para los 8 modos: sincroniza presencia y movimiento.
// La simulación sigue siendo cliente (MVP). LavaRoom añade rondas.
export class VerseRoom extends Room<VerseState> {
  maxClients = 16;
  private chatAt = new Map<string, number>();
  private moveWindow = new Map<string, { start: number; count: number }>();

  onCreate() {
    this.setState(new VerseState());
    this.state.startedAt = Date.now();
    liveRooms.add(this);

    this.onMessage("sync-request", (client: Client) => {
      client.send("sync", { now: Date.now() });
    });

    this.onMessage("move", (client: Client, data: MoveMsg) => {
      if (!this.allowMove(client)) return;
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof data !== "object" || data === null) return;
      p.x = clampNum(data.x, -300, 300, p.x);
      p.y = clampNum(data.y, -50, 200, p.y);
      p.z = clampNum(data.z, -300, 300, p.z);
      p.rotY = clampNum(data.rotY, -Math.PI * 2, Math.PI * 2, p.rotY);
      p.moving = data.moving === true;
    });

    this.onMessage("chat", (client: Client, data: { text?: unknown }) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const now = Date.now();
      const last = this.chatAt.get(client.sessionId) ?? 0;
      if (now - last < CHAT_COOLDOWN_MS) return;
      const text = String((data as { text?: unknown })?.text ?? "").trim().slice(0, 60);
      if (!text) return;
      this.chatAt.set(client.sessionId, now);
      this.broadcast("chat", { id: client.sessionId, name: p.name, text });
    });
  }

  private allowMove(client: Client): boolean {
    const now = Date.now();
    const w = this.moveWindow.get(client.sessionId);
    if (!w || now - w.start > 1000) {
      this.moveWindow.set(client.sessionId, { start: now, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= MOVE_BUDGET;
  }

  onJoin(client: Client, options: Record<string, unknown> = {}) {
    const p = new Player();
    p.name = String(options.name ?? "Invitado").slice(0, 16) || "Invitado";
    const body = String(options.body ?? "");
    const head = String(options.head ?? "");
    p.body = HEX.test(body) ? body : "#3b82f6";
    p.head = HEX.test(head) ? head : "#fbbf24";
    p.x = clampNum(options.x, -300, 300, 0);
    p.y = clampNum(options.y, -50, 200, 0);
    p.z = clampNum(options.z, -300, 300, 0);
    this.state.players.set(client.sessionId, p);
    // Reloj del servidor para corregir desfases de hora en los clientes
    client.send("sync", { now: Date.now() });
    console.log(`join ${this.roomName} ${client.sessionId} (${p.name}) -> ${this.state.players.size}`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.chatAt.delete(client.sessionId);
    this.moveWindow.delete(client.sessionId);
    console.log(`leave ${this.roomName} ${client.sessionId} -> ${this.state.players.size}`);
  }

  onDispose() {
    liveRooms.delete(this);
  }
}

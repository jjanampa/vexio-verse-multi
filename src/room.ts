import { Room, Client } from "@colyseus/core";
import { Player, VerseState } from "./schema";

const HEX = /^#[0-9a-fA-F]{6}$/;
const clampNum = (v: unknown, min: number, max: number, fb: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fb;

interface MoveMsg {
  x?: unknown;
  y?: unknown;
  z?: unknown;
  rotY?: unknown;
  moving?: unknown;
}

// Una misma clase para los 3 modos: solo sincroniza presencia y
// movimiento. La simulación sigue siendo cliente (MVP).
export class VerseRoom extends Room<VerseState> {
  maxClients = 16;

  onCreate() {
    this.setState(new VerseState());
    this.state.startedAt = Date.now();

    this.onMessage("move", (client: Client, data: MoveMsg) => {
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
      const text = String((data as { text?: unknown })?.text ?? "").trim().slice(0, 60);
      if (!text) return;
      this.broadcast("chat", { id: client.sessionId, name: p.name, text });
    });
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
    console.log(`join ${this.roomName} ${client.sessionId} (${p.name}) -> ${this.state.players.size}`);
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    console.log(`leave ${this.roomName} ${client.sessionId} -> ${this.state.players.size}`);
  }
}

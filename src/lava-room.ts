import { Client } from "@colyseus/core";
import { VerseRoom } from "./room";

export const LOBBY_MS = 5000;
export const COUNTDOWN_MS = 3000;
export const ROUND_MS = 60000;
export const RESULT_MS = 8000;
export const MAX_SCORE = ROUND_MS / 1000;

interface DiedMsg {
  secs?: unknown;
}

interface RankEntry {
  id: string;
  name: string;
  score: number;
  place: number;
  alive: boolean;
}

// Sala de lava con rondas: lobby -> cuenta atrás 3-2-1 -> ronda 60s -> ranking.
// El servidor manda el reloj y los tiempos; el cliente simula su personaje y
// avisa con "died" al caer. Los que entran a mitad de ronda miran hasta la
// siguiente (evita morir al instante porque la lava ya esté alta).
export class LavaRoom extends VerseRoom {
  maxClients = 16;
  private roundIds = new Set<string>();

  onCreate() {
    super.onCreate();
    const st = this.state;
    st.phase = "lobby";
    st.phaseEndsAt = Date.now() + LOBBY_MS;
    this.onMessage("died", (client: Client, data: DiedMsg) => this.onDied(client, data));
    this.setSimulationInterval(() => this.roundTick(), 200);
  }

  onJoin(client: Client, options: Record<string, unknown> = {}) {
    super.onJoin(client, options);
    const p = this.state.players.get(client.sessionId);
    if (p && this.state.phase === "running") {
      p.alive = false;
      p.spectator = true;
      p.score = 0;
    }
  }

  onLeave(client: Client, consented?: boolean) {
    const p = this.state.players.get(client.sessionId);
    const wasRound = p?.alive === true && this.roundIds.has(client.sessionId);
    this.roundIds.delete(client.sessionId);
    void consented;
    super.onLeave(client);
    if (wasRound) this.maybeEndRound();
  }

  private countAlive(): number {
    let n = 0;
    this.state.players.forEach((p) => {
      if (p.alive) n++;
    });
    return n;
  }

  private resetPlayers() {
    this.state.players.forEach((p) => {
      p.alive = true;
      p.spectator = false;
      p.score = 0;
      p.place = 0;
    });
  }

  private roundTick() {
    const st = this.state;
    const now = Date.now();

    if (st.players.size === 0) {
      if (st.phase !== "lobby") st.phase = "lobby";
      st.aliveCount = 0;
      st.phaseEndsAt = now + LOBBY_MS;
      return;
    }

    switch (st.phase) {
      case "lobby":
        if (now >= st.phaseEndsAt) {
          this.resetPlayers();
          st.phase = "countdown";
          st.phaseEndsAt = now + COUNTDOWN_MS;
        }
        break;
      case "countdown":
        if (now >= st.phaseEndsAt) {
          st.phase = "running";
          st.round++;
          st.roundStartedAt = now;
          st.phaseEndsAt = now + ROUND_MS;
          st.roundPlayers = st.players.size;
          st.aliveCount = st.players.size;
          this.roundIds = new Set(st.players.keys());
        }
        break;
      case "running":
        st.aliveCount = this.countAlive();
        if (now >= st.phaseEndsAt) this.endRound();
        else this.maybeEndRound();
        break;
      case "result":
        if (now >= st.phaseEndsAt) {
          this.resetPlayers();
          st.phase = "lobby";
          st.phaseEndsAt = now + LOBBY_MS;
        }
        break;
    }
  }

  private onDied(client: Client, data: DiedMsg) {
    const st = this.state;
    const p = st.players.get(client.sessionId);
    if (!p || st.phase !== "running" || !p.alive) return;
    p.alive = false;
    p.spectator = false;
    const secs = typeof data?.secs === "number" && Number.isFinite(data.secs) ? data.secs : 0;
    p.score = Math.max(0, Math.min(MAX_SCORE, secs));
    this.maybeEndRound();
  }

  // Cierra la ronda antes de tiempo si ya no queda nadie en pie
  // (o solo uno, habiendo empezado más de uno).
  private maybeEndRound() {
    const st = this.state;
    if (st.phase !== "running") return;
    const alive = this.countAlive();
    st.aliveCount = alive;
    const total = st.roundPlayers;
    if ((alive === 0 && total >= 1) || (alive <= 1 && total >= 2)) this.endRound();
  }

  private endRound() {
    const st = this.state;
    if (st.phase !== "running") return;
    const now = Date.now();
    const entries: RankEntry[] = [];
    this.roundIds.forEach((id) => {
      const p = st.players.get(id);
      if (!p) return;
      entries.push({
        id,
        name: p.name,
        score: p.alive ? MAX_SCORE : Math.min(p.score, MAX_SCORE),
        place: 0,
        alive: p.alive,
      });
    });
    entries.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    entries.forEach((e, i) => {
      e.place = i + 1;
      const p = st.players.get(e.id);
      if (p) {
        p.place = e.place;
        p.score = e.score;
      }
    });
    // Victoria solo si la ronda tuvo al menos 2 jugadores
    const winner = entries[0];
    if (winner && st.roundPlayers >= 2) {
      const wp = st.players.get(winner.id);
      if (wp && winner.alive) wp.wins++;
    }
    st.phase = "result";
    st.phaseEndsAt = now + RESULT_MS;
    st.aliveCount = entries.filter((e) => e.alive).length;
    this.broadcast("roundOver", { round: st.round, ranking: entries });
  }
}

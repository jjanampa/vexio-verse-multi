import { Client } from "@colyseus/core";
import { VerseRoom } from "./room";

export const LOBBY_MS = 8000;
export const COUNTDOWN_MS = 3000;
export const ROUND_MS = 90000;
export const RESULT_MS = 8000;
const MAX_SCORE = ROUND_MS / 1000;

export type MmRole = "murderer" | "sheriff" | "innocent";

interface HitMsg {
  target?: unknown;
}

// Murder Mystery: el servidor reparte roles secretos (por mensajes privados),
// valida los golpes (cuchillo/pistola), revela roles al morir y cierra la ronda.
export class MurderRoom extends VerseRoom {
  maxClients = 16;
  private roles = new Map<string, MmRole>();
  private gunOwner: string | null = null;
  private roundIds = new Set<string>();
  private solo = false;
  private over = false;
  private winner = "";

  onCreate() {
    super.onCreate();
    this.state.phase = "lobby";
    this.state.phaseEndsAt = Date.now() + LOBBY_MS;
    this.onMessage("hit", (client: Client, data: HitMsg) => this.onHit(client, data));
    this.setSimulationInterval(() => this.tick(), 200);
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
    const wasRound = this.roundIds.has(client.sessionId);
    this.roles.delete(client.sessionId);
    if (this.gunOwner === client.sessionId) this.gunOwner = null;
    this.roundIds.delete(client.sessionId);
    void consented;
    super.onLeave(client);
    if (wasRound && this.state.phase === "running" && !this.solo && !this.over) {
      if (![...this.roles.values()].includes("murderer")) this.endRound("innocents");
      else this.checkEnd();
    }
  }

  private count(pred: (role: MmRole) => boolean): number {
    let n = 0;
    for (const [id, role] of this.roles) {
      const p = this.state.players.get(id);
      if (p?.alive && pred(role)) n++;
    }
    return n;
  }

  private tick() {
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
          st.phase = "countdown";
          st.phaseEndsAt = now + COUNTDOWN_MS;
        }
        break;
      case "countdown":
        if (now >= st.phaseEndsAt) this.startRound(now);
        break;
      case "running":
        st.aliveCount = this.count(() => true);
        if (now >= st.phaseEndsAt) this.endRound("innocents", "time");
        break;
      case "result":
        if (now >= st.phaseEndsAt) {
          st.phase = "lobby";
          st.phaseEndsAt = now + LOBBY_MS;
        }
        break;
    }
  }

  private startRound(now: number) {
    const st = this.state;
    const ids = [...st.players.keys()];
    st.phase = "running";
    st.round++;
    st.roundStartedAt = now;
    st.phaseEndsAt = now + ROUND_MS;
    st.roundPlayers = ids.length;
    st.aliveCount = ids.length;
    this.roles.clear();
    this.roundIds = new Set(ids);
    this.over = false;
    this.winner = "";
    st.players.forEach((p) => {
      p.alive = true;
      p.spectator = false;
      p.score = 0;
      p.place = 0;
    });
    this.solo = ids.length === 1;
    if (this.solo) {
      this.roles.set(ids[0], "sheriff");
      this.gunOwner = ids[0];
      this.sendRole(ids[0], { role: "sheriff", solo: true });
      this.broadcast("roundStart", { solo: true });
      return;
    }
    const shuffled = [...ids].sort(() => Math.random() - 0.5);
    shuffled.forEach((id, i) => {
      const role: MmRole = i === 0 ? "murderer" : i === 1 ? "sheriff" : "innocent";
      this.roles.set(id, role);
      this.sendRole(id, { role, solo: false });
    });
    this.gunOwner = shuffled[1] ?? null;
    this.broadcast("roundStart", { solo: false, players: ids.length });
  }

  private sendRole(id: string, payload: { role: MmRole; solo: boolean }) {
    const client = this.clients.find((c) => c.sessionId === id);
    client?.send("role", payload);
  }

  private onHit(client: Client, data: HitMsg) {
    const st = this.state;
    if (st.phase !== "running" || this.over) return;
    const attacker = client.sessionId;
    const role = this.roles.get(attacker);
    if (!role) return;
    const target = String(data?.target ?? "");
    if (this.solo) {
      if (role === "sheriff" && target === "bot") {
        const p = st.players.get(attacker);
        if (p) p.score = Math.round((Date.now() - st.roundStartedAt) / 1000);
        this.broadcast("killed", { id: "bot", role: "murderer", by: "gun" });
        this.endRound("innocents", "bot");
      }
      return;
    }
    const tp = st.players.get(target);
    if (!tp || !tp.alive || target === attacker) return;
    if (role === "murderer") {
      tp.alive = false;
      tp.spectator = false;
      this.broadcast("killed", { id: target, role: this.roles.get(target) ?? "innocent", by: "knife" });
      this.checkEnd();
    } else if (role === "sheriff" && this.gunOwner === attacker) {
      this.gunOwner = null;
      tp.alive = false;
      tp.spectator = false;
      const tRole = this.roles.get(target) ?? "innocent";
      this.broadcast("killed", { id: target, role: tRole, by: "gun" });
      if (tRole === "murderer") this.endRound("innocents");
      else this.checkEnd();
    }
  }

  private checkEnd() {
    const st = this.state;
    if (st.phase !== "running" || this.over) return;
    const murdererAlive = this.count((r) => r === "murderer") > 0;
    const othersAlive = this.count((r) => r !== "murderer") > 0;
    if (!murdererAlive) this.endRound("innocents");
    else if (!othersAlive) this.endRound("murderer");
  }

  private endRound(winner: "innocents" | "murderer", reason = "") {
    const st = this.state;
    if (st.phase !== "running") return;
    this.over = true;
    this.winner = winner;
    const entries = [...this.roundIds]
      .map((id) => {
        const p = st.players.get(id);
        return {
          id,
          name: p?.name ?? "?",
          role: this.roles.get(id) ?? ("innocent" as MmRole),
          alive: !!p?.alive,
          score: p?.alive ? MAX_SCORE : Math.min(p?.score ?? 0, MAX_SCORE),
        };
      })
      .sort((a, b) => Number(b.alive) - Number(a.alive) || b.score - a.score);
    const winnerRole: MmRole = winner === "murderer" ? "murderer" : "innocent";
    entries.forEach((e, i) => {
      const p = st.players.get(e.id);
      if (p) {
        p.place = i + 1;
        p.score = e.score;
        if (!p.alive) p.spectator = false;
        if (e.role === winnerRole || (winner === "innocents" && e.role !== "murderer")) p.wins++;
      }
    });
    st.phase = "result";
    st.phaseEndsAt = Date.now() + RESULT_MS;
    st.aliveCount = entries.filter((e) => e.alive).length;
    this.broadcast("roundOver", { round: st.round, winner, reason, roles: entries });
  }
}

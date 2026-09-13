import http from "node:http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { VerseRoom, liveRooms } from "./room";
import { LavaRoom } from "./lava-room";
import { DisasterRoom } from "./disaster-room";
import { MurderRoom } from "./mm-room";
import { handleParty, setRoomExists, partyCount } from "./party";
import { handleUgc, ugcCount } from "./ugc";

const port = Number(process.env.PORT || 2567);

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  try {
    if (await handleParty(req, res, url)) return;
    if (await handleUgc(req, res, url)) return;
  } catch (err) {
    console.error("http error", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "error interno" }));
    }
    return;
  }

  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        rooms: ["hub", "obby", "lava", "tycoon", "racing", "survival", "horror", "city", "disaster", "mm", "garden"],
        parties: partyCount(),
        ugcMaps: ugcCount(),
      }),
    );
    return;
  }
  // Jugadores en línea por sala (lo usa la página de inicio)
  if (req.url === "/players" || req.url?.startsWith("/players?")) {
    const rooms: Record<string, { name: string; body: string; head: string; pants: string; hat: string; back: string }[]> = {};
    let total = 0;
    for (const room of liveRooms) {
      const list: { name: string; body: string; head: string; pants: string; hat: string; back: string }[] = [];
      try {
        room.state.players.forEach((p) => list.push({ name: p.name, body: p.body, head: p.head, pants: p.pants, hat: p.hat, back: p.back }));
      } catch {
        /* sala cerrándose */
      }
      if (list.length > 0) {
        rooms[room.roomName] = list;
        total += list.length;
      }
    }
    res.writeHead(200, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify({ ok: true, total, rooms }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

setRoomExists((roomId, mode) => {
  for (const room of liveRooms) {
    if (room.roomId === roomId && room.roomName === mode) return true;
  }
  return false;
});

gameServer.define("hub", VerseRoom);
gameServer.define("obby", VerseRoom);
gameServer.define("lava", LavaRoom);
gameServer.define("tycoon", VerseRoom);
gameServer.define("racing", VerseRoom);
gameServer.define("survival", VerseRoom);
gameServer.define("horror", VerseRoom);
gameServer.define("city", VerseRoom);
gameServer.define("disaster", DisasterRoom);
gameServer.define("mm", MurderRoom);
gameServer.define("garden", VerseRoom);

gameServer.listen(port).then(() => {
  console.log(`vexio-verse-multi listo en :${port}`);
});

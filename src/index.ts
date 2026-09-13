import http from "node:http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { VerseRoom, liveRooms } from "./room";
import { LavaRoom } from "./lava-room";
import { DisasterRoom } from "./disaster-room";

const port = Number(process.env.PORT || 2567);

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: ["hub", "obby", "lava", "tycoon", "racing", "survival", "horror", "city", "disaster"] }));
    return;
  }
  // Jugadores en línea por sala (lo usa la página de inicio)
  if (req.url === "/players" || req.url?.startsWith("/players?")) {
    const rooms: Record<string, { name: string; body: string; head: string }[]> = {};
    let total = 0;
    for (const room of liveRooms) {
      const list: { name: string; body: string; head: string }[] = [];
      try {
        room.state.players.forEach((p) => list.push({ name: p.name, body: p.body, head: p.head }));
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

gameServer.define("hub", VerseRoom);
gameServer.define("obby", VerseRoom);
gameServer.define("lava", LavaRoom);
gameServer.define("tycoon", VerseRoom);
gameServer.define("racing", VerseRoom);
gameServer.define("survival", VerseRoom);
gameServer.define("horror", VerseRoom);
gameServer.define("city", VerseRoom);
gameServer.define("disaster", DisasterRoom);

gameServer.listen(port).then(() => {
  console.log(`vexio-verse-multi listo en :${port} (hub/obby/lava)`);
});

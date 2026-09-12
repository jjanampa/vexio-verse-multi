import http from "node:http";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { VerseRoom } from "./room";
import { LavaRoom } from "./lava-room";
import { DisasterRoom } from "./disaster-room";

const port = Number(process.env.PORT || 2567);

const httpServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: ["hub", "obby", "lava", "tycoon", "racing", "survival", "horror", "city", "disaster"] }));
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

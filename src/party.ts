// Party por código: registra a qué sala Colyseus pertenece cada código
// para que los invitados entren con joinById. El servidor no crea salas:
// el anfitrión crea la sala y registra su roomId aquí.
import type { IncomingMessage, ServerResponse } from "node:http";
import { cors, readJson, sendJson, clientIp } from "./http-util";

export interface Party {
  code: string;
  mode: string;
  roomId: string | null;
  host: string;
  createdAt: number;
}

const MODES = new Set([
  "hub", "obby", "lava", "tycoon", "racing", "survival", "horror",
  "city", "disaster", "mm", "garden",
]);
const CODE_RE = /^[A-Z0-9]{4,8}$/;
const TTL_MS = 4 * 60 * 60 * 1000;
const MAX_PARTIES = 500;

const parties = new Map<string, Party>();
let roomExists: (roomId: string, mode: string) => boolean = () => false;

export function setRoomExists(fn: (roomId: string, mode: string) => boolean) {
  roomExists = fn;
}

function cleanup() {
  const now = Date.now();
  for (const [code, p] of parties) {
    if (now - p.createdAt > TTL_MS) parties.delete(code);
  }
}

export function getParty(code: string): Party | null {
  cleanup();
  return parties.get(code.toUpperCase()) ?? null;
}

export function unregisterRoom(roomId: string) {
  for (const [code, p] of parties) {
    if (p.roomId === roomId) {
      p.roomId = null;
    }
  }
}

/** Reserva un código (sin sala todavía) o registra la sala del anfitrión. */
export function upsertParty(code: string, mode: string, roomId: string | null, host: string): Party | null {
  cleanup();
  if (!CODE_RE.test(code) || !MODES.has(mode)) return null;
  const existing = parties.get(code);
  if (existing) {
    if (existing.mode !== mode) return null;
    if (roomId) existing.roomId = roomId;
    return existing;
  }
  if (parties.size >= MAX_PARTIES) return null;
  const p: Party = { code, mode, roomId, host, createdAt: Date.now() };
  parties.set(code, p);
  return p;
}

export async function handleParty(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/party")) return false;
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }
  if (req.method === "GET") {
    const code = (url.searchParams.get("code") ?? "").toUpperCase();
    const p = getParty(code);
    if (!p) {
      sendJson(res, 404, { ok: false, error: "party no encontrada" });
      return true;
    }
    sendJson(res, 200, { ok: true, code: p.code, mode: p.mode, roomId: p.roomId, ready: !!p.roomId });
    return true;
  }
  if (req.method === "POST") {
    const body = await readJson<{ code?: unknown; mode?: unknown; roomId?: unknown }>(req, 4096);
    if (!body) {
      sendJson(res, 400, { ok: false, error: "json inválido" });
      return true;
    }
    const code = String(body.code ?? "").toUpperCase();
    const mode = String(body.mode ?? "");
    const roomId = body.roomId ? String(body.roomId) : null;
    if (roomId && !roomExists(roomId, mode)) {
      sendJson(res, 409, { ok: false, error: "la sala no existe" });
      return true;
    }
    const p = upsertParty(code, mode, roomId, clientIp(req));
    if (!p) {
      sendJson(res, 400, { ok: false, error: "código o modo inválido" });
      return true;
    }
    sendJson(res, 200, { ok: true, code: p.code, mode: p.mode, roomId: p.roomId, ready: !!p.roomId });
    return true;
  }
  sendJson(res, 405, { ok: false, error: "método no permitido" });
  return true;
}

export function partyCount(): number {
  return parties.size;
}

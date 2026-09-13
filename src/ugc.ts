// Mapas UGC de la comunidad: subir, listar, jugar, likes y remix.
// Persistencia ligera en data/ugc.json (se pierde si el contenedor se recrea
// sin volumen, pero sobrevive a reinicios del proceso).
import type { IncomingMessage, ServerResponse } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cors, readJson, sendJson, sanitizeText, clientIp } from "./http-util";

export interface UgcBox {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
  checkpoint: boolean;
}

export interface UgcMap {
  id: string;
  name: string;
  author: string;
  boxes: UgcBox[];
  likes: number;
  remixes: number;
  remixOf: string | null;
  createdAt: number;
}

const PALETTE = ["#3b82f6", "#22c55e", "#ef4444", "#a855f7", "#f59e0b", "#eab308", "#06b6d4", "#ec4899"];
const MAX_MAPS = 200;
const MAX_BOXES = 60;
const FILE = process.env.UGC_FILE || path.join(process.cwd(), "data", "ugc.json");

const maps = new Map<string, UgcMap>();
const voters = new Map<string, Set<string>>();
const lastUpload = new Map<string, number>();
const likeWindow = new Map<string, { start: number; count: number }>();

function load() {
  try {
    const raw = readFileSync(FILE, "utf8");
    const data = JSON.parse(raw) as { maps?: UgcMap[]; voters?: Record<string, string[]> };
    for (const m of data.maps ?? []) {
      if (m && typeof m.id === "string" && Array.isArray(m.boxes)) maps.set(m.id, m);
    }
    for (const [id, list] of Object.entries(data.voters ?? {})) {
      voters.set(id, new Set(list));
    }
  } catch {
    /* primera vez o fichero corrupto */
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      mkdirSync(path.dirname(FILE), { recursive: true });
      const data = {
        maps: [...maps.values()],
        voters: Object.fromEntries([...voters].map(([id, set]) => [id, [...set].slice(0, 500)])),
      };
      writeFileSync(FILE, JSON.stringify(data), "utf8");
    } catch {
      /* sin persistencia: se sigue en memoria */
    }
  }, 800);
}

const clamp = (v: unknown, min: number, max: number, fb: number) =>
  typeof v === "number" && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v * 10) / 10)) : fb;

function validBox(raw: unknown): UgcBox | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, unknown>;
  const color = PALETTE.includes(String(b.color)) ? String(b.color) : PALETTE[0];
  return {
    x: clamp(b.x, -20, 20, 0),
    y: clamp(b.y, 0, 10, 0.5),
    z: clamp(b.z, -20, 20, 0),
    w: clamp(b.w, 0.5, 8, 1.4),
    h: clamp(b.h, 0.3, 3, 0.5),
    d: clamp(b.d, 0.5, 8, 1.4),
    color,
    checkpoint: b.checkpoint === true,
  };
}

function validBoxes(raw: unknown): UgcBox[] | null {
  if (!Array.isArray(raw)) return null;
  if (raw.length < 2 || raw.length > MAX_BOXES) return null;
  const boxes: UgcBox[] = [];
  for (const r of raw) {
    const b = validBox(r);
    if (!b) return null;
    boxes.push(b);
  }
  return boxes;
}

function newId(): string {
  return "u" + Math.random().toString(36).slice(2, 10);
}

function allowUpload(ip: string): boolean {
  const now = Date.now();
  const last = lastUpload.get(ip) ?? 0;
  if (now - last < 5000) return false;
  lastUpload.set(ip, now);
  return true;
}

function allowLike(ip: string): boolean {
  const now = Date.now();
  const w = likeWindow.get(ip);
  if (!w || now - w.start > 60_000) {
    likeWindow.set(ip, { start: now, count: 1 });
    return true;
  }
  w.count++;
  return w.count <= 60;
}

function publicMap(m: UgcMap) {
  return {
    id: m.id,
    name: m.name,
    author: m.author,
    boxes: m.boxes,
    likes: m.likes,
    remixes: m.remixes,
    remixOf: m.remixOf,
    createdAt: m.createdAt,
  };
}

export function ugcCount(): number {
  return maps.size;
}

export async function handleUgc(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/ugc")) return false;
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return true;
  }

  // GET /ugc?sort=likes|new&limit=12
  if (req.method === "GET" && (url.pathname === "/ugc" || url.pathname === "/ugc/")) {
    const sort = url.searchParams.get("sort") ?? "likes";
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get("limit")) || 20));
    const list = [...maps.values()]
      .sort((a, b) => (sort === "new" ? b.createdAt - a.createdAt : b.likes - a.likes || b.createdAt - a.createdAt))
      .slice(0, limit)
      .map(publicMap);
    sendJson(res, 200, { ok: true, total: maps.size, maps: list });
    return true;
  }

  // GET /ugc/one?id=XXX
  if (req.method === "GET" && url.pathname === "/ugc/one") {
    const m = maps.get(url.searchParams.get("id") ?? "");
    if (!m) {
      sendJson(res, 404, { ok: false, error: "mapa no encontrado" });
      return true;
    }
    sendJson(res, 200, { ok: true, map: publicMap(m) });
    return true;
  }

  // POST /ugc  { name, author, boxes, remixOf? }
  if (req.method === "POST" && (url.pathname === "/ugc" || url.pathname === "/ugc/")) {
    const body = await readJson<Record<string, unknown>>(req);
    if (!body) {
      sendJson(res, 400, { ok: false, error: "json inválido" });
      return true;
    }
    const boxes = validBoxes(body.boxes);
    if (!boxes) {
      sendJson(res, 400, { ok: false, error: "mapa inválido (2-60 bloques)" });
      return true;
    }
    const ip = clientIp(req);
    if (!allowUpload(ip)) {
      sendJson(res, 429, { ok: false, error: "espera unos segundos antes de publicar otra vez" });
      return true;
    }
    if (maps.size >= MAX_MAPS) {
      sendJson(res, 507, { ok: false, error: "la comunidad está llena, prueba más tarde" });
      return true;
    }
    const remixOf = typeof body.remixOf === "string" && maps.has(body.remixOf) ? body.remixOf : null;
    const m: UgcMap = {
      id: newId(),
      name: sanitizeText(body.name, 24) || "Mapa sin nombre",
      author: sanitizeText(body.author, 16) || "Anónimo",
      boxes,
      likes: 0,
      remixes: 0,
      remixOf,
      createdAt: Date.now(),
    };
    maps.set(m.id, m);
    if (remixOf) {
      const src = maps.get(remixOf)!;
      src.remixes++;
    }
    save();
    sendJson(res, 200, { ok: true, map: publicMap(m) });
    return true;
  }

  // POST /ugc/like  { id, voter }
  if (req.method === "POST" && url.pathname === "/ugc/like") {
    const ip = clientIp(req);
    if (!allowLike(ip)) {
      sendJson(res, 429, { ok: false, error: "demasiados likes seguidos" });
      return true;
    }
    const body = await readJson<{ id?: unknown; voter?: unknown }>(req, 2048);
    const m = body && typeof body.id === "string" ? maps.get(body.id) : undefined;
    const voter = sanitizeText(body?.voter, 40);
    if (!m || !/^[a-z0-9-]{6,40}$/i.test(voter)) {
      sendJson(res, 400, { ok: false, error: "like inválido" });
      return true;
    }
    const set = voters.get(m.id) ?? new Set<string>();
    if (!set.has(voter)) {
      set.add(voter);
      voters.set(m.id, set);
      m.likes++;
      save();
    }
    sendJson(res, 200, { ok: true, likes: m.likes, liked: true });
    return true;
  }

  sendJson(res, 405, { ok: false, error: "método no permitido" });
  return true;
}

load();

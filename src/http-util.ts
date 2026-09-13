import type { IncomingMessage, ServerResponse } from "node:http";

export function cors(res: ServerResponse) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
}

export function sendJson(res: ServerResponse, code: number, body: unknown) {
  cors(res);
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function sendText(res: ServerResponse, code: number, body: string) {
  cors(res);
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

/** Lee y parsea JSON del body con límite de tamaño. Devuelve null si es inválido. */
export async function readJson<T = Record<string, unknown>>(req: IncomingMessage, maxBytes = 65536): Promise<T | null> {
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > maxBytes) return null;
      chunks.push(buf);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? (JSON.parse(raw) as T) : ({} as T);
  } catch {
    return null;
  }
}

export function clientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[0] : fwd;
  return String(raw ?? req.socket.remoteAddress ?? "?").split(",")[0].trim();
}

/** Texto seguro para mostrar: sin ángulos/control y con longitud máxima. */
export function sanitizeText(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[<>&"'\u0000-\u001f]/g, "")
    .trim()
    .slice(0, max);
}

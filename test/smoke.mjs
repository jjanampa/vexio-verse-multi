// Smoke test del servidor multijugador: levanta dist/index.js en un puerto
// de prueba y verifica join, move, chat, sync de reloj y una ronda de lava.
// Uso: node test/smoke.mjs   (requiere `npm run build` antes)
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'colyseus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(here, '..');
const PORT = Number(process.env.SMOKE_PORT || 2599);
const URL = `http://127.0.0.1:${PORT}`;

let child = null;

function log(msg) {
  console.log(`  ${msg}`);
}

async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`timeout esperando ${label}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  child = spawn(process.execPath, ['dist/index.js'], {
    cwd: serverDir,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  await waitFor(async () => {
    try {
      const res = await fetch(`${URL}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }, 10_000, 'servidor /health');
  log(`servidor arriba en :${PORT}`);

  const c1 = new Client(URL);
  const c2 = new Client(URL);
  const opts = (name) => ({ name, body: '#3b82f6', head: '#fbbf24', x: 0, y: 2, z: 0 });
  const r1 = await c1.joinOrCreate('lava', opts('SmokeA'));
  const r2 = await c2.joinOrCreate('lava', opts('SmokeB'));
  log('dos clientes en la sala lava');

  await waitFor(() => r1.state.players.size === 2, 2000, '2 jugadores en el estado');

  // Reloj del servidor (fix de desincronización)
  let syncNow = null;
  r1.onMessage('sync', (m) => (syncNow = m?.now ?? null));
  r1.send('sync-request', {});
  await waitFor(() => typeof syncNow === 'number', 2000, 'mensaje sync');
  assert(Math.abs(syncNow - Date.now()) < 5000, 'sync devuelve un reloj razonable');
  log(`sync ok (${syncNow - Date.now()} ms de offset)`);

  // Movimiento
  r1.send('move', { x: 1.5, y: 2, z: -3.5, rotY: 0.5, moving: true });
  await waitFor(() => {
    const p = r1.state.players.get(r1.sessionId);
    return p && Math.abs(p.x - 1.5) < 0.001 && Math.abs(p.z + 3.5) < 0.001;
  }, 2000, 'movimiento sincronizado');
  log('move ok');

  // Endpoint /players (página de inicio)
  const playersRes = await (await fetch(`${URL}/players`)).json();
  assert(playersRes.total >= 2, `endpoint /players cuenta jugadores (${playersRes.total})`);
  assert(Array.isArray(playersRes.rooms?.lava) && playersRes.rooms.lava.length >= 2, '/players lista la sala lava');
  log(`players ok (${playersRes.total} en línea)`);

  // Chat + cooldown (el segundo mensaje inmediato se descarta)
  const chats = [];
  r2.onMessage('chat', (m) => chats.push(m));
  r1.send('chat', { text: 'hola mundo' });
  r1.send('chat', { text: 'spam' });
  await waitFor(() => chats.length >= 1, 2000, 'chat');
  await sleep(400);
  assert(chats.length === 1, `cooldown de chat (recibidos ${chats.length})`);
  assert(chats[0].text === 'hola mundo', 'texto de chat correcto');
  log('chat + cooldown ok');

  // Rondas: lobby -> countdown -> running
  await waitFor(() => r1.state.phase === 'countdown' || r1.state.phase === 'running', 9000, 'cuenta atrás');
  log(`fase intermedia: ${r1.state.phase}`);
  await waitFor(() => r1.state.phase === 'running', 6000, 'ronda en marcha');
  assert(r1.state.roundPlayers === 2, 'la ronda registra 2 jugadores');
  log(`ronda ${r1.state.round} en marcha`);

  // Al morir uno, la ronda termina y llega el ranking
  let over = null;
  r1.onMessage('roundOver', (m) => (over = m));
  r2.send('died', { secs: 12.5 });
  await waitFor(() => over !== null, 3000, 'roundOver');
  const dead = over.ranking.find((r) => r.id === r2.sessionId);
  const alive = over.ranking.find((r) => r.id === r1.sessionId);
  assert(dead && Math.abs(dead.score - 12.5) < 0.01, `puntuación del muerto (${dead?.score})`);
  assert(alive && alive.place === 1, 'el superviviente queda 1º');
  assert(dead.place === 2, 'el muerto queda 2º');
  assert(r1.state.phase === 'result', 'la sala pasa a resultados');
  log(`roundOver ok (${over.ranking.map((r) => `${r.place}. ${r.name} ${r.score}`).join(' | ')})`);

  await r1.leave();
  await r2.leave();
  log('lava ok');

  // ---- Desastres Naturales ----
  const c3 = new Client(URL);
  const c4 = new Client(URL);
  const d1 = await c3.joinOrCreate('disaster', opts('SmokeD1'));
  const d2 = await c4.joinOrCreate('disaster', opts('SmokeD2'));
  let disasterMsg = null;
  d1.onMessage('disaster', (m) => (disasterMsg = m));
  await waitFor(() => d1.state.players.size === 2, 2000, '2 jugadores en desastres');
  await waitFor(() => d1.state.phase === 'countdown' || d1.state.phase === 'running', 14000, 'cuenta atrás desastres');
  await waitFor(() => d1.state.phase === 'running', 6000, 'ronda de desastres');
  await waitFor(() => disasterMsg !== null, 2000, 'mensaje disaster');
  const KINDS = ['meteor', 'tornado', 'flood', 'earthquake', 'lightning'];
  assert(KINDS.includes(disasterMsg.kind), `catástrofe válida (${disasterMsg.kind})`);
  assert(d1.state.disaster === disasterMsg.kind, 'el estado refleja la catástrofe');
  log(`ronda de desastres en marcha: ${disasterMsg.kind}`);

  let overD = null;
  d1.onMessage('roundOver', (m) => (overD = m));
  d2.send('died', { secs: 30 });
  await waitFor(() => overD !== null, 3000, 'roundOver desastres');
  const deadD = overD.ranking.find((r) => r.id === d2.sessionId);
  const aliveD = overD.ranking.find((r) => r.id === d1.sessionId);
  assert(deadD && Math.abs(deadD.score - 30) < 0.01, `puntuación desastres (${deadD?.score})`);
  assert(aliveD && aliveD.place === 1, 'superviviente 1º en desastres');
  assert(overD.disaster === disasterMsg.kind, 'el ranking incluye la catástrofe');
  log(`desastres ok (${overD.ranking.map((r) => `${r.place}. ${r.name} ${r.score}`).join(' | ')})`);

  await d1.leave();
  await d2.leave();
  log('todo correcto ✔');
}

let code = 0;
try {
  await main();
} catch (err) {
  console.error(`✖ smoke test falló: ${err.message}`);
  code = 1;
} finally {
  if (child) child.kill('SIGTERM');
}
process.exit(code);

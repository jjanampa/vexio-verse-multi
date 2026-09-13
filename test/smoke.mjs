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
  const opts = (name) => ({
    name, body: '#3b82f6', head: '#fbbf24', x: 0, y: 2, z: 0,
    hat: 'hat-crown', back: 'back-rocket',
  });
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
  assert(chats[0].channel === 'sala', 'canal por defecto = sala');
  assert(typeof chats[0].x === 'number' && typeof chats[0].z === 'number', 'el chat incluye posición para zona');
  log('chat + cooldown ok');

  // Moderación + canal de zona (tras el cooldown de 1s)
  await sleep(1100);
  r1.send('chat', { text: 'hola mierda', channel: 'zona' });
  await waitFor(() => chats.length >= 2, 2000, 'chat moderado');
  const moderado = chats[1];
  assert(!/mierda/i.test(moderado.text) && moderado.text.includes('*'), `texto moderado (${moderado.text})`);
  assert(moderado.channel === 'zona', 'canal de zona etiquetado');
  log(`moderación ok (${moderado.text})`);

  // Cosméticos sincronizados por el estado
  const meLava = r1.state.players.get(r1.sessionId);
  assert(meLava.hat === 'hat-crown' && meLava.back === 'back-rocket', 'hat/back sincronizados');

  // Emote retransmitido a los demás
  let emoteMsg = null;
  r2.onMessage('emote', (m) => (emoteMsg = m));
  r1.send('emote', { emote: 'dance', ms: 2000 });
  await waitFor(() => emoteMsg !== null, 2000, 'emote relay');
  assert(emoteMsg.id === r1.sessionId && emoteMsg.emote === 'dance', 'emote retransmitido');
  log('cosméticos + emote ok');

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
  log('lava y desastres ok');

  // ---- Asesino (Murder Mystery) ----
  const c5 = new Client(URL);
  const c6 = new Client(URL);
  const c7 = new Client(URL);
  const m1 = await c5.joinOrCreate('mm', opts('Mm1'));
  const m2 = await c6.joinOrCreate('mm', opts('Mm2'));
  const m3 = await c7.joinOrCreate('mm', opts('Mm3'));
  const roles = new Map();
  for (const r of [m1, m2, m3]) {
    r.onMessage('role', (m) => roles.set(r.sessionId, m.role));
  }
  const killed = [];
  m1.onMessage('killed', (k) => killed.push(k));
  let overMm = null;
  m1.onMessage('roundOver', (m) => (overMm = m));
  await waitFor(() => roles.size === 3, 16000, 'roles repartidos');
  const roleVals = [...roles.values()].sort().join(',');
  assert(roleVals === 'innocent,murderer,sheriff', `roles correctos (${roleVals})`);
  log(`roles ok: ${roleVals}`);
  const murdererId = [...roles.entries()].find(([, r]) => r === 'murderer')[0];
  const byId = new Map([[m1.sessionId, m1], [m2.sessionId, m2], [m3.sessionId, m3]]);
  const targets = [...roles.keys()].filter((id) => id !== murdererId);
  byId.get(murdererId).send('hit', { target: targets[0] });
  await waitFor(() => killed.length === 1, 2500, 'primer asesinato');
  // El cuchillo tiene cooldown en servidor: el segundo golpe inmediato se ignora
  const knifeSpam = byId.get(murdererId).send !== undefined;
  byId.get(murdererId).send('hit', { target: targets[1] });
  await sleep(300);
  assert(overMm === null || killed.length === 1, 'cooldown del cuchillo (no mata en cadena)');
  void knifeSpam;
  await sleep(1400);
  byId.get(murdererId).send('hit', { target: targets[1] });
  await waitFor(() => overMm !== null, 3000, 'roundOver asesino');
  assert(overMm.winner === 'murderer', `gana el asesino (${overMm.winner})`);
  log(`asesino ok (${overMm.winner}, ${overMm.roles.map((r) => r.role).join('/')})`);
  await m1.leave();
  await m2.leave();
  await m3.leave();

  // ---- Granja ----
  const g1 = await new Client(URL).joinOrCreate('garden', opts('Garden'));
  await waitFor(() => g1.state?.players?.size === 1, 3000, 'granja');
  log('granja ok');
  await g1.leave();

  // ---- Party por código ----
  const pc = new Client(URL);
  const host = await pc.create('obby', opts('PartyHost'));
  const CODE = 'SMK1';
  let pres = await fetch(`${URL}/party`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: CODE, mode: 'obby' }),
  });
  assert(pres.ok, 'party reservada por código');
  pres = await fetch(`${URL}/party`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: CODE, mode: 'obby', roomId: host.roomId }),
  });
  assert(pres.ok, 'party registra el roomId del anfitrión');
  const pinfo = await (await fetch(`${URL}/party?code=${CODE}`)).json();
  assert(pinfo.ok && pinfo.roomId === host.roomId && pinfo.ready, 'party lista para invitar');
  const pg = new Client(URL);
  const guest = await pg.joinById(host.roomId, opts('PartyGuest'));
  await waitFor(() => host.state.players.size === 2, 2500, 'invitado en la party');
  assert(guest.sessionId !== host.sessionId, 'el invitado entró a la misma sala');
  const pbad = await fetch(`${URL}/party`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: '!!', mode: 'obby' }),
  });
  assert(!pbad.ok, 'rechaza códigos inválidos');
  log(`party ok (${CODE} -> ${host.roomId.slice(0, 8)}…)`);
  await host.leave();
  await guest.leave();

  // ---- UGC en servidor ----
  const boxes = [
    { x: 0, y: 0.5, z: 0, w: 2.5, h: 0.6, d: 2.5, color: '#22c55e', checkpoint: false },
    { x: 0, y: 1, z: 3, w: 2.5, h: 0.6, d: 2.5, color: '#ef4444', checkpoint: true },
  ];
  const badUp = await fetch(`${URL}/ugc`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Malo', author: 'Smoke', boxes: [boxes[0]] }),
  });
  assert(badUp.status === 400, 'rechaza mapas con <2 bloques');
  const up = await (
    await fetch(`${URL}/ugc`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mapa Smoke', author: 'Smoke', boxes }),
    })
  ).json();
  assert(up.ok && up.map?.id, 'subida UGC correcta');
  const ulist = await (await fetch(`${URL}/ugc?sort=new&limit=5`)).json();
  assert(ulist.ok && ulist.maps.some((m) => m.id === up.map.id), 'listado UGC incluye el mapa');
  const uone = await (await fetch(`${URL}/ugc/one?id=${up.map.id}`)).json();
  assert(uone.ok && uone.map.boxes.length === 2, 'detalle UGC con bloques');
  const voter = 'vsmoke-123456';
  const like1 = await (
    await fetch(`${URL}/ugc/like`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: up.map.id, voter }),
    })
  ).json();
  const like2 = await (
    await fetch(`${URL}/ugc/like`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: up.map.id, voter }),
    })
  ).json();
  assert(like1.likes === 1 && like2.likes === 1, 'like único por votante');
  log(`ugc ok (${up.map.id}, ${like1.likes} like)`);

  // /health expone los contadores nuevos
  const health = await (await fetch(`${URL}/health`)).json();
  assert(health.ok && health.ugcMaps >= 1, 'health reporta mapas UGC');
  assert(health.parties >= 1, 'health reporta parties');
  log(`health ok (${health.ugcMaps} mapas, ${health.parties} parties)`);

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

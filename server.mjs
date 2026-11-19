import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import QRCode from './vendor/qrcode/index.js';
import qrCorrection from './vendor/qrcode/QRErrorCorrectLevel.js';
import { GameError, Room, durations } from './game.mjs';
import { RoomStore } from './store.mjs';

const routes = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']], ['/join', ['index.html', 'text/html; charset=utf-8']],
  ['/play', ['index.html', 'text/html; charset=utf-8']], ['/tv', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/app.js', ['app.js', 'application/javascript; charset=utf-8']],
  ['/voice.js', ['voice.js', 'application/javascript; charset=utf-8']],
  ['/dispatch.webp', ['dispatch.webp', 'image/webp']],
]);
const commonHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'",
};
const ttl = 4 * 60 * 60 * 1000;
const clientPattern = /^[a-f0-9-]{36}$/;

function json(response, status, data, extra = {}) {
  response.writeHead(status, { ...commonHeaders, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
  response.end(JSON.stringify(data));
}

async function input(request) {
  const limit = 300_000;
  if (!request.headers['content-type']?.startsWith('application/json')) throw new GameError('Нужен JSON.', 415);
  if (Number(request.headers['content-length']) > limit) throw new GameError('Файл слишком большой.', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new GameError('Файл слишком большой.', 413);
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch { /* handled below */ }
  throw new GameError('Не удалось прочитать данные.', 400);
}

function nickname(value) {
  const name = typeof value === 'string' ? value.normalize('NFC').trim() : '';
  if (!name || [...name].length > 20 || /[\p{Cc}\p{Cf}]/u.test(name)) throw new GameError('Введите ник длиной до 20 символов.', 400);
  return name;
}

function avatar(value) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 260_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new GameError('Выберите фото ещё раз.', 400);
  const data = Buffer.from(value.slice('data:image/jpeg;base64,'.length), 'base64');
  if (data.length < 20 || data[0] !== 255 || data[1] !== 216 || data.at(-2) !== 255 || data.at(-1) !== 217) throw new GameError('Фото не открылось.', 400);
  const parts = [data.subarray(0, 2)];
  let hasSize = false;
  for (let i = 2; i + 4 < data.length;) {
    const marker = data[i + 1];
    if (data[i] !== 255 || marker === 0) break;
    const length = data.readUInt16BE(i + 2);
    const end = i + 2 + length;
    if (length < 2 || end > data.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      const height = data.readUInt16BE(i + 5);
      const width = data.readUInt16BE(i + 7);
      if (height < 1 || width < 1 || height > 512 || width > 512) throw new GameError('Уменьшите фото и повторите.', 400);
      hasSize = true;
    }
    if (marker === 0xda && hasSize) return Buffer.concat([...parts, data.subarray(i)]);
    if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe) parts.push(data.subarray(i, end));
    i = end;
  }
  throw new GameError('Фото не открылось.', 400);
}

function cookie(player, room, secure) {
  return `shift_${room.code}=${player.secret}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl / 1000}${secure ? '; Secure' : ''}`;
}

function playerFrom(request, room) {
  const entry = request.headers.cookie?.split(';').map((part) => part.trim()).find((part) => part.startsWith(`shift_${room.code}=`));
  const secret = entry?.split('=')[1];
  return secret ? room.players.find((player) => player.secret === secret) : null;
}

function localAddress() {
  const interfaces = Object.entries(networkInterfaces()).sort(([a], [b]) => Number(/wi.?fi|wireless|беспровод|ethernet/i.test(b)) - Number(/wi.?fi|wireless|беспровод|ethernet/i.test(a)));
  return interfaces.flatMap(([, entries]) => entries ?? []).find((entry) => !entry.internal && entry.family === 'IPv4' && /^(192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(entry.address))?.address;
}

function webOrigin(request, publicUrl, address, port) {
  if (publicUrl) return publicUrl;
  try {
    const origin = new URL(`http://${request.headers.host}`);
    if (address && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)) origin.hostname = address;
    if (request.headers.host) return origin.origin;
  } catch { /* use server address */ }
  return `http://${address || '127.0.0.1'}:${port}`;
}

function roomCode(rooms) {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do { code = [...randomBytes(5)].map((value) => alphabet[value & 31]).join(''); } while (rooms.has(code));
  return code;
}

function pngPart(type, data) {
  const name = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  name.copy(result, 4);
  data.copy(result, 8);
  let crc = 0xffffffff;
  for (let index = 4; index < data.length + 8; index += 1) {
    crc ^= result[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return result;
}

function qrPng(url) {
  const qr = new QRCode(-1, qrCorrection.M);
  qr.addData(url);
  qr.make();
  const modules = qr.getModuleCount();
  const pixels = 7;
  const side = (modules + 8) * pixels;
  const head = Buffer.alloc(13);
  head.writeUInt32BE(side, 0);
  head.writeUInt32BE(side, 4);
  head[8] = 8;
  const raw = Buffer.alloc(side * (side + 1), 255);
  for (let y = 0; y < side; y += 1) {
    raw[y * (side + 1)] = 0;
    const row = Math.floor(y / pixels) - 4;
    if (row < 0 || row >= modules) continue;
    for (let column = 0; column < modules; column += 1) {
      if (qr.isDark(row, column)) raw.fill(0, y * (side + 1) + 1 + (column + 4) * pixels, y * (side + 1) + 1 + (column + 5) * pixels);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngPart('IHDR', head), pngPart('IDAT', deflateSync(raw)), pngPart('IEND', Buffer.alloc(0))]);
}

export function openAINarrator({ key, model, request = fetch }) {
  if (!key || !model) return null;
  return async (kind, facts) => {
    try {
      const response = await request('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal: AbortSignal.timeout(3900),
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, store: false, max_output_tokens: 180,
          instructions: 'Ты Диспетчер вымышленного убежища. Дай одну короткую авторскую реплику на русском, сухо и по-деловому смешно. Используй только данные игры во входном JSON. Не меняй результат и правила, не придумывай новых происшествий. Без мата, разметки, заголовков и обращений к реальным людям. До 140 символов.',
          input: JSON.stringify({ kind, ...facts }),
        }),
      });
      if (!response.ok) return '';
      const output = await response.json();
      const text = output.output?.filter((item) => item.type === 'message').flatMap((item) => item.content).find((item) => item.type === 'output_text')?.text?.trim();
      return typeof text === 'string' && text.length <= 160 ? text : '';
    } catch { return ''; }
  };
}

export function localSpeaker({ url, request = fetch }) {
  if (!url) return null;
  const route = new URL('/synthesize', url);
  return async (text) => {
    const response = await request(route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(9500),
      body: JSON.stringify({ text, length_scale: 0.95 }),
    });
    if (!response.ok || Number(response.headers.get('content-length')) > 4_000_000) throw new Error('Audio unavailable');
    const wav = Buffer.from(await response.arrayBuffer());
    if (wav.length < 44 || wav.length > 4_000_000 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV');
    return wav;
  };
}

function configuredIceServers() {
  const raw = process.env.SHIFT_ICE_SERVERS;
  if (!raw) return [];
  let servers;
  try { servers = JSON.parse(raw); } catch { /* validation below */ }
  if (!Array.isArray(servers) || servers.length > 10 || servers.some((server) => {
    const urls = [server?.urls].flat();
    return !urls.length || urls.some((url) => typeof url !== 'string' || !/^(stun|stuns|turn|turns):\S+$/.test(url));
  })) throw new Error('SHIFT_ICE_SERVERS должен содержать массив настроек STUN/TURN.');
  return servers;
}

function voicePayload(body) {
  if (body.description && !body.candidate) {
    const { type, sdp } = body.description;
    if (['offer', 'answer'].includes(type) && typeof sdp === 'string' && sdp.length > 0 && sdp.length <= 18_000) return { description: { type, sdp } };
  }
  if (body.candidate && !body.description) {
    const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = body.candidate;
    if (typeof candidate === 'string' && candidate.length <= 2500 && (sdpMid == null || typeof sdpMid === 'string' && sdpMid.length <= 32) && (sdpMLineIndex == null || Number.isInteger(sdpMLineIndex) && sdpMLineIndex >= 0 && sdpMLineIndex <= 10) && (usernameFragment == null || typeof usernameFragment === 'string' && usernameFragment.length <= 64)) return { candidate: { candidate, sdpMid, sdpMLineIndex, usernameFragment } };
  }
  throw new GameError('Недопустимые данные голосовой связи.', 400);
}

export function createGameServer({ timing = durations, narrator = openAINarrator({ key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL }), speaker = localSpeaker({ url: process.env.SHIFT_SPEECH_URL }), publicUrl = process.env.SHIFT_PUBLIC_URL || '', iceServers = configuredIceServers(), roomTtl = ttl, dataDirectory = process.env.SHIFT_DATA_DIR || '' } = {}) {
  const rooms = new Map();
  const address = localAddress();
  const configuredOrigin = publicUrl ? new URL(publicUrl).origin : '';
  const store = dataDirectory ? new RoomStore(dataDirectory) : null;
  let stopping = false;

  function sendEvent(peer, event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (peer.response.writableLength > 96_000) peer.response.destroy();
    else peer.response.write(payload);
  }

  function broadcast(room) {
    if (stopping) return;
    if (store) void store.save(room.code, room.serialize()).catch(() => {});
    for (const peer of room.peers) {
      if (peer.player && !room.players.includes(peer.player)) {
        sendEvent(peer, 'removed', {});
        peer.response.end();
      } else sendEvent(peer, 'state', room.snapshot(peer.player));
    }
  }

  const roomOptions = { notify: broadcast, narrator, timing };
  for (const saved of store?.read() ?? []) {
    if (Date.now() - saved.lastActive >= roomTtl) { void store.remove(saved.code).catch(() => {}); continue; }
    try {
      const room = Room.restore(saved, roomOptions);
      room.peers = new Set();
      rooms.set(room.code, room);
    } catch { console.error('Одна сохранённая комната была пропущена.'); }
  }

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://server.invalid');
      const { pathname } = url;
      const origin = webOrigin(request, configuredOrigin, address, server.address().port);
      const method = request.method;
      if (method === 'GET' && routes.has(pathname)) {
        const [file, type] = routes.get(pathname);
        const content = await readFile(new URL(`./public/${file}`, import.meta.url));
        response.writeHead(200, { ...commonHeaders, 'Content-Type': type, 'Cache-Control': 'no-cache' });
        response.end(content);
        return;
      }
      if (method === 'GET' && pathname === '/api/config') {
        json(response, 200, { origin, narrator: Boolean(narrator), localSpeech: Boolean(speaker), remoteVoice: true, persistent: Boolean(store) });
        return;
      }
      if (method === 'POST' && pathname === '/api/rooms') {
        if (rooms.size >= 100) throw new GameError('Слишком много комнат. Попробуйте позже.', 503);
        const body = await input(request);
        const name = nickname(body.name);
        const photo = avatar(body.photo);
        const room = new Room(roomCode(rooms), roomOptions);
        room.peers = new Set();
        room.mature = body.mature === true;
        const player = room.add(name, photo);
        rooms.set(room.code, room);
        await store?.flush(room.code);
        return json(response, 201, { code: room.code }, { 'Set-Cookie': cookie(player, room, origin.startsWith('https:')) });
      }
      const parts = pathname.match(/^\/api\/rooms\/([2-9A-HJ-NP-Z]{5})\/(join|public|state|stream|act|qr|avatar|voice|signal|speech)(?:\/([a-f0-9-]{36}))?$/);
      if (!parts) throw new GameError('Страница не найдена.', 404);
      const [, code, endpoint, picture] = parts;
      const room = rooms.get(code);
      if (!room) throw new GameError('Комната не найдена или уже закрыта.', 404);
      const viewer = playerFrom(request, room);
      if (method === 'POST' && endpoint === 'join') {
        const body = await input(request);
        const player = playerFrom(request, room) || room.add(nickname(body.name), avatar(body.photo));
        await store?.flush(room.code);
        return json(response, 200, { code }, { 'Set-Cookie': cookie(player, room, origin.startsWith('https:')) });
      }
      if (method === 'GET' && endpoint === 'qr') {
        const content = qrPng(`${origin}/join?room=${code}`);
        response.writeHead(200, { ...commonHeaders, 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }); response.end(content); return;
      }
      if (method === 'GET' && endpoint === 'avatar') {
        const photo = room.players.find((player) => player.id === picture)?.photo;
        if (!photo) throw new GameError('Фотография удалена.', 404);
        response.writeHead(200, { ...commonHeaders, 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' }); response.end(photo); return;
      }
      if (method === 'GET' && endpoint === 'public') return json(response, 200, room.snapshot());
      if (method === 'GET' && endpoint === 'speech') {
        if (!speaker) throw new GameError('Озвучка доступна через браузер.', 404);
        const part = url.searchParams.get('part') || 'base';
        const phase = room.phaseId;
        if (!['base', 'extra', 'hello'].includes(part) || String(phase) !== url.searchParams.get('phase')) throw new GameError('Объявление уже изменилось.');
        const text = part === 'hello' && room.phase === 'lobby' ? 'Диспетчер на связи.' : part === 'extra' && ['radio', 'intro', 'final'].includes(room.phase) ? room.readout.slice(room.narration.length).trim() : part === 'base' ? room.narration : '';
        if (!text) throw new GameError('Звуковая реплика недоступна.', 404);
        if (room.speechPhase !== phase) { room.speechPhase = phase; room.speech = new Map(); }
        if (!room.speech.has(part)) {
          const attempt = Promise.resolve().then(() => speaker(text));
          room.speech.set(part, attempt);
          void attempt.catch(() => { if (room.speechPhase === phase) room.speech.delete(part); });
        }
        try {
          const audio = await room.speech.get(part);
          response.writeHead(200, { ...commonHeaders, 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
          response.end(audio);
        } catch { return json(response, 503, { error: 'Локальная озвучка недоступна.' }); }
        return;
      }
      if (method === 'GET' && endpoint === 'state') {
        if (!viewer) throw new GameError('Сначала войдите в комнату.', 401);
        return json(response, 200, room.snapshot(viewer));
      }
      if (method === 'POST' && endpoint === 'act') {
        if (!viewer) throw new GameError('Сначала войдите в комнату.', 401);
        const body = await input(request);
        if (body.action === 'photo') body.value = avatar(body.value);
        if (!room.players.includes(viewer)) throw new GameError('Сначала войдите в комнату.', 401);
        room.act(viewer, body);
        await store?.flush(room.code);
        return json(response, 200, room.snapshot(viewer));
      }
      if (endpoint === 'voice' || endpoint === 'signal') {
        if (!viewer) throw new GameError('Сначала войдите в комнату.', 401);
        if (method === 'GET' && endpoint === 'voice') return json(response, 200, { iceServers });
        if (method !== 'POST') throw new GameError('Этот запрос не поддерживается.', 405);
        const body = await input(request);
        if (!room.players.includes(viewer)) throw new GameError('Сначала войдите в комнату.', 401);
        if (typeof body.client !== 'string' || !clientPattern.test(body.client)) throw new GameError('Недопустимая вкладка для голосовой связи.', 400);
        const caller = [...room.peers].some((peer) => peer.player === viewer && peer.client === body.client);
        if (endpoint === 'voice') {
          if (body.enabled === false) {
            if (viewer.voice?.client === body.client) { viewer.voice = null; room.refresh(); }
          } else if (body.enabled === true) {
            if (!caller) throw new GameError('Сначала восстановите подключение к комнате.');
            if (viewer.voice?.client !== body.client) {
              viewer.voice = { client: body.client, session: randomUUID() };
              room.refresh();
            }
          } else throw new GameError('Выберите состояние голосовой связи.', 400);
          return json(response, 200, { session: viewer.voice?.client === body.client ? viewer.voice.session : null });
        }
        if (!caller || !viewer.voice || viewer.voice.client !== body.client || viewer.voice.session !== body.session) throw new GameError('Сначала подключитесь к голосовой связи.', 403);
        const member = room.players.find((player) => player.id !== viewer.id && player.id === body.to);
        if (!member?.voice || member.voice.session !== body.targetSession) throw new GameError('Голосовая сессия игрока уже изменилась.');
        const payload = voicePayload(body);
        for (const peer of room.peers) if (peer.player === member && peer.client === member.voice.client) sendEvent(peer, 'voice', { from: viewer.id, session: viewer.voice.session, targetSession: member.voice.session, ...payload });
        return json(response, 200, { ok: true });
      }
      if (method === 'GET' && endpoint === 'stream') {
        const player = url.searchParams.get('view') === 'tv' ? null : viewer;
        if (!player && url.searchParams.get('view') !== 'tv') throw new GameError('Сначала войдите в комнату.', 401);
        if (room.peers.size >= 60) throw new GameError('Слишком много открытых экранов.', 429);
        response.writeHead(200, { ...commonHeaders, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        const clientId = url.searchParams.get('client');
        const peer = { response, player, client: player && clientId && clientPattern.test(clientId) ? clientId : null };
        room.peers.add(peer);
        if (player) { player.connected += 1; player.lastSeen = room.now(); }
        room.refresh();
        response.on('close', () => {
          if (!room.peers.delete(peer)) return;
          if (player) {
            player.connected -= 1;
            player.lastSeen = room.now();
            if (player.voice?.client === peer.client && ![...room.peers].some((other) => other.player === player && other.client === peer.client)) player.voice = null;
          }
          if (rooms.has(code) && !stopping) room.refresh();
        });
        return;
      }
      throw new GameError('Этот запрос не поддерживается.', 405);
    } catch (error) {
      if (response.headersSent) return response.end();
      if (error instanceof GameError) return json(response, error.status, { error: error.message });
      console.error('Не удалось обработать запрос:', error.name);
      return json(response, 500, { error: 'Ошибка на сервере.' });
    }
  });
  let lastHeartbeat = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (now - room.lastActive >= roomTtl) {
        rooms.delete(code);
        for (const peer of room.peers) { sendEvent(peer, 'expired', {}); peer.response.end(); }
        if (store) void store.remove(code).catch(() => {});
        continue;
      }
      if (now - lastHeartbeat > 15_000) {
        for (const peer of room.peers) peer.response.write(': heartbeat\n\n');
        if (store && room.deadline !== null) void store.save(code, room.serialize()).catch(() => {});
      }
      room.tick();
    }
    if (now - lastHeartbeat > 15_000) lastHeartbeat = now;
  }, Math.min(200, timing.turn ?? 200));
  timer.unref();
  server.shutdown = async () => {
    stopping = true;
    clearInterval(timer);
    if (store) for (const [code, room] of rooms) void store.save(code, room.serialize()).catch(() => {});
    for (const room of rooms.values()) for (const peer of room.peers) peer.response.end();
    server.close();
    await store?.finish();
  };
  server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const host = process.env.SHIFT_HOST || '0.0.0.0';
  const port = Number(process.env.SHIFT_PORT || process.env.PORT || 4173);
  const server = createGameServer({ dataDirectory: process.env.SHIFT_DATA_DIR || fileURLToPath(new URL('./.last-shift-data/', import.meta.url)) });
  server.listen(port, host, () => {
    const activePort = server.address().port;
    console.log(`Локально  http://127.0.0.1:${activePort}`);
    const address = localAddress();
    if (address && host === '0.0.0.0') console.log(`По Wi-Fi  http://${address}:${activePort}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.shutdown());
}

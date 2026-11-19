import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createGameServer, localSpeaker, openAINarrator } from '../server.mjs';
import { durations } from '../game.mjs';

const nap = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function host(options = {}) {
  const server = createGameServer({ narrator: null, ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

function client(url) {
  let cookie = '';
  return {
    async open(path, body) {
      const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(9000) });
      const cookieHeader = response.headers.get('set-cookie');
      if (cookieHeader) cookie = cookieHeader.split(';')[0];
      return response;
    },
    get cookie() { return cookie; },
    useCookie(value) { cookie = value; },
  };
}

async function get(client, path, status = 200) {
  const response = await client.open(path);
  assert.equal(response.status, status, path);
  return response.json();
}

async function post(client, path, body, status = 200) {
  const response = await client.open(path, body);
  assert.equal(response.status, status, `${path} ${body.action ?? ''}`);
  return response.json();
}

function watch(url, path, cookie = '', clientId = '') {
  const controller = new AbortController();
  const events = [];
  const connection = fetch(`${url}${path}${clientId ? `&client=${clientId}` : ''}`, { headers: cookie ? { Cookie: cookie } : {}, signal: controller.signal }).then(async (response) => {
    assert.equal(response.status, 200);
    let data = '';
    const decoder = new TextDecoder();
    for await (const packet of response.body) {
      data += decoder.decode(packet, { stream: true });
      let end;
      while ((end = data.indexOf('\n\n')) >= 0) {
        const token = data.slice(0, end);
        data = data.slice(end + 2);
        const match = token.match(/^event: (.+)\ndata: (.+)$/);
        if (match) events.push({ kind: match[1], data: JSON.parse(match[2]) });
      }
    }
  }).catch((error) => { if (!controller.signal.aborted) throw error; });
  void connection.catch(() => {});
  return { events, close: () => controller.abort() };
}

async function until(action, message, ms = 6000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const value = await action();
    if (value) return value;
    await nap(20);
  }
  assert.fail(message);
}

async function crew(url, n = 4) {
  const views = [];
  const members = Array.from({ length: n }, () => client(url));
  const creator = members[0];
  const { code } = await post(creator, '/api/rooms', { name: 'Организатор' }, 201);
  const path = `/api/rooms/${code}`;
  await Promise.all(members.slice(1).map((member, index) => post(member, `${path}/join`, { name: `Гость ${index + 1}` })));
  for (const member of members) views.push(watch(url, `${path}/stream?view=player`, member.cookie));
  views.push(watch(url, `${path}/stream?view=tv`));
  await until(() => views.every((view) => view.events.some((event) => event.kind === 'state')), 'Все клиенты получают поток');
  await Promise.all(members.map((member) => post(member, `${path}/act`, { action: 'ready', value: true })));
  return { creator, path, code, members, tv: views.at(-1), close: () => views.forEach((view) => view.close()) };
}

test('HTTP roles and validation isolate the TV, player state and rooms', async () => {
  const { server, url } = await host();
  let game;
  try {
    game = await crew(url);
    const guest = game.members[1];
    const screen = client(url);
    const lonely = client(url);
    const duplicate = await post(lonely, `${game.path}/join`, { name: 'гость 1' }, 409);
    assert.match(duplicate.error, /ник уже занят/);
    assert.match((await post(lonely, `${game.path}/join`, { name: 'Фото', photo: 'data:image/jpeg;base64,YQ==' }, 400)).error, /Фото/);
    assert.equal((await screen.open(`${game.path}/qr`)).headers.get('content-type'), 'image/png');
    assert.equal((await screen.open('/dispatch.webp')).headers.get('content-type'), 'image/webp');
    assert.match((await screen.open('/')).headers.get('content-security-policy'), /script-src 'self'/);
    await get(screen, `${game.path}/state`, 401);
    await get(screen, `${game.path}/voice`, 401);
    await post(screen, `${game.path}/act`, { action: 'start', phaseId: 0 }, 401);
    await post(guest, `${game.path}/act`, { action: 'start', phaseId: 0 }, 403);
    const second = await post(lonely, '/api/rooms', { name: 'Сосед' }, 201);
    await get(guest, `/api/rooms/${second.code}/state`, 401);
    await post(guest, `${game.path}/voice`, { enabled: true, client: '11111111-1111-4111-8111-111111111111' }, 409);
    await post(guest, `${game.path}/signal`, { client: '11111111-1111-4111-8111-111111111111' }, 403);
    const intro = await post(game.creator, `${game.path}/act`, { action: 'start', phaseId: 0 });
    assert.equal(intro.self.hand.length, 4);
    const view = await get(screen, `${game.path}/public`);
    assert.equal(view.self, undefined);
    assert.equal(view.voice, undefined);
    assert.equal(view.discussion, undefined);
    assert.ok(view.players.every((player) => !('hand' in player) && !('secret' in player)));
    await post(guest, `${game.path}/act`, { action: 'remove-player', phaseId: intro.phaseId, value: intro.self.id }, 403);
    await post(game.creator, `${game.path}/act`, { action: 'remove-player', phaseId: intro.phaseId, value: intro.players[1].id }, 409);
    await post(lonely, `${game.path}/join`, { name: 'Опоздал' }, 409);
  } finally { game?.close(); await server.shutdown(); }
});

test('120 player sessions and 12 TV screens run concurrently without mixing rooms', async (t) => {
  const { server, url } = await host();
  const created = [];
  try {
    const start = performance.now();
    const batches = await Promise.all(Array.from({ length: 12 }, async () => {
      const game = await crew(url, 10);
      created.push(game);
      const snapshot = await post(game.creator, `${game.path}/act`, { action: 'start', phaseId: 0 });
      assert.equal(snapshot.phase, 'intro');
      assert.equal(snapshot.players.length, 10);
      assert.equal(snapshot.capacity, 5);
      await until(() => game.tv.events.some((event) => event.kind === 'state' && event.data.phase === 'intro' && event.data.code === game.code && !event.data.self), 'Телевизор получил вступление своей комнаты');
      const other = client(url);
      await post(other, `${game.path}/join`, { name: 'Опоздал' }, 409);
      return game.code;
    }));
    assert.equal(new Set(batches).size, 12);
    t.diagnostic(`132 потока SSE, ${Math.round(performance.now() - start)} мс для входа и запуска всех комнат.`);
  } finally { created.forEach((game) => game.close()); await server.shutdown(); }
});

function childServer(dataDirectory) {
  const cwd = fileURLToPath(new URL('../', import.meta.url));
  const program = `
    import { createGameServer } from './server.mjs';
    import { durations } from './game.mjs';
    const server = createGameServer({ narrator: null, timing: { ...durations, turn: 65, discuss: 80 } });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program], { cwd, env: { ...process.env, SHIFT_DATA_DIR: dataDirectory }, windowsHide: true });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', (chunk) => resolve({ child, url: `http://127.0.0.1:${Number(String(chunk).trim())}` }));
    child.once('exit', (status) => reject(new Error(`Сервер закрылся при запуске: ${status}`)));
  });
}

async function kill(child) {
  if (child?.exitCode === null && child.signalCode === null) {
    const done = once(child, 'exit');
    child.kill('SIGKILL');
    await done;
  }
}

test('hard process restart restores room, confirmed vote and deadline without revealing a ballot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'last-shift-restart-'));
  let instance;
  let game;
  try {
    instance = await childServer(directory);
    game = await crew(instance.url);
    const intro = await post(game.creator, `${game.path}/act`, { action: 'start', phaseId: 0 });
    await post(game.creator, `${game.path}/act`, { action: 'skip', phaseId: intro.phaseId });
    const vote = await until(async () => {
      const state = await get(game.creator, `${game.path}/state`);
      return state.phase === 'vote' && state;
    }, 'Голосование открылось');
    const target = vote.players[1].id;
    const before = await post(game.creator, `${game.path}/act`, { action: 'vote', phaseId: vote.phaseId, value: [target] });
    assert.equal(before.votesIn, 1);
    game.close();
    await kill(instance.child);
    await nap(130);
    instance = await childServer(directory);
    const restoredClient = client(instance.url);
    restoredClient.useCookie(game.creator.cookie);
    const restored = await get(restoredClient, `${game.path}/state`);
    assert.equal(restored.phase, 'vote');
    assert.equal(restored.phaseId, before.phaseId);
    assert.equal(restored.capacity, 2);
    assert.deepEqual(restored.self.ballot, [target]);
    assert.deepEqual(restored.self.hand, before.self.hand);
    assert.ok(restored.deadline - restored.now > 58000);
    const publicView = await get(client(instance.url), `${game.path}/public`);
    assert.equal(publicView.votesIn, 1);
    assert.equal(publicView.self, undefined);
    assert.equal(publicView.history.length, 0);
    const again = await post(restoredClient, `${game.path}/act`, { action: 'vote', phaseId: vote.phaseId, value: [] });
    assert.deepEqual(again.self.ballot, [target]);
    assert.equal(again.votesIn, 1);
  } finally { game?.close(); await kill(instance?.child); }
});

test('expiration closes TV streams and removes persisted room', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'last-shift-expiry-'));
  const { server, url } = await host({ dataDirectory: directory, roomTtl: 650 });
  let screen;
  try {
    const player = client(url);
    const { code } = await post(player, '/api/rooms', { name: 'Хранитель' }, 201);
    await access(join(directory, `${code}.json`));
    const path = `/api/rooms/${code}`;
    screen = watch(url, `${path}/stream?view=tv`);
    await until(() => screen.events.some((event) => event.kind === 'expired'), 'Телевизор получил событие истечения');
    await get(player, `${path}/state`, 404);
    await until(async () => access(join(directory, `${code}.json`)).then(() => false, () => true), 'Файл истёкшей комнаты удалён');
  } finally { screen?.close(); await server.shutdown(); }
});

test('OpenAI integration uses public facts and accepts fallback on unavailable responses', async () => {
  assert.equal(openAINarrator({ key: '', model: 'example' }), null);
  const calls = [];
  const narrator = openAINarrator({ key: 'fixture-key', model: 'fixture-model', request: async (url, request) => {
    calls.push({ url, request });
    return { ok: true, json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'Свет есть. Уже подозрительно.' }] }] }) };
  } });
  assert.equal(await narrator('radio', { round: 1, exits: 1, cards: ['Электрик'] }), 'Свет есть. Уже подозрительно.');
  assert.equal(calls[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(calls[0].request.headers.Authorization, 'Bearer fixture-key');
  assert.equal(JSON.parse(calls[0].request.body).store, false);
  assert.deepEqual(JSON.parse(JSON.parse(calls[0].request.body).input), { kind: 'radio', round: 1, exits: 1, cards: ['Электрик'] });
  const offline = openAINarrator({ key: 'fixture-key', model: 'fixture-model', request: async () => { throw new Error('Offline'); } });
  assert.equal(await offline('intro', {}), '');
});

test('speech plays current public cues, deduplicates requests and rejects stale phases', async () => {
  const fixture = Buffer.alloc(48);
  fixture.write('RIFF', 0, 'ascii');
  fixture.write('WAVE', 8, 'ascii');
  const generated = [];
  const { server, url } = await host({ speaker: async (text) => { generated.push(text); return fixture; } });
  let room;
  let game;
  try {
    game = await crew(url);
    room = game.path;
    const screen = client(url);
    await get(screen, `${room}/speech?phase=4&part=hello`, 409);
    const hello = await Promise.all(Array.from({ length: 4 }, () => screen.open(`${room}/speech?phase=0&part=hello`)));
    for (const response of hello) {
      assert.equal(response.headers.get('content-type'), 'audio/wav');
      assert.equal(Buffer.from(await response.arrayBuffer()).compare(fixture), 0);
    }
    assert.deepEqual(generated, ['Диспетчер на связи.']);
    const intro = await post(game.creator, `${room}/act`, { action: 'start', phaseId: 0 });
    const spoken = await screen.open(`${room}/speech?phase=${intro.phaseId}`);
    assert.equal(spoken.status, 200);
    await spoken.arrayBuffer();
    assert.match(generated[1], /отправится за шлюз/);
    await post(game.creator, `${room}/act`, { action: 'skip', phaseId: intro.phaseId });
    await get(screen, `${room}/speech?phase=${intro.phaseId}`, 409);
  } finally { game?.close(); await server.shutdown(); }
});

test('local speech adapter rejects invalid audio and forwards only the narration text', async () => {
  const spoken = [];
  const good = Buffer.alloc(60);
  good.write('RIFF', 0, 'ascii');
  good.write('WAVE', 8, 'ascii');
  const speaker = localSpeaker({ url: 'http://127.0.0.1:1', request: async (url, options) => {
    assert.equal(url.pathname, '/synthesize');
    spoken.push(JSON.parse(options.body));
    return new Response(good, { headers: { 'Content-Length': String(good.length) } });
  } });
  assert.equal((await speaker('Диспетчер на связи.')).compare(good), 0);
  assert.deepEqual(spoken, [{ text: 'Диспетчер на связи.', length_scale: 0.95 }]);
  const broken = localSpeaker({ url: 'http://127.0.0.1:1', request: async () => new Response('Wrong format') });
  await assert.rejects(broken('Тест'), /Invalid WAV/);
});

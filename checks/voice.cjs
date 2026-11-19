const assert = require('node:assert/strict');
const { once } = require('node:events');
const { chromium } = require('playwright');

(async () => {
  const { createGameServer } = await import('../server.mjs');
  const server = createGameServer({ narrator: null });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const executable = process.env.SHIFT_TEST_BROWSER;
  const streams = new Map();
  server.on('request', (request, response) => {
    if (request.url.includes('/stream?view=player')) streams.set(request.headers.cookie, response);
  });
  let browser;
  try {
    browser = await chromium.launch({ executablePath: executable, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    const errors = [];
    async function makePage() {
      const context = await browser.newContext({ viewport: { width: 390, height: 840 }, permissions: ['microphone'] });
      const page = await context.newPage();
      page.setDefaultTimeout(12000);
      page.on('pageerror', ({ message }) => errors.push(message));
      await page.addInitScript(() => {
        const Native = window.RTCPeerConnection;
        window.connections = [];
        window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.connections.push(this); } };
      });
      return page;
    }
    const [host, guest, third, tv] = await Promise.all([makePage(), makePage(), makePage(), makePage()]);
    await host.goto(url);
    await host.getByRole('textbox', { name: 'Ваш ник' }).fill('Саша');
    await host.getByRole('button', { name: 'Создать', exact: true }).click();
    await host.waitForURL('**/play?room=*');
    const room = new URL(host.url()).searchParams.get('room');
    await tv.goto(`${url}/tv?room=${room}`);
    await tv.getByRole('heading', { name: `Комната ${room}` }).waitFor();
    const enter = async (page, name) => {
      await page.goto(`${url}/join?room=${room}`);
      await page.getByRole('textbox', { name: 'Ваш ник' }).fill(name);
      await page.getByRole('button', { name: 'Войти', exact: true }).click();
      await page.waitForURL('**/play?room=*');
    };
    await Promise.all([enter(guest, 'Даша'), enter(third, 'Макс')]);
    const connect = async (page) => {
      await page.getByText('Голос комнаты', { exact: true }).click();
      await page.getByRole('button', { name: 'Подключить микрофон' }).click();
      await page.getByRole('button', { name: 'Выключить микрофон' }).waitFor();
    };
    const checkRtp = (page, count) => page.waitForFunction(async (min) => {
      const established = window.connections.filter((pc) => pc.connectionState === 'connected');
      if (established.length !== min) return false;
      for (const pc of established) {
        const stats = [...(await pc.getStats()).values()];
        if (!stats.some((report) => report.type === 'inbound-rtp' && report.kind === 'audio' && report.bytesReceived > 0)) return false;
      }
      return true;
    }, count);
    await connect(host);
    await connect(guest);
    await Promise.all([checkRtp(host, 1), checkRtp(guest, 1)]);
    await connect(third);
    await Promise.all([checkRtp(host, 2), checkRtp(guest, 2), checkRtp(third, 2)]);
    const guestCookie = (await guest.context().cookies(url)).find(({ name }) => name === `shift_${room}`);
    const activeStream = streams.get(`${guestCookie.name}=${guestCookie.value}`);
    const oldPeerCount = await guest.evaluate(() => window.connections.length);
    activeStream.destroy();
    await guest.waitForFunction((previous) => window.connections.length > previous, oldPeerCount);
    await Promise.all([checkRtp(host, 2), checkRtp(guest, 2), checkRtp(third, 2)]);
    assert.equal(await tv.locator('audio').count(), 0);
    assert.equal((await (await fetch(`${url}/api/rooms/${room}/public`)).json()).voice, undefined);
    await host.getByRole('button', { name: 'Выключить микрофон' }).click();
    await host.getByRole('button', { name: 'Включить микрофон' }).waitFor();
    assert.equal(await host.evaluate(() => window.connections.filter((pc) => pc.connectionState === 'connected').flatMap((pc) => pc.getSenders()).every((sender) => !sender.track.enabled)), true);
    await host.getByRole('button', { name: 'Включить микрофон' }).click();
    await host.getByRole('button', { name: 'Выключить микрофон' }).waitFor();
    await third.getByRole('button', { name: 'Выйти из голоса' }).click();
    await Promise.all([checkRtp(host, 1), checkRtp(guest, 1)]);
    await third.getByRole('button', { name: 'Подключить микрофон' }).click();
    await Promise.all([checkRtp(host, 2), checkRtp(guest, 2), checkRtp(third, 2)]);
    await host.getByRole('button', { name: 'Убрать Макс из лобби' }).click();
    await third.getByText('Организатор убрал вас из лобби.').waitFor();
    await Promise.all([checkRtp(host, 1), checkRtp(guest, 1)]);
    assert.deepEqual(errors, []);
    console.log('WebRTC: real local RTP among three independent browser profiles, forced connection loss and recovery, mute, leave, rejoin, lobby removal, TV isolation.');
  } finally { await browser?.close(); await server.shutdown(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

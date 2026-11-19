const assert = require('node:assert/strict');
const { once } = require('node:events');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const playwright = require('playwright');

(async () => {
  const directory = path.dirname(__dirname);
  const { createGameServer, localSpeaker } = await import(pathToFileURL(path.join(directory, 'server.mjs')));
  const { durations } = await import(pathToFileURL(path.join(directory, 'game.mjs')));
  const speaker = localSpeaker({ url: process.env.SHIFT_TEST_SPEECH_URL });
  const server = createGameServer({ timing: { ...durations, discuss: 700, radio: speaker ? 4800 : 1200 }, narrator: null, speaker });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    const ok = await fetch(url);
    assert.equal(ok.status, 200);
    const engine = process.env.SHIFT_TEST_ENGINE || 'chromium';
    browser = await playwright[engine].launch({ executablePath: process.env.SHIFT_TEST_BROWSER, headless: true });
    const evidence = process.env.SHIFT_TEST_EVIDENCE;
    const errors = [];
    async function page(width) {
      const device = width === 390 && engine === 'webkit' ? playwright.devices['iPhone 13'] : {};
      const context = await browser.newContext({ ...device, viewport: { width, height: 850 } });
      const page = await context.newPage();
      page.setDefaultTimeout(8000);
      page.on('pageerror', ({ message }) => errors.push(message));
      return page;
    }
    async function waitTitle(page, title) {
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
    }
    const [host, guest1, guest2, guest3, tv] = await Promise.all([page(390), page(390), page(390), page(390), page(1280)]);
    if (speaker) await tv.addInitScript(() => {
      const NativeAudio = window.Audio;
      window.actualClips = [];
      window.Audio = function (...args) {
        const clip = new NativeAudio(...args);
        window.actualClips.push(clip);
        return clip;
      };
    });
    else await tv.addInitScript(() => {
      window.spoken = [];
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
        getVoices: () => [{ lang: 'ru-RU', localService: true }],
        speak: (utterance) => window.spoken.push(utterance.text), cancel: () => window.spoken.push('cancel'),
      } });
      window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    });
    await host.goto(url);
    await host.getByRole('textbox', { name: 'Ваш ник' }).fill('Стас');
    const photo = host.waitForEvent('filechooser');
    await host.getByRole('button', { name: 'Из галереи', exact: true }).click();
    await (await photo).setFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgElEQVR4nNXOQREAIAzAsFKXSMEDohGxB9coyNrnUiZxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEidxEufvwNQDOWMB3hcTNsoAAAAASUVORK5CYII=', 'base64') });
    await host.getByRole('img', { name: 'Фото игрока Стас' }).waitFor();
    await host.getByRole('button', { name: 'Создать', exact: true }).click();
    await host.waitForURL('**/play?room=*');
    const code = new URL(host.url()).searchParams.get('room');
    const statePath = `${url}/api/rooms/${code}`;
    const publicState = async () => (await fetch(`${statePath}/public`)).json();
    await tv.goto(`${url}/tv?room=${code}`);
    await tv.getByRole('img', { name: 'Фото игрока Стас' }).waitFor();
    assert.equal(await tv.getByRole('img', { name: 'Фото игрока Стас' }).evaluate((image) => image.complete && image.naturalWidth === 360), true);
    await tv.getByRole('button', { name: 'Включить звук' }).click();
    if (speaker) await tv.waitForFunction(() => window.actualClips.some((clip) => clip.src.includes('part=hello') && clip.currentTime > .05));
    await tv.getByRole('img', { name: 'QR-код для входа в комнату' }).waitFor();
    assert.equal((await fetch(`${statePath}/qr`)).headers.get('content-type'), 'image/png');
    if (evidence) await tv.screenshot({ path: path.join(evidence, 'last-shift-tv.png'), fullPage: true });

    for (const [guest, name] of [[guest1, 'Ира'], [guest2, 'Макс'], [guest3, 'Лена']]) {
      await guest.goto(`${url}/join?room=${code}`);
      await guest.getByRole('textbox', { name: 'Ваш ник' }).fill(name);
      await guest.getByRole('button', { name: 'Войти', exact: true }).click();
      await guest.waitForURL('**/play?room=*');
      await guest.getByRole('button', { name: 'Готов', exact: true }).click();
    }
    await host.getByRole('button', { name: 'Готов', exact: true }).click();
    await host.getByRole('button', { name: 'Начать', exact: true }).click();
    await waitTitle(tv, 'Все уже внутри');
    if (speaker) await tv.waitForFunction(() => window.actualClips.some((clip) => clip.src.includes('phase=1&part=base') && clip.duration > 7 && clip.currentTime > .05));
    assert.equal((await fetch(`${statePath}/state`)).status, 401);
    assert.equal((await publicState()).self, undefined);
    assert.equal(await guest1.getByRole('button', { name: 'Пропустить правила', exact: true }).count(), 0);
    await host.getByRole('button', { name: 'Пропустить правила', exact: true }).click();
    await waitTitle(tv, 'Ходит Стас');
    if (speaker) {
      assert.equal(await tv.evaluate(() => window.actualClips.some((clip) => clip.src.includes('phase=1&part=base') && !clip.paused)), false);
    } else {
      const voice = await tv.evaluate(() => window.spoken);
      assert.ok(voice.some((line) => line.startsWith('Так, все уже внутри.')));
      assert.equal(voice.at(-2), 'cancel');
    }
    const reveal = host.locator('[data-action="reveal"]');
    const title = await reveal.locator('strong').textContent();
    assert.equal((await tv.locator('body').textContent()).includes(title), false);
    if (evidence) await host.screenshot({ path: path.join(evidence, 'last-shift-phone.png'), fullPage: true });
    const mapping = { Стас: host, Ира: guest1, Макс: guest2, Лена: guest3 };
    async function revealCircle(members) {
      for (let i = 0; i < members; i += 1) {
        await tv.waitForFunction(() => document.querySelector('h1')?.textContent.startsWith('Ходит '));
        const active = (await tv.locator('h1').textContent()).slice(6);
        const current = mapping[active];
        await current.locator('[data-action="reveal"]').first().click();
        await current.getByRole('button', { name: 'Передать ход', exact: true }).click();
        await tv.waitForFunction((previous) => document.querySelector('h1')?.textContent !== `Ходит ${previous}`, active);
      }
    }
    await revealCircle(4);
    await waitTitle(tv, 'Кого отправим за шлюз?');
    await host.setViewportSize({ width: 320, height: 720 });
    assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (evidence) await host.screenshot({ path: path.join(evidence, 'last-shift-ballot.png'), fullPage: true });
    await host.getByRole('button', { name: /^Макс/ }).click();
    await host.getByRole('button', { name: 'Голосовать', exact: true }).click();
    await host.getByRole('heading', { name: 'Голос принят', exact: true }).waitFor();
    const partial = await publicState();
    assert.equal(partial.votesIn, 1);
    assert.equal(partial.history.length, 0);
    await host.reload();
    await host.getByRole('heading', { name: 'Голос принят', exact: true }).waitFor();
    await guest1.getByRole('button', { name: /^Макс/ }).click();
    await guest1.getByRole('button', { name: 'Голосовать', exact: true }).click();
    await guest2.getByRole('button', { name: 'Воздержаться', exact: true }).click();
    await guest3.getByRole('button', { name: 'Воздержаться', exact: true }).click();
    await waitTitle(tv, 'Радио смены');
    await tv.getByRole('heading', { name: 'За шлюзом · Макс', exact: true }).waitFor();
    assert.equal((await publicState()).players.find(({ name }) => name === 'Макс').inside, false);
    if (speaker) await tv.waitForFunction((phase) => window.actualClips.some((clip) => clip.src.includes(`phase=${phase}&part=base`) && clip.duration > 7 && clip.currentTime > .05), (await publicState()).phaseId);
    else assert.ok((await tv.evaluate(() => window.spoken)).some((line) => line.startsWith('Сводка круга 1.')));

    await revealCircle(3);
    await tv.waitForFunction(() => document.querySelector('.eyebrow')?.textContent.startsWith('Круг 3'));
    await revealCircle(3);
    await waitTitle(tv, 'Кого отправим за шлюз?');
    assert.equal(await guest2.getByRole('button', { name: /^Макс/ }).count(), 0);
    await host.getByRole('button', { name: /^Лена/ }).click();
    await host.getByRole('button', { name: 'Голосовать', exact: true }).click();
    await guest1.getByRole('button', { name: 'Воздержаться', exact: true }).click();
    await guest2.getByRole('button', { name: /^Лена/ }).click();
    await guest2.getByRole('button', { name: 'Голосовать', exact: true }).click();
    await guest3.getByRole('button', { name: 'Воздержаться', exact: true }).click();
    await tv.getByRole('heading', { name: /Убежище готово|Аварийный режим/ }).waitFor();
    const result = await publicState();
    assert.equal(result.phase, 'final');
    assert.equal(result.players.filter(({ inside }) => inside).length, 2);
    assert.equal(result.players.every(({ finalHand }) => finalHand.length === 4), true);
    await host.getByRole('button', { name: 'Новая партия', exact: true }).click();
    await waitTitle(tv, `Комната ${code}`);
    assert.deepEqual(errors, []);
    console.log(`${engine}: full game with four phones and TV, mobile width, shared photo, QR, ${speaker ? 'playing real Russian WAV and stopping introduction' : 'audio events'}, reconnect, private state, exile and reset.`);
  } finally {
    await browser?.close();
    await server.shutdown();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

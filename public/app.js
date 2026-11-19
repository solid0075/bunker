import { browserClientId, RoomVoice } from '/voice.js';

const app = document.querySelector('#app');
const tools = document.querySelector('#mast-tools');
const notice = document.querySelector('#notice');
const code = new URLSearchParams(location.search).get('room')?.toUpperCase() ?? '';
const tv = location.pathname === '/tv';
const inRoom = Boolean(code) && (tv || location.pathname === '/play');
const codeOk = /^[2-9A-HJ-NP-Z]{5}$/;
const ui = { state: null, marks: new Set(), clockShift: 0, photo: '', photoRequest: 0, chat: '', opened: new Set(), speaking: false, voicePhase: null, busy: false };
const labels = { lobby: 'Лобби', intro: 'Вступление', turn: 'Раскрытие', discuss: 'Обсуждение', vote: 'Голосование', runoff: 'Переголосование', radio: 'Радио смены', final: 'Итоги' };
const html = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const urlFor = (path, room) => `${path}?room=${encodeURIComponent(room)}`;
let config = { origin: location.origin };
let stream;
let chime;
const voice = inRoom && !tv ? new RoomVoice({
  client: browserClientId(),
  request: (endpoint, body) => api(`/api/rooms/${encodeURIComponent(code)}/${endpoint}`, body),
  onStatus: paintVoice,
  onError: (message) => inform(message, true),
}) : null;

async function api(path, body) {
  const result = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await result.json();
  if (!result.ok) throw Object.assign(new Error(data.error || 'Не удалось связаться с сервером.'), { status: result.status });
  return data;
}

function inform(message = '', error = false) {
  notice.textContent = message;
  notice.hidden = !message;
  notice.classList.toggle('error', error);
}

function avatar(player, big = false) {
  const label = [...player.name][0]?.toLocaleUpperCase('ru') || '•';
  return `<span class="avatar${big ? ' big' : ''}"${player.photo ? '' : ' aria-hidden="true"'}>${player.photo ? `<img src="${html(player.photo)}" alt="Фото игрока ${html(player.name)}">` : html(label)}</span>`;
}

function shotInputs() {
  return '<input type="file" accept="image/*" data-image="gallery" aria-label="Фото из галереи" hidden><input type="file" accept="image/*" capture="user" data-image="camera" aria-label="Снимок с камеры" hidden>';
}

function shotButtons() {
  return '<button type="button" data-pick="gallery">Из галереи</button><button type="button" data-pick="camera">Сфоткаться</button><button type="button" data-local="remove-photo" data-photo-remove hidden>Убрать фото</button>';
}

function paintProfile() {
  const profile = app.querySelector('[data-preview]');
  if (!profile) return;
  const name = app.querySelector('[name="nick"]')?.value.trim() || 'Игрок';
  profile.innerHTML = avatar({ name, photo: ui.photo }, true);
  app.querySelector('[data-photo-remove]').hidden = !ui.photo;
}

function formatPhoto(file) {
  if (!file || file.size > 20_000_000 || !file.type.startsWith('image/') || file.type === 'image/svg+xml') return Promise.reject(new Error('Выберите фотографию размером до 20 МБ.'));
  return new Promise((resolve, reject) => {
    const address = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 360;
        const context = canvas.getContext('2d');
        const size = Math.min(image.naturalWidth, image.naturalHeight);
        context.fillStyle = '#263227';
        context.fillRect(0, 0, 360, 360);
        context.drawImage(image, (image.naturalWidth - size) / 2, (image.naturalHeight - size) / 2, size, size, 0, 0, 360, 360);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } catch { reject(new Error('Фото не удалось подготовить. Попробуйте другой снимок.')); }
      finally { URL.revokeObjectURL(address); }
    };
    image.onerror = () => { URL.revokeObjectURL(address); reject(new Error('Браузер не открыл фото. Попробуйте JPEG или PNG.')); };
    image.src = address;
  });
}

function renderEntry(mode) {
  const creates = mode === 'create';
  const plays = mode === 'join';
  const shows = mode === 'tv';
  const title = creates ? 'Соберите свою смену' : plays ? 'Вход в смену' : 'Общий экран';
  app.innerHTML = `<div class="shell entry"><section class="stage ${creates ? 'cinematic' : ''}"><p class="eyebrow">${shows ? 'Телевизор' : creates ? 'Игра на 4–10 человек' : 'Телефон игрока'}</p><h1>${title}</h1><p class="muted">${creates ? 'Вы уже в убежище. Резерва хватит только на половину смены. Создайте комнату и выведите QR на телевизор.' : plays ? 'Подключитесь по коду, выберите ник и при желании добавьте фото.' : 'Введите код комнаты, чтобы показать ход партии на телевизоре.'}</p></section>
    <section class="block"><div class="entry-switch" aria-label="Режим входа">${[['create', 'Создать комнату'], ['join', 'Войти по коду'], ['tv', 'Экран ТВ']].map(([value, name]) => `<button type="button" data-entry-mode="${value}" aria-pressed="${mode === value}">${name}</button>`).join('')}</div>
    <form class="gap" id="entry" data-mode="${mode}">${creates ? '' : `<label class="field">Код комнаты<input name="room" value="${html(codeOk.test(code) ? code : '')}" required maxlength="5" autocapitalize="characters" autocomplete="off"></label>`}${shows ? '' : `<label class="field">Ваш ник<input name="nick" required maxlength="20" autocomplete="nickname"></label><div class="profile-photo"><span data-preview></span><div class="toolbar">${shotButtons()}</div></div><p class="profile-note">Фото появится в комнате после входа.</p>${shotInputs()}`}
    ${creates ? '<label class="setting"><input name="mature" type="checkbox">Эфир с матом · 18+</label>' : ''}<div><button class="primary" type="submit">${title === 'Вход в смену' ? 'Войти' : creates ? 'Создать' : 'Показать комнату'}</button></div></form></section></div>`;
  paintProfile();
}

function playerCard(player, description = '') {
  return `<div class="person">${avatar(player)}<div><strong class="name">${html(player.name)}</strong>${description ? `<span class="desc">${html(description)}</span>` : ''}</div></div>`;
}

function roster(state) {
  const status = (player) => {
    if (state.phase === 'lobby') return player.ready && player.connected ? 'Готов' : player.connected ? 'В комнате' : 'Отключён';
    const cards = (player.finalHand || player.opened.map(({ card }) => card)).map((card) => card.title).join(' · ');
    return [player.inside ? '' : 'За шлюзом', cards].filter(Boolean).join(' · ') || 'Карта ещё не открыта';
  };
  return `<ul class="roster">${state.players.map((player) => `<li class="${player.id === state.active ? 'active' : ''} ${player.inside ? '' : 'outside'}">${playerCard(player, status(player))}${state.phase === 'lobby' && state.self?.organizer && player.id !== state.self.id ? `<button type="button" class="roster-remove" data-action="remove-player" data-value="${player.id}" aria-label="Убрать ${html(player.name)} из лобби">Убрать</button>` : ''}</li>`).join('')}</ul>`;
}

function characterCards(state) {
  const self = state.players.find(({ id }) => id === state.self.id);
  if (!state.self.hand.length) return '';
  return `<div class="card-marks">${state.self.hand.map((card) => {
    const opened = self.opened.some((entry) => entry.card.id === card.id);
    return `<div class="character-card${opened ? ' opened' : ''}"><span class="small muted">${html(state.categories[card.category])} · ${opened ? 'Открыта' : 'Личная'}</span><strong>${html(card.title)}</strong><span class="small muted">${html(card.tag)}</span></div>`;
  }).join('')}</div>`;
}

function systemsBlock(state) {
  if (!state.systems.length) return '';
  const name = (id) => state.players.find((player) => player.id === id)?.name || '';
  return `<section class="block"><h2>Системы убежища</h2><ul class="skills">${state.systems.map((system, index) => {
    const result = state.result?.[index];
    const running = result?.pair.length;
    let details = system.tags.join(' + ');
    if (result) details += running ? ` · ${result.pair.map(name).join(' и ')}` : result.missing.length ? ` · не хватает ${result.missing.join(' и ')}` : ' · нужен второй персонаж';
    return `<li><div class="rail"><strong>${html(system.name)}</strong><span class="state-label${running ? ' running' : ''}">${running ? 'Запущена' : 'Сбой'}</span></div><p class="muted small">${html(details)}</p></li>`;
  }).join('')}</ul></section>`;
}

function clock(state) {
  return state.deadline || state.paused ? `<span class="clock mono" data-clock aria-label="Время фазы"></span>` : '';
}

function currentTitle(state) {
  switch (state.phase) {
    case 'lobby': return `Комната ${state.code}`;
    case 'intro': return 'Все уже внутри';
    case 'turn': {
      if (state.self && state.active === state.self.id) return 'Ваш ход';
      return `Ходит ${state.players.find((player) => player.id === state.active)?.name ?? ''}`;
    }
    case 'discuss': return 'Обсуждение';
    case 'vote': return 'Кого отправим за шлюз?';
    case 'runoff': return 'Ничья. Голосуем снова';
    case 'radio': return 'Радио смены';
    case 'final': return state.result.filter((item) => item.pair.length).length >= 2 ? 'Убежище готово' : 'Аварийный режим';
    default: return labels[state.phase];
  }
}

function banner(state) {
  const inside = state.players.filter((player) => player.inside).length;
  const self = state.players.find((player) => player.id === state.self?.id);
  const active = tv && state.phase === 'turn' && state.players.find((player) => player.id === state.active);
  const art = tv && ['lobby', 'intro', 'radio', 'final'].includes(state.phase);
  return `<section class="stage${art ? ' cinematic' : ''}"><div class="rail"><p class="eyebrow">${state.round ? `Круг ${state.round} из 3 · ` : ''}${labels[state.phase]}</p>${clock(state)}</div><div class="rail hero-title"><h1>${html(currentTitle(state))}</h1>${active ? avatar(active, true) : ''}</div>${state.capacity ? `<p class="muted">${inside} внутри · Резерв на ${state.capacity}${self?.inside === false ? ' · Вы за шлюзом' : ''}</p>` : ''}</section>`;
}

function dispatch(state) {
  if (!state.readout) return '';
  return `<section class="block dispatch"><div class="rail"><h2>${state.phase === 'radio' ? '<span class="on-air" aria-hidden="true"></span>' : ''}Диспетчер</h2>${state.phase === 'radio' ? `<span class="state-label">Общий эфир${state.mature ? ' · 18+' : ''}</span>` : ''}</div><p class="speech">${html(state.readout)}</p></section>`;
}

function voteRecord(state, entry) {
  return `<div class="tight"><strong>${entry.runoff ? 'Переголосование' : 'Основное голосование'}</strong><p class="small muted">${entry.counts.map(({ id, count }) => `${html(state.players.find((player) => player.id === id)?.name)} · ${count}`).join(' / ')}</p></div>`;
}

function lastExile(state) {
  const entry = state.history.at(-1);
  if (!entry || state.phase !== 'radio') return '';
  const names = entry.out.map((id) => state.players.find((player) => player.id === id)?.name).join(', ');
  return `<section class="block"><h2>За шлюзом · ${html(names)}</h2>${entry.ballots.map((ballot) => voteRecord(state, ballot)).join('')}${entry.draw ? '<p class="small muted">Повторную ничью решил жребий.</p>' : ''}</section>`;
}

function voteProgress(state) {
  return `<section class="block"><div class="rail"><h2>Бюллетени</h2><strong>${state.votesIn} из ${state.players.length}</strong></div><progress class="progress" aria-label="Принятые бюллетени" value="${state.votesIn}" max="${state.players.length}"></progress><p class="muted">В этом круге за шлюз уйдут · ${state.slotCount}</p>${state.published ? voteRecord(state, state.published) : ''}</section>`;
}

function historyBlock(state) {
  if (!state.history.length || state.phase !== 'final') return '';
  return `<section class="block"><h2>Голосования</h2>${state.history.map((entry) => `<div class="tight"><h3>Круг ${entry.round}</h3>${entry.ballots.map((record) => voteRecord(state, record)).join('')}</div>`).join('')}</section>`;
}

function renderTv(state) {
  const sound = ui.speaking ? 'Звук включён' : 'Включить звук';
  tools.innerHTML = `<span class="small muted">Общий экран</span><button type="button" class="voice-control" data-local="sound" aria-pressed="${ui.speaking}">${sound}</button>`;
  const lobby = `<section class="block"><div class="qr-area"><img class="qr" src="/api/rooms/${state.code}/qr" alt="QR-код для входа в комнату"><div class="tight"><h2>Подключитесь с телефона</h2><strong class="mono room-code">${state.code}</strong><a href="${html(config.origin + urlFor('/join', state.code))}">Вход по ссылке</a>${state.mature ? '<p class="state-label">Общий эфир с матом · 18+</p>' : ''}</div></div></section>`;
  const extra = ['vote', 'runoff'].includes(state.phase) ? voteProgress(state) : lastExile(state);
  app.innerHTML = `<div class="shell tv">${banner(state)}${state.phase === 'lobby' ? lobby : dispatch(state)}${extra}<div class="${state.systems.length ? 'split' : 'gap'}"><section class="block"><div class="rail"><h2>${state.phase === 'lobby' ? 'Игроки' : 'Смена'}</h2><span class="small muted">${state.phase === 'lobby' ? `${state.players.filter((player) => player.ready && player.connected).length} готовы` : `${state.players.filter((player) => player.inside).length} внутри`}</span></div>${roster(state)}</section>${systemsBlock(state)}</div>${historyBlock(state)}</div>`;
}

function votePanel(state) {
  if (state.self.ballot) return `<section class="block"><h2>Голос принят</h2><p class="muted">${state.votesIn} из ${state.players.length} бюллетеней получено. Ваш выбор известен только вам.</p></section>`;
  return `<section class="block"><div class="rail"><h2>Тайный бюллетень</h2><strong class="state-label" data-vote-count></strong></div><p class="muted">Выберите, кто должен выйти из бункера.</p>${state.players.filter((player) => state.self.candidates.includes(player.id)).map((player) => `<button type="button" class="choice" data-vote-id="${player.id}" aria-pressed="false" ${state.paused ? 'disabled' : ''}>${playerCard(player, player.opened.at(-1)?.card.title)}</button>`).join('')}<div class="toolbar"><button class="primary" type="button" data-action="vote" data-value="marks" disabled>Голосовать</button><button type="button" data-action="vote" data-value="empty" ${state.paused ? 'disabled' : ''}>Воздержаться</button></div></section>`;
}

function updateVoteControls(state = ui.state) {
  const count = app.querySelector('[data-vote-count]');
  if (!count) return;
  count.textContent = `${ui.marks.size} из ${state.slotCount}`;
  app.querySelectorAll('[data-vote-id]').forEach((choice) => choice.setAttribute('aria-pressed', String(ui.marks.has(choice.dataset.voteId))));
  app.querySelector('[data-value="marks"]').disabled = !ui.marks.size || state.paused;
}

function phoneAction(state, self) {
  const controls = (action, label, value, off = false) => `<button type="button" class="primary" data-action="${action}"${value === undefined ? '' : ` data-value="${html(value)}"`}${off || state.paused ? ' disabled' : ''}>${label}</button>`;
  if (state.phase === 'lobby') {
    const canStart = state.players.length >= 4 && state.players.every((player) => player.ready && player.connected);
    return `<section class="block"><h2>Подготовка</h2><div class="toolbar">${controls('ready', self.ready ? 'Снять готовность' : 'Готов', self.ready ? 'false' : 'true')}${state.self.organizer ? controls('start', 'Начать', undefined, !canStart) : ''}<a class="button" target="_blank" rel="noopener" href="${html(config.origin + urlFor('/tv', state.code))}">Открыть экран ТВ</a></div>${state.self.organizer ? `<label class="setting"><input type="checkbox" data-mature ${state.mature ? 'checked' : ''}>Эфир с матом · 18+</label>` : state.mature ? '<p class="state-label">Общий эфир с матом · 18+</p>' : ''}<label class="field">Ссылка для игроков<input type="text" readonly value="${html(config.origin + urlFor('/join', state.code))}" data-invite></label></section>`;
  }
  if (state.phase === 'intro') return `<section class="block"><h2>Диспетчер объясняет правила</h2><p class="muted">Общий экран читает вступление. Первый ход откроется автоматически.</p>${state.self.organizer ? `<div>${controls('skip', 'Пропустить правила')}</div>` : ''}</section>`;
  if (state.phase === 'turn' && state.active === self.id) {
    const allowed = state.self.hand.filter((card) => state.self.allowed.includes(card.category));
    return `<section class="block"><h2>${allowed.length ? 'Раскройте карту' : 'Ваше выступление'}</h2>${allowed.length ? allowed.map((card) => `<button type="button" class="choice" data-action="reveal" data-value="${card.id}" ${state.paused ? 'disabled' : ''}><span class="small muted">${html(state.categories[card.category])}</span><strong>${html(card.title)}</strong><span class="small muted">${html(card.tag)}</span></button>`).join('') : `<p class="muted">Карта уже на телевизоре. Расскажите, чем поможете смене.</p><div>${controls('pass', 'Передать ход')}</div>`}</section>`;
  }
  if (state.phase === 'vote' || state.phase === 'runoff') return votePanel(state);
  if (state.phase === 'radio') {
    const note = state.journal.at(-1)?.note;
    return `<section class="block"><h2>${self.inside ? 'Вы внутри' : 'Вы за шлюзом'}</h2><p class="muted">Идёт общий эфир. После него партия продолжится автоматически.</p>${note ? `<div class="character-card"><p class="small muted">Личная реплика · ${html(note.title)}</p><p>${html(note.text)}</p></div>` : ''}</section>`;
  }
  if (state.phase === 'final') return `<section class="block"><h2>${self.inside ? 'Вы остались в бункере' : 'Вы за шлюзом'}</h2><p>Запущено систем · ${state.result.filter((item) => item.pair.length).length} из 3.</p>${state.self.organizer ? `<div>${controls('restart', 'Новая партия')}</div>` : ''}</section>`;
  return '';
}

function details(id, label, contents) {
  return `<details class="block" data-details="${id}" ${ui.opened.has(id) ? 'open' : ''}><summary class="summary">${label}</summary>${contents}</details>`;
}

function paintVoice() {
  const panel = app.querySelector('[data-voice-panel]');
  if (!panel || !voice) return;
  if (!voice.available) {
    panel.innerHTML = '<p class="muted">Голос игроков доступен по защищённому адресу комнаты. Чат работает и в локальной сети.</p>';
    return;
  }
  if (!voice.stream) {
    panel.innerHTML = `<p class="muted">Для участников, которые играют из разных комнат.</p><button type="button" data-local="voice-join" ${voice.starting || !voice.online ? 'disabled' : ''}>${voice.starting ? 'Подключаем микрофон…' : 'Подключить микрофон'}</button>`;
    return;
  }
  panel.innerHTML = `<p class="muted" role="status">${!voice.online || !voice.session ? 'Восстанавливаем связь…' : `На связи · ${voice.connected} ${voice.connected === 1 ? 'собеседник' : voice.connected >= 2 && voice.connected <= 4 ? 'собеседника' : 'собеседников'}`}</p><div class="toolbar"><button type="button" data-local="voice-mute" aria-pressed="${voice.muted}">${voice.muted ? 'Включить микрофон' : 'Выключить микрофон'}</button><button type="button" data-local="voice-leave">Выйти из голоса</button>${voice.needsPlayback ? '<button type="button" data-local="voice-play">Включить звук игроков</button>' : ''}</div>`;
}

function renderPhone(state) {
  const self = state.players.find((player) => player.id === state.self.id);
  const editableChat = document.activeElement?.matches('[name="message"]');
  const start = editableChat ? document.activeElement.selectionStart : null;
  const end = editableChat ? document.activeElement.selectionEnd : null;
  tools.innerHTML = `<span class="small muted">${html(self.name)} · ${state.code}</span>${state.self.organizer && !['lobby', 'final'].includes(state.phase) ? `<button type="button" data-action="${state.paused ? 'resume' : 'pause'}">${state.paused ? 'Продолжить' : 'Пауза'}</button>` : ''}`;
  const elements = [
    banner(state), phoneAction(state, self),
    state.phase === 'lobby' ? `<section class="block"><h2>Смена</h2>${roster(state)}</section>` : '',
    state.phase !== 'lobby' && state.phase !== 'vote' && state.phase !== 'runoff' ? dispatch(state) : '',
    state.self.hand.length ? details('hand', 'Мои карты', characterCards(state)) : '',
    state.phase !== 'lobby' ? details('roster', 'Открытые карты', roster(state)) : '',
    state.systems.length ? details('systems', 'Требования систем', systemsBlock(state)) : '',
    state.journal.length ? details('journal', 'Журнал смены', `<ul class="list">${state.journal.map((entry) => `<li>${html(entry.text)}${entry.note ? `<p class="small muted">${html(entry.note.text)}</p>` : ''}</li>`).join('')}</ul>`) : '',
    config.remoteVoice ? details('voice', 'Голос комнаты', '<div class="tight" data-voice-panel></div>') : '',
    details('chat', 'Чат комнаты', `<ul class="discussion" aria-label="Сообщения">${state.discussion.map(({ name, text }) => `<li><strong>${html(name)}</strong> · ${html(text)}</li>`).join('')}</ul><form id="chat" class="chat-entry"><input type="text" name="message" aria-label="Сообщение" placeholder="Сообщение" maxlength="240" value="${html(ui.chat)}" required><button type="submit">Отправить</button></form>`),
    details('rules', 'Правила', `<p class="muted">${html(state.incident)} Откройте карту в свой ход. После обсуждения голосуйте за выход из бункера. За себя голосовать нельзя. У состоявшегося голосования есть итог и радиосводка.</p>`),
    details('photo', 'Фото профиля', `<div class="profile-photo">${avatar(self, true)}<div class="toolbar"><button type="button" data-pick="gallery">Из галереи</button><button type="button" data-pick="camera">Сфоткаться</button>${self.photo ? '<button type="button" data-action="photo" data-value="remove">Убрать фото</button>' : ''}</div></div>${shotInputs()}`),
  ];
  app.innerHTML = `<div class="shell phone">${elements.join('')}</div>`;
  paintVoice();
  updateVoteControls(state);
  if (editableChat) {
    const field = app.querySelector('[name="message"]');
    field.focus({ preventScroll: true });
    field.setSelectionRange(start, end);
  }
}

function updateClock() {
  const output = document.querySelector('[data-clock]');
  const state = ui.state;
  if (!output || !state) return;
  const target = state.paused ? state.pauseUntil : state.deadline;
  const seconds = Math.max(0, Math.ceil((target - Date.now() - ui.clockShift) / 1000));
  const time = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  output.textContent = state.paused ? `Пауза ${time}` : time;
}

function say(text) {
  if (!ui.speaking || !text || !window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'ru-RU';
  utterance.pitch = 0.85;
  utterance.rate = 1.02;
  const voice = speechSynthesis.getVoices().find((item) => item.lang.toLowerCase().startsWith('ru') && item.localService)
    || speechSynthesis.getVoices().find((item) => item.lang.toLowerCase().startsWith('ru'));
  if (voice) utterance.voice = voice;
  speechSynthesis.speak(utterance);
}

const clips = [];
let playingClip;
let audioPlayer;

function nextClip() {
  if (playingClip || !clips.length) return;
  const current = clips.shift();
  playingClip = current;
  audioPlayer ??= new Audio();
  function complete() {
    if (playingClip !== current) return;
    playingClip = null;
    nextClip();
  }
  function unavailable() {
    if (playingClip !== current) return;
    say(current.text);
    complete();
  }
  audioPlayer.onended = complete;
  audioPlayer.onerror = unavailable;
  audioPlayer.src = current.url;
  audioPlayer.play().catch(unavailable);
}

function announce(text, state, part = 'base') {
  if (!text || !ui.speaking) return;
  if (config.localSpeech && typeof Audio === 'function') {
    clips.push({ text, url: `/api/rooms/${code}/speech?phase=${state.phaseId}&part=${part}` });
    nextClip();
  } else say(text);
}

function stopSpeaking() {
  window.speechSynthesis?.cancel();
  clips.length = 0;
  playingClip = null;
  if (audioPlayer) {
    audioPlayer.onended = null;
    audioPlayer.onerror = null;
    audioPlayer.pause();
    if (audioPlayer.hasAttribute('src')) {
      audioPlayer.removeAttribute('src');
      audioPlayer.load();
    }
  }
}

function queueSound(state) {
  if (!tv || !ui.speaking) return;
  if (state.paused) { stopSpeaking(); return; }
  if (state.phaseId === ui.voicePhase) {
    if (['intro', 'radio', 'final'].includes(state.phase) && ui.voiceReadout && state.readout.startsWith(`${ui.voiceReadout} `)) {
      announce(state.readout.slice(ui.voiceReadout.length).trim(), state, 'extra');
      ui.voiceReadout = state.readout;
    }
    return;
  }
  stopSpeaking();
  ui.voicePhase = state.phaseId;
  ui.voiceReadout = state.narration || state.readout;
  if (state.phase === 'radio') playCue();
  if (state.phase !== 'lobby') {
    announce(ui.voiceReadout, state);
    if (state.readout.startsWith(`${ui.voiceReadout} `) && ['intro', 'radio', 'final'].includes(state.phase)) {
      announce(state.readout.slice(ui.voiceReadout.length).trim(), state, 'extra');
      ui.voiceReadout = state.readout;
    }
  }
}

function playCue() {
  if (chime?.state !== 'running') return;
  [540, 810].forEach((frequency, index) => {
    const now = chime.currentTime + .10 * index;
    const signal = chime.createOscillator();
    const volume = chime.createGain();
    signal.frequency.value = frequency;
    volume.gain.setValueAtTime(.026, now);
    volume.gain.exponentialRampToValueAtTime(.001, now + .08);
    signal.connect(volume).connect(chime.destination);
    signal.start(now);
    signal.stop(now + .09);
  });
}

function receive(state) {
  if (ui.state && state.revision < ui.state.revision) return;
  if (state.phaseId !== ui.state?.phaseId) ui.marks.clear();
  ui.state = state;
  ui.clockShift = state.now - Date.now();
  if (tv) renderTv(state);
  else renderPhone(state);
  voice?.sync(state, Boolean(stream?.readyState === 1));
  updateClock();
  queueSound(state);
}

async function command(action, value) {
  if (ui.busy) return;
  ui.busy = true;
  try {
    const next = await api(`/api/rooms/${code}/act`, { action, value, phaseId: ui.state.phaseId });
    inform();
    receive(next);
  } catch (error) { inform(error.message, true); }
  finally { ui.busy = false; }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const { action, value, voteId, pick, entryMode, local } = button.dataset;
  if (entryMode) { renderEntry(entryMode); inform(); return; }
  if (pick) { app.querySelector(`[data-image="${pick}"]`)?.click(); return; }
  if (local === 'remove-photo') { ui.photoRequest += 1; ui.photo = ''; paintProfile(); return; }
  if (local === 'voice-join') { await voice?.join(); return; }
  if (local === 'voice-mute') { voice?.mute(); return; }
  if (local === 'voice-leave') { await voice?.leave(); return; }
  if (local === 'voice-play') { await voice?.playAudio(); return; }
  if (local === 'sound') {
    if (!window.speechSynthesis && !config.localSpeech) { inform('В этом браузере объявления доступны текстом.'); return; }
    ui.speaking = !ui.speaking;
    if (!ui.speaking) stopSpeaking();
    else {
      ui.voicePhase = null;
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (Audio) {
        chime ??= new Audio();
        void chime.resume().catch(() => {});
      }
      if (ui.state.phase === 'lobby') { ui.voicePhase = ui.state.phaseId; announce('Диспетчер на связи.', ui.state, 'hello'); }
      else queueSound(ui.state);
    }
    renderTv(ui.state);
    updateClock();
    return;
  }
  if (voteId) {
    if (ui.marks.has(voteId)) ui.marks.delete(voteId);
    else if (ui.marks.size < ui.state.slotCount) ui.marks.add(voteId);
    else if (ui.state.slotCount === 1) ui.marks = new Set([voteId]);
    updateVoteControls();
    return;
  }
  if (!action) return;
  const object = action === 'vote' ? (value === 'marks' ? [...ui.marks] : []) : action === 'ready' ? value === 'true' : action === 'photo' ? null : value;
  await command(action, object);
});

app.addEventListener('input', (event) => {
  if (event.target.matches('[name="nick"]')) paintProfile();
  if (event.target.matches('[name="message"]')) ui.chat = event.target.value;
});

app.addEventListener('toggle', (event) => {
  const id = event.target.dataset?.details;
  if (!id) return;
  if (event.target.open) ui.opened.add(id);
  else ui.opened.delete(id);
}, true);

app.addEventListener('change', async (event) => {
  if (event.target.matches('[data-mature]')) { await command('mature', event.target.checked); return; }
  if (!event.target.matches('[data-image]')) return;
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const version = ++ui.photoRequest;
  try {
    const photo = await formatPhoto(file);
    if (version !== ui.photoRequest) return;
    if (ui.state) await command('photo', photo);
    else { ui.photo = photo; paintProfile(); }
  } catch (error) { inform(error.message, true); }
});

app.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.target.id === 'chat') {
    const text = ui.chat.trim();
    if (!text) return;
    ui.chat = '';
    await command('chat', text);
    return;
  }
  if (event.target.id !== 'entry' || ui.busy) return;
  const data = new FormData(event.target);
  const mode = event.target.dataset.mode;
  const room = String(data.get('room') ?? '').trim().toUpperCase();
  if (mode !== 'create' && !codeOk.test(room)) { inform('Введите код комнаты из пяти символов.', true); return; }
  if (mode === 'tv') { location.assign(urlFor('/tv', room)); return; }
  ui.busy = true;
  const button = event.target.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const path = mode === 'create' ? '/api/rooms' : `/api/rooms/${room}/join`;
    const result = await api(path, { name: data.get('nick'), mature: data.has('mature'), photo: ui.photo });
    location.assign(urlFor('/play', result.code));
  } catch (error) { inform(error.message, true); button.disabled = false; }
  finally { ui.busy = false; }
});

async function initialize() {
  try { config = await api('/api/config'); } catch { /* relative addresses still work */ }
  if (!inRoom) { renderEntry(tv ? 'tv' : location.pathname === '/join' ? 'join' : 'create'); return; }
  try {
    const path = `/api/rooms/${encodeURIComponent(code)}`;
    receive(await api(`${path}/${tv ? 'public' : 'state'}`));
    stream = new EventSource(`${path}/stream?view=${tv ? 'tv' : 'player'}${voice ? `&client=${voice.client}` : ''}`);
    stream.addEventListener('state', (event) => {
      if (notice.dataset.reconnecting) { delete notice.dataset.reconnecting; inform(); }
      receive(JSON.parse(event.data));
    });
    stream.addEventListener('error', () => {
      notice.dataset.reconnecting = 'true';
      inform('Связь прервалась. Переподключаемся…');
      voice?.offline();
      if (stream.readyState === EventSource.CLOSED) void verifyRoom(path);
    });
    stream.addEventListener('voice', (event) => voice?.receive(JSON.parse(event.data)));
    stream.addEventListener('removed', () => endRoom('Организатор убрал вас из лобби.'));
    stream.addEventListener('expired', () => endRoom('Время комнаты истекло. Можно создать новую.'));
    setInterval(updateClock, 250);
  } catch (error) {
    if (!tv && error.status === 401) { location.replace(urlFor('/join', code)); return; }
    renderEntry(tv ? 'tv' : 'join');
    inform(error.message, true);
  }
}

async function verifyRoom(path) {
  try { await api(`${path}/${tv ? 'public' : 'state'}`); }
  catch (error) { if ([401, 404].includes(error.status)) endRoom(error.message); }
}

function endRoom(message) {
  stream?.close();
  void voice?.leave();
  if (tv) stopSpeaking();
  ui.state = null;
  delete notice.dataset.reconnecting;
  tools.replaceChildren();
  renderEntry(tv ? 'tv' : 'join');
  inform(message);
}

initialize();

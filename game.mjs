import { randomInt, randomUUID } from 'node:crypto';
import { categories, deckCards, incident, introduction, roundJoke, systems } from './content.mjs';

export const durations = { intro: 27_000, turn: 40_000, discuss: 90_000, vote: 60_000, runoff: 45_000, radio: 30_000, pause: 120_000 };
export const exilePlan = (count) => count === 4 ? [1, 0, 1] : [1, count >= 9 ? 2 : 1, count >= 7 ? 2 : 1];
const revealCategories = [['experience'], ['limit'], ['equipment', 'habit']];
const fields = ['phase', 'phaseId', 'revision', 'deadline', 'lastActive', 'mature', 'round', 'readout', 'narration', 'first', 'active', 'organizer', 'discussion', 'history', 'journal', 'capacity', 'plan', 'paused', 'roundOut', 'roundBallots', 'candidates', 'slots', 'fixed', 'result'];

export class GameError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
  }
}

function requireGame(condition, message, status) {
  if (!condition) throw new GameError(message, status);
}

function shuffled(values) {
  const copy = [...values];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const next = randomInt(i + 1);
    [copy[i], copy[next]] = [copy[next], copy[i]];
  }
  return copy;
}

function matchPair(team, tags) {
  for (const member of team) {
    if (!member.tags.includes(tags[0])) continue;
    const partner = team.find((other) => other.id !== member.id && other.tags.includes(tags[1]));
    if (partner) return [member.id, partner.id];
  }
  return [];
}

function possibleTeam(deals, seats, team = [], cursor = 0) {
  if (team.length === seats) return systems.filter(({ tags }) => matchPair(team, tags).length).length >= 2;
  for (let i = cursor; i <= deals.length - (seats - team.length); i += 1) {
    const hand = deals[i];
    for (const category of ['equipment', 'habit']) {
      const candidate = { id: i, tags: [hand.experience.tag, hand[category].tag] };
      if (possibleTeam(deals, seats, [...team, candidate], i + 1)) return true;
    }
  }
  return false;
}

function dealHands(count) {
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const decks = Object.entries(deckCards).map(([category, cards]) => [category, shuffled(cards)]);
    const deal = Array.from({ length: count }, (_, index) => Object.fromEntries(decks.map(([category, cards]) => [category, cards[index]])));
    if (possibleTeam(deal, Math.floor(count / 2))) return deal;
  }
  return shuffled(Array.from({ length: count }, (_, index) => Object.fromEntries(Object.entries(deckCards).map(([category, cards]) => [category, cards[index]]))));
}

function summaryFacts(room) {
  const out = room.roundOut.map((id) => room.players.find((player) => player.id === id).name);
  const opened = room.players.flatMap((player) => player.opened.filter((entry) => entry.round === room.round).map(({ card }) => ({ id: player.id, name: player.name, card })));
  return { out, opened, system: systems[room.round - 1].name };
}

export class Room {
  constructor(code, { notify = () => {}, narrator = null, now = Date.now, timing = durations } = {}) {
    this.code = code;
    this.notify = notify;
    this.narrator = narrator;
    this.now = now;
    this.timing = timing;
    this.players = [];
    this.phase = 'lobby';
    this.phaseId = 0;
    this.revision = 0;
    this.deadline = null;
    this.lastActive = now();
    this.mature = false;
    this.round = 0;
    this.readout = '';
    this.narration = '';
    this.turnOrder = [];
    this.first = -1;
    this.active = null;
    this.discussion = [];
    this.history = [];
    this.journal = [];
  }

  refresh() {
    this.revision += 1;
    this.lastActive = this.now();
    this.notify(this);
  }

  phaseTo(phase, readout = '') {
    this.phase = phase;
    this.phaseId += 1;
    this.deadline = this.timing[phase] ? this.now() + this.timing[phase] : null;
    this.readout = readout;
    this.narration = readout;
    this.paused = null;
  }

  speak(kind, facts) {
    if (!this.narrator) return;
    const phase = this.phaseId;
    Promise.resolve(this.narrator(kind, facts)).then((phrase) => {
      if (!phrase || phase !== this.phaseId || this.paused) return;
      this.readout = `${this.narration} ${phrase}`;
      if (this.phase === 'radio') this.journal.at(-1).text = this.readout;
      this.refresh();
    }).catch(() => {});
  }

  add(name, photo) {
    requireGame(this.phase === 'lobby', 'Партия уже началась.');
    requireGame(this.players.length < 10, 'Комната заполнена.');
    requireGame(!this.players.some((player) => player.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru')), 'Этот ник уже занят.');
    const player = { id: randomUUID(), secret: randomUUID(), name, photo, pictureVersion: 1, ready: false, inside: true, hand: {}, opened: [], connected: 0, lastSeen: this.now(), voice: null };
    if (!this.organizer) this.organizer = player.id;
    this.players.push(player);
    this.refresh();
    return player;
  }

  start(player) {
    requireGame(player.id === this.organizer, 'Команду выполняет организатор.', 403);
    requireGame(this.phase === 'lobby', 'Партия уже идёт.');
    requireGame(this.players.length >= 4 && this.players.every((member) => member.ready && member.connected), 'Нужно от 4 до 10 подключённых и готовых игроков.');
    const deals = dealHands(this.players.length);
    this.players.forEach((member, index) => Object.assign(member, { inside: true, opened: [], hand: deals[index] }));
    this.capacity = Math.floor(this.players.length / 2);
    this.plan = exilePlan(this.players.length);
    this.phaseTo('intro', introduction);
    this.speak('intro', { incident });
  }

  startRound() {
    this.round += 1;
    this.roundOut = [];
    this.roundBallots = [];
    const offset = this.players.findIndex((_, index) => {
      const position = (this.first + 1 + index) % this.players.length;
      return this.players[position].inside;
    });
    this.first = (this.first + 1 + offset) % this.players.length;
    this.turnOrder = this.players.map((_, index) => this.players[(index + this.first) % this.players.length]).filter((member) => member.inside);
    this.nextTurn();
  }

  nextTurn() {
    const player = this.turnOrder.shift();
    if (player) {
      this.active = player.id;
      this.phaseTo('turn', `${systems[this.round - 1].fault} ${player.name}, ваш ход.`);
      return;
    }
    this.active = null;
    this.phaseTo('discuss', 'Обсудите, кого оставить внутри и чьих навыков хватит для запуска систем.');
  }

  openVote({ candidates = this.players.filter((player) => player.inside).map((player) => player.id), slots = this.plan[this.round - 1], fixed = [], runoff = false } = {}) {
    this.ballots = new Map();
    this.candidates = candidates;
    this.slots = slots;
    this.fixed = fixed;
    this.phaseTo(runoff ? 'runoff' : 'vote', runoff ? 'Ничья. Голосуем среди спорных кандидатов.' : `Открыто голосование об изгнании. Квота этого круга — ${slots}.`);
  }

  closeVote() {
    const counts = Object.fromEntries(this.candidates.map((id) => [id, 0]));
    for (const marks of this.ballots.values()) for (const id of marks) counts[id] += 1;
    const ranked = this.candidates.map((id) => ({ id, count: counts[id] })).sort((a, b) => b.count - a.count);
    const boundary = ranked[this.slots - 1].count;
    const clear = ranked.filter((entry) => entry.count > boundary).map((entry) => entry.id);
    const tied = ranked.filter((entry) => entry.count === boundary).map((entry) => entry.id);
    const left = this.slots - clear.length;
    const record = { round: this.round, runoff: this.phase === 'runoff', counts: ranked, cast: this.ballots.size };
    this.roundBallots.push(record);
    if (tied.length > left && this.phase === 'vote') {
      this.openVote({ candidates: tied, slots: left, fixed: clear, runoff: true });
      return;
    }
    const draw = tied.length > left;
    this.roundOut = [...this.fixed, ...clear, ...(draw ? shuffled(tied).slice(0, left) : tied)];
    for (const member of this.players) if (this.roundOut.includes(member.id)) member.inside = false;
    this.history.push({ round: this.round, out: this.roundOut, draw, ballots: this.roundBallots });
    const facts = summaryFacts(this);
    const last = facts.opened.at(-1);
    const text = `Сводка круга ${this.round}. За шлюзом — ${facts.out.join(', ')}. ${this.players.filter((player) => player.inside).length} внутри. ${systems[this.round - 1].fault}${last ? ` Из открытого запомнилась карта «${last.card.title}». ${last.name}, слушай.` : ''} ${roundJoke(last?.card, this.mature)}`;
    const notes = facts.opened.map(({ id, name, card }) => ({ id, title: card.title, text: `${name}, по твоей карте у нас отдельная запись. ${roundJoke(card, this.mature)}` }));
    this.journal.push({ round: this.round, text, notes });
    this.phaseTo('radio', text);
    this.speak('radio', { round: this.round, system: facts.system, exits: facts.out.length, cards: facts.opened.map(({ card }) => card.title) });
  }

  finish() {
    const team = this.players.filter((player) => player.inside).map((player) => ({ id: player.id, tags: player.opened.map(({ card }) => card.tag).filter(Boolean) }));
    this.result = systems.map((system) => {
      const pair = matchPair(team, system.tags);
      const missing = system.tags.filter((tag) => !team.some((member) => member.tags.includes(tag)));
      return { name: system.name, tags: system.tags, pair, missing };
    });
    const running = this.result.filter((item) => item.pair.length).length;
    this.phaseTo('final', `Смена завершена. Запущено систем: ${running} из 3. ${running >= 2 ? 'Убежище готово.' : 'Убежище остаётся в аварийном режиме.'}`);
    this.speak('final', { running, total: systems.length, live: team.length });
  }

  advance() {
    switch (this.phase) {
      case 'intro': this.startRound(); break;
      case 'turn': this.nextTurn(); break;
      case 'discuss':
        if (this.plan[this.round - 1]) this.openVote();
        else this.startRound();
        break;
      case 'vote':
      case 'runoff': this.closeVote(); break;
      case 'radio':
        if (this.round === 3) this.finish();
        else this.startRound();
        break;
      default: return;
    }
    this.refresh();
  }

  tick() {
    const owner = this.players.find((player) => player.id === this.organizer);
    if (['lobby', 'final'].includes(this.phase) && owner && !owner.connected && this.now() - owner.lastSeen >= 30_000) {
      const replacement = this.players.find((player) => player.connected);
      if (replacement) {
        this.organizer = replacement.id;
        this.refresh();
      }
    }
    if (this.paused && this.now() >= this.paused.until) {
      this.resume();
      this.refresh();
    }
    if (this.deadline !== null && this.now() >= this.deadline) this.advance();
  }

  resume() {
    this.deadline = this.now() + this.paused.remaining;
    this.paused = null;
  }

  reset() {
    for (const player of this.players) Object.assign(player, { inside: true, hand: {}, opened: [], ready: false });
    Object.assign(this, { round: 0, first: -1, capacity: null, active: null, history: [], journal: [], discussion: [], result: null, ballots: null });
    this.phaseTo('lobby');
  }

  act(player, body) {
    this.tick();
    const { action, phaseId, value } = body;
    const organizerOnly = () => requireGame(player.id === this.organizer, 'Команду выполняет организатор.', 403);
    if (['start', 'skip', 'reveal', 'pass', 'vote', 'pause', 'resume', 'restart', 'remove-player'].includes(action)) requireGame(phaseId === this.phaseId, 'Фаза уже изменилась.');
    switch (action) {
      case 'ready':
        requireGame(this.phase === 'lobby', 'Партия уже идёт.');
        if (player.ready === (value === true)) return;
        player.ready = value === true;
        break;
      case 'mature':
        organizerOnly();
        requireGame(this.phase === 'lobby', 'Настройка доступна в лобби.');
        if (this.mature === (value === true)) return;
        this.mature = value === true;
        break;
      case 'remove-player':
        organizerOnly();
        requireGame(this.phase === 'lobby' && value !== player.id, 'Убрать игрока можно в лобби.');
        this.players = this.players.filter((member) => member.id !== value);
        break;
      case 'photo': player.photo = value; player.pictureVersion += 1; break;
      case 'start': this.start(player); break;
      case 'skip':
        organizerOnly(); requireGame(this.phase === 'intro' && !this.paused, 'Вступление уже закончилось.'); this.advance(); return;
      case 'reveal': {
        requireGame(this.phase === 'turn' && !this.paused && this.active === player.id, 'Сейчас нельзя раскрыть карту.');
        if (player.opened.some(({ round, card }) => round === this.round && card.id === value)) return;
        const card = Object.values(player.hand).find((candidate) => candidate.id === value);
        requireGame(card && revealCategories[this.round - 1].includes(card.category) && !player.opened.some(({ round }) => round === this.round), 'Эта карта недоступна для раскрытия.');
        player.opened.push({ round: this.round, card });
        this.readout = `${player.name} открыл карту «${card.title}».`; break;
      }
      case 'pass':
        requireGame(this.phase === 'turn' && !this.paused && this.active === player.id && player.opened.some(({ round }) => round === this.round), 'Сначала раскройте карту.'); this.advance(); return;
      case 'vote': {
        requireGame(['vote', 'runoff'].includes(this.phase) && !this.paused, 'Голосование закрыто.');
        requireGame(Array.isArray(value) && value.length <= this.slots && new Set(value).size === value.length && value.every((id) => this.candidates.includes(id) && id !== player.id), 'Проверьте выбранных кандидатов.');
        if (this.ballots.has(player.id)) return;
        this.ballots.set(player.id, value);
        if (this.ballots.size === this.players.length) { this.advance(); return; }
        break;
      }
      case 'pause':
        organizerOnly(); requireGame(this.deadline !== null && !this.paused, 'Сейчас пауза недоступна.');
        this.paused = { until: this.now() + this.timing.pause, remaining: Math.max(0, this.deadline - this.now()) }; this.deadline = null; break;
      case 'resume': organizerOnly(); requireGame(this.paused, 'Матч уже идёт.'); this.resume(); break;
      case 'restart': organizerOnly(); requireGame(this.phase === 'final', 'Раунд ещё идёт.'); this.reset(); break;
      case 'chat':
        requireGame(typeof value === 'string' && value.trim() && value.length <= 240, 'Сообщение должно быть длиной до 240 символов.');
        requireGame(!player.chattedAt || this.now() - player.chattedAt >= 600, 'Подождите перед следующим сообщением.', 429);
        player.chattedAt = this.now(); this.discussion.push({ name: player.name, text: value.trim(), at: this.now() }); this.discussion = this.discussion.slice(-30); break;
      default: throw new GameError('Неизвестное действие.', 400);
    }
    this.refresh();
  }

  serialize() {
    return {
      version: 1, code: this.code, savedAt: this.now(),
      ...Object.fromEntries(fields.map((field) => [field, this[field]])),
      players: this.players.map((player) => ({ ...player, photo: player.photo?.toString('base64') || null, connected: 0, voice: null })),
      ballots: this.ballots ? [...this.ballots] : null,
      turnOrder: this.turnOrder.map((player) => player.id),
    };
  }

  static restore(saved, options) {
    if (saved.version !== 1 || !['lobby', 'intro', 'turn', 'discuss', 'vote', 'runoff', 'radio', 'final'].includes(saved.phase) || !Array.isArray(saved.players) || saved.players.length < 1 || saved.players.length > 10 || !Number.isFinite(saved.savedAt)) throw new Error('Неподдерживаемый файл комнаты.');
    const room = new Room(saved.code, options);
    for (const field of fields) if (Object.hasOwn(saved, field)) room[field] = saved[field];
    room.players = saved.players.map((player) => ({ ...player, photo: player.photo ? Buffer.from(player.photo, 'base64') : null, connected: 0, voice: null, lastSeen: room.now() }));
    const offline = Math.max(0, room.now() - saved.savedAt);
    if (room.deadline !== null) room.deadline += offline;
    if (room.paused) room.paused.until += offline;
    room.turnOrder = saved.turnOrder.map((id) => room.players.find((player) => player.id === id)).filter(Boolean);
    room.ballots = saved.ballots ? new Map(saved.ballots) : null;
    return room;
  }

  snapshot(viewer) {
    const voting = ['vote', 'runoff'].includes(this.phase);
    const players = this.players.map((player) => ({ id: player.id, name: player.name, ready: player.ready, connected: player.connected > 0, inside: player.inside, photo: player.photo ? `/api/rooms/${this.code}/avatar/${player.id}?v=${player.pictureVersion}` : '', opened: player.opened, ...(this.phase === 'final' ? { finalHand: Object.values(player.hand) } : {}) }));
    const self = viewer ? {
      id: viewer.id,
      organizer: viewer.id === this.organizer,
      hand: Object.values(viewer.hand),
      allowed: this.phase === 'turn' && this.active === viewer.id && !viewer.opened.some(({ round }) => round === this.round) ? revealCategories[this.round - 1] : [],
      ballot: voting && this.ballots.has(viewer.id) ? this.ballots.get(viewer.id) : null,
      candidates: voting ? this.candidates.filter((id) => id !== viewer.id) : [],
    } : undefined;
    return {
      code: this.code, phase: this.phase, phaseId: this.phaseId, revision: this.revision, round: this.round, active: this.active, capacity: this.capacity,
      deadline: this.deadline, now: this.now(), paused: Boolean(this.paused), pauseUntil: this.paused?.until,
      incident, mature: this.mature, readout: this.readout, narration: this.narration, categories,
      players, systems: systems.slice(0, this.round), slotCount: voting ? this.slots : 0, votesIn: voting ? this.ballots.size : 0,
      ...(this.phase === 'runoff' ? { published: this.roundBallots.at(-1) } : {}),
      history: this.history, journal: this.journal.map(({ round, text, notes }) => ({ round, text, ...(viewer ? { note: notes?.find(({ id }) => id === viewer.id) } : {}) })), result: this.result,
      ...(self ? {
        self: { ...self, voice: viewer.voice }, discussion: this.discussion,
        voice: this.players.filter((player) => player.voice).map((player) => ({ id: player.id, session: player.voice.session })),
      } : {}),
    };
  }
}

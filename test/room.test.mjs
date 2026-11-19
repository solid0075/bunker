import test from 'node:test';
import assert from 'node:assert/strict';
import { durations, exilePlan, GameError, Room } from '../game.mjs';

function createRoom(size) {
  let now = 10_000;
  const room = new Room('ABCDE', { now: () => now });
  const people = Array.from({ length: size }, (_, index) => room.add(`Игрок ${index + 1}`, null));
  people.forEach((player) => { player.connected = 1; room.act(player, { action: 'ready', value: true }); });
  const act = (player, action, value) => room.act(player, { phaseId: room.phaseId, action, value });
  const expire = () => { now = room.deadline ?? room.paused.until; room.tick(); };
  act(people[0], 'start');
  return { room, people, act, expire, advanceTime: (milliseconds) => { now += milliseconds; room.tick(); } };
}

function makeCircle({ room, people, act, expire }) {
  const used = [];
  while (room.phase === 'turn') {
    const player = people.find((member) => member.id === room.active);
    assert.ok(player.inside);
    const view = room.snapshot(player);
    const card = view.self.hand.find((item) => view.self.allowed.includes(item.category));
    assert.ok(card);
    act(player, 'reveal', card.id);
    assert.equal(room.snapshot().players.flatMap((member) => member.opened).at(-1) !== undefined, true);
    act(player, 'pass');
    used.push(player.id);
  }
  assert.equal(new Set(used).size, used.length);
  assert.equal(room.phase, 'discuss');
  expire();
}

test('TV sees public state; only the owner receives the private hand and submitted ballot', () => {
  const { room, people, act, expire } = createRoom(6);
  const [host, guest] = people;
  assert.throws(() => act(guest, 'skip'), (error) => error instanceof GameError && error.status === 403);
  const token = room.phaseId;
  act(host, 'skip');
  assert.equal(room.phase, 'turn');
  assert.throws(() => room.act(host, { action: 'skip', phaseId: token }), /Фаза уже изменилась/);
  assert.equal(room.snapshot().self, undefined);
  assert.equal(room.snapshot().players.some((player) => 'hand' in player || 'secret' in player || 'finalHand' in player), false);
  assert.equal(room.snapshot(guest).self.hand.length, 4);
  const privateCard = room.snapshot(guest).self.hand.find((item) => item.category === 'equipment');
  assert.equal(JSON.stringify(room.snapshot()).includes(privateCard.id), false);
  assert.throws(() => act(guest, 'reveal', guest.hand.experience.id), /Сейчас нельзя/);
  assert.throws(() => act(host, 'reveal', host.hand.equipment.id), /недоступна/);
  makeCircle({ room, people, act, expire });
  assert.equal(room.phase, 'vote');
  assert.throws(() => act(host, 'vote', [host.id]), /кандидатов/);
  act(host, 'vote', [guest.id]);
  act(host, 'vote', []);
  assert.equal(room.snapshot().votesIn, 1);
  assert.equal(room.snapshot(guest).self.ballot, null);
  assert.deepEqual(room.snapshot(host).self.ballot, [guest.id]);
  assert.equal(room.snapshot().published, undefined);
  assert.equal(room.snapshot().history.length, 0);
});

test('full three-circle games preserve final capacity for all room sizes', () => {
  for (let size = 4; size <= 10; size += 1) {
    const setup = createRoom(size);
    const { room, people, act, expire } = setup;
    expire();
    assert.equal(room.round, 1);
    const plan = exilePlan(size);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(room.round, index + 1);
      makeCircle(setup);
      if (!plan[index]) continue;
      assert.equal(room.phase, 'vote');
      for (const person of people) act(person, 'vote', []);
      assert.equal(room.phase, 'runoff');
      for (const person of people) act(person, 'vote', []);
      assert.equal(room.phase, 'radio');
      assert.equal(room.roundOut.length, plan[index]);
      assert.equal(room.history.at(-1).draw, true);
      assert.equal(room.journal.at(-1).round, index + 1);
      assert.match(room.snapshot().readout, /За шлюзом/);
      const publicly = room.snapshot().journal.at(-1);
      assert.equal('notes' in publicly || 'note' in publicly, false);
      for (const person of people.filter((member) => member.opened.some(({ round }) => round === index + 1))) {
        const note = room.snapshot(person).journal.at(-1).note;
        assert.equal(note.id, person.id);
        assert.ok(note.text.startsWith(`${person.name},`));
      }
      expire();
    }
    assert.equal(room.phase, 'final');
    assert.equal(people.filter((person) => person.inside).length, Math.floor(size / 2));
    assert.equal(room.snapshot().players.every((player) => player.finalHand.length === 4), true);
    assert.equal(room.snapshot().result.length, 3);
    act(people[0], 'restart');
    assert.equal(room.phase, 'lobby');
    assert.equal(room.snapshot().history.length, 0);
    assert.equal(room.snapshot().players.some((player) => 'finalHand' in player), false);
  }
});

test('a two-seat runoff retains the first exile and restricts the second ballot', () => {
  const { room, people, act } = createRoom(7);
  const [host, first, second, third, one, two, three] = people;
  act(host, 'skip');
  room.openVote({ slots: 2 });
  const votes = [[first], [second], [first, third], [first, second], [first, second], [first, third], [third]];
  people.forEach((person, index) => act(person, 'vote', votes[index].map(({ id }) => id)));
  assert.equal(room.phase, 'runoff');
  assert.deepEqual(room.snapshot(host).self.candidates.sort(), [second.id, third.id].sort());
  assert.deepEqual(room.snapshot(second).self.candidates, [third.id]);
  assert.throws(() => act(host, 'vote', [first.id]), /кандидатов/);
  for (const voter of [host, first, second, third, one, two, three]) act(voter, 'vote', voter === second ? [] : [second.id]);
  assert.equal(room.phase, 'radio');
  assert.deepEqual(room.roundOut, [first.id, second.id]);
  assert.equal(room.history[0].draw, false);
});

test('the organizer role follows the oldest connected player after a grace period', () => {
  let now = 10_000;
  const room = new Room('ABCDE', { now: () => now });
  const host = room.add('Организатор', null);
  const next = room.add('Гость', null);
  next.connected = 1;
  now += 29_999;
  room.tick();
  assert.equal(room.snapshot(host).self.organizer, true);
  now += 1;
  room.tick();
  assert.equal(room.snapshot(next).self.organizer, true);
  assert.equal(room.snapshot(host).self.organizer, false);
});

test('a model response reaching the server after phase change stays out of the next cue', async () => {
  let deliver;
  const room = new Room('ABCDE', { narrator: () => new Promise((resolve) => { deliver = resolve; }) });
  const crew = ['А', 'Б', 'В', 'Г'].map((name) => room.add(name, null));
  crew.forEach((member) => { member.connected = 1; member.ready = true; });
  room.act(crew[0], { action: 'start', phaseId: room.phaseId });
  room.act(crew[0], { action: 'skip', phaseId: room.phaseId });
  deliver('Опоздавшая реплика');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(room.phase, 'turn');
  assert.doesNotMatch(room.readout, /Опоздавшая/);
});

test('pause preserves the phase until resumed or the pause expires', () => {
  const { room, people, act, advanceTime } = createRoom(4);
  const [host] = people;
  advanceTime(1000);
  act(host, 'pause');
  assert.equal(room.snapshot().paused, true);
  assert.equal(room.snapshot().deadline, null);
  assert.throws(() => act(host, 'skip'), /Вступление/);
  advanceTime(durations.pause);
  assert.equal(room.snapshot().paused, false);
  assert.equal(room.phase, 'intro');
  advanceTime(durations.intro - 1000);
  assert.equal(room.phase, 'turn');
});

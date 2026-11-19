export function browserClientId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${bytes.slice(0, 8)}-${bytes.slice(8, 12)}-${bytes.slice(12, 16)}-${bytes.slice(16, 20)}-${bytes.slice(20)}`;
}

export class RoomVoice {
  constructor({ client, request, onStatus, onError }) {
    this.client = client;
    this.request = request;
    this.onStatus = onStatus;
    this.onError = onError;
    this.connections = new Map();
    this.available = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection);
  }

  get muted() { return Boolean(this.stream && !this.stream.getAudioTracks()[0]?.enabled); }
  get connected() { return [...this.connections.values()].filter(({ pc }) => pc.connectionState === 'connected').length; }

  async join() {
    if (!this.available || !this.online || this.starting || this.stream) return;
    this.starting = true;
    this.onStatus();
    try {
      const { iceServers } = await this.request('voice');
      this.config = { iceServers };
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true }, video: false });
      for (const track of this.stream.getAudioTracks()) track.addEventListener('ended', () => { void this.leave(); }, { once: true });
      await this.claim();
    } catch (error) {
      await this.leave();
      this.onError(error.name === 'NotAllowedError' ? 'Доступ к микрофону не предоставлен. Можно продолжить в чате.' : 'Не удалось подключить микрофон.');
    } finally {
      this.starting = false;
      this.onStatus();
    }
  }

  async claim() {
    const { session } = await this.request('voice', { client: this.client, enabled: true });
    if (this.stream && session) {
      this.session = session;
      this.applyRoster();
    }
  }

  async leave() {
    const hadMic = Boolean(this.stream);
    this.dropPeers();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.session = null;
    this.needsPlayback = false;
    this.onStatus();
    if (hadMic) await this.request('voice', { client: this.client, enabled: false }).catch(() => {});
  }

  mute() {
    const enabled = this.muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = enabled;
    this.onStatus();
  }

  async playAudio() {
    this.needsPlayback = false;
    await Promise.all([...this.connections.values()].map(({ audio }) => this.play(audio)));
    this.onStatus();
  }

  async play(audio) {
    if (!audio?.srcObject) return;
    try { await audio.play(); }
    catch (error) { if (error.name === 'NotAllowedError') this.needsPlayback = true; }
  }

  offline() {
    this.online = false;
    this.session = null;
    this.dropPeers();
    this.onStatus();
  }

  sync(state, online) {
    this.state = state;
    this.online = online;
    if (!online || !this.stream) { this.onStatus(); return; }
    const own = state.self.voice;
    if (own?.client === this.client) {
      if (this.session && this.session !== own.session) this.dropPeers();
      this.session = own.session;
      this.applyRoster();
    } else if (!this.starting && !this.rejoining) {
      if (own) {
        void this.leave();
        this.onError('Микрофон подключён в другой вкладке этого игрока.');
      } else {
        this.session = null;
        this.dropPeers();
        this.rejoining = true;
        this.claim().catch(() => {}).finally(() => { this.rejoining = false; this.onStatus(); });
      }
    }
    this.onStatus();
  }

  dropPeers() { for (const id of this.connections.keys()) this.drop(id); }

  drop(id) {
    const peer = this.connections.get(id);
    this.connections.delete(id);
    if (peer) { peer.pc.close(); peer.audio?.remove(); }
  }

  applyRoster() {
    if (!this.state?.self || !this.session) return;
    const roster = this.state.voice || [];
    for (const [id, peer] of this.connections) if (!roster.some((member) => member.id === id && member.session === peer.session)) this.drop(id);
    for (const member of roster) {
      if (member.id !== this.state.self.id && !this.connections.has(member.id)) this.makePeer(member);
    }
  }

  makePeer({ id, session }) {
    const pc = new RTCPeerConnection(this.config);
    const peer = { id, session, pc, pending: [], serial: Promise.resolve(), retried: false };
    this.connections.set(id, peer);
    for (const track of this.stream.getAudioTracks()) pc.addTrack(track, this.stream);
    pc.onicecandidate = ({ candidate }) => { if (candidate) this.signal(peer, { candidate: candidate.toJSON() }).catch(() => {}); };
    pc.ontrack = ({ streams, track }) => {
      if (this.connections.get(id) !== peer) return;
      if (!peer.audio) {
        peer.audio = document.createElement('audio');
        peer.audio.autoplay = true;
        peer.audio.hidden = true;
        peer.audio.dataset.voiceMember = id;
        document.body.append(peer.audio);
      }
      peer.audio.srcObject = streams[0] ?? new MediaStream([track]);
      void this.play(peer.audio).finally(this.onStatus);
    };
    const offers = this.state.self.id < id;
    pc.onconnectionstatechange = () => {
      if (this.connections.get(id) !== peer) return;
      if (offers && pc.connectionState === 'failed' && pc.signalingState === 'stable' && !peer.retried) {
        peer.retried = true;
        void this.offer(peer, true).catch(() => {});
      }
      this.onStatus();
    };
    if (offers) void this.offer(peer).catch(() => {});
    return peer;
  }

  signal(peer, contents) {
    if (!this.session || this.connections.get(peer.id) !== peer) return Promise.resolve();
    return this.request('signal', { client: this.client, session: this.session, to: peer.id, targetSession: peer.session, ...contents });
  }

  async offer(peer, restart = false) {
    await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: restart }));
    await this.signal(peer, { description: peer.pc.localDescription });
  }

  async processSignal(peer, packet) {
    const { pc, pending } = peer;
    if (this.connections.get(peer.id) !== peer) return;
    if (packet.description) {
      await pc.setRemoteDescription(packet.description);
      for (const candidate of pending.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
      if (packet.description.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        await this.signal(peer, { description: pc.localDescription });
      }
    } else if (pc.remoteDescription) await pc.addIceCandidate(packet.candidate);
    else pending.push(packet.candidate);
  }

  receive(packet) {
    if (!this.stream || this.session !== packet.targetSession) return;
    const peer = this.connections.get(packet.from);
    if (!peer || peer.session !== packet.session) return;
    peer.serial = peer.serial.then(() => this.processSignal(peer, packet)).catch(() => {});
  }
}

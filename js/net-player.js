// 参加者側の通信。ホストへ「直接（WebRTC）」でつなぎに行き、少し待ってもつながらなければ
// 「PeerJS 中継」「MQTT 中継」（どちらも暗号化）も同時に試し、最初につながった方を使う。
// スマホのモバイル回線などで直接つながらなくても、中継で参加できる。
// 直接と PeerJS 中継は、PeerJS のサーバーへの接続（Peer）を1本だけ作って共用する。
// 切れたら自動でつなぎ直す。
/* global Peer */
import { dialRelay, dialSignal, peerReady } from './relay.js?v=1.6.0';

const PING_EVERY = 4000;
const STALE_AFTER = 15000;
const P2P_TIMEOUT = 12000;
const RELAY_TIMEOUT = 15000;
const RELAY_DELAY = 2500;

/** 直接（WebRTC）でホストにつなぐ。peer は共用。つながったら channel を返す。 */
export function dialP2P({ hostId, peer, timeout = P2P_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    if (!peer || typeof RTCPeerConnection === 'undefined') {
      reject(new Error('p2p-unavailable'));
      return;
    }
    let settled = false;
    let conn = null;
    const ch = {
      kind: 'p2p',
      closed: false,
      onmessage: null,
      onclose: null,
      send(msg) {
        if (ch.closed || !conn?.open) return false;
        try {
          conn.send(msg);
          return true;
        } catch {
          return false;
        }
      },
      close() {
        if (ch.closed) return;
        ch.closed = true;
        cleanup();
        try {
          conn?.close();
        } catch {
          /* ignore */
        }
      },
    };
    const onError = (e) => {
      if (settled) return;
      if (e?.type === 'peer-unavailable') fail(Object.assign(new Error(e.type), { type: e.type }));
    };
    const cleanup = () => {
      clearTimeout(timer);
      peer.off('error', onError);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        conn?.close();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    const timer = setTimeout(() => fail(Object.assign(new Error('timeout'), { type: 'timeout' })), timeout);
    peer.on('error', onError);
    peerReady(peer, timeout).then(
      () => {
        if (settled) return;
        conn = peer.connect(hostId, { reliable: true, serialization: 'json' });
        if (!conn) {
          fail(new Error('connect-failed'));
          return;
        }
        conn.on('open', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(ch);
        });
        conn.on('data', (msg) => ch.onmessage?.(msg));
        const lost = () => {
          if (!settled) fail(Object.assign(new Error('closed'), { type: 'closed' }));
          else if (!ch.closed) {
            ch.closed = true;
            cleanup();
            ch.onclose?.();
          }
        };
        conn.on('close', lost);
        conn.on('error', lost);
        conn.on('iceStateChanged', (s) => {
          if (s === 'failed' || s === 'closed') lost();
        });
      },
      (e) => fail(e),
    );
  });
}

export class PlayerNet {
  /**
   * @param {object} opts
   * @param {string} opts.room
   * @param {string} opts.hostId          PeerJS 上のホストの ID
   * @param {object} opts.peerOptions
   * @param {string[]} opts.brokers       MQTT 中継に使うブローカー（wss://…）
   * @param {'auto'|'p2p'|'relay'|'sig'|'mqtt'} opts.mode  relay = 中継の両方
   * @param {(status:string)=>void} opts.onStatus
   * @param {()=>void} opts.onOpen        つながったとき（hello を送る）
   * @param {(msg:any)=>void} opts.onMessage
   */
  constructor(opts) {
    this.opts = opts;
    this.ch = null;
    this.peer = null;
    this.kind = '';
    this.stopped = false;
    this.everConnected = false;
    this.failures = 0;
    this.attempting = false;
    this.retryTimer = null;
    this.lastMsgAt = 0;
    this.pingTimer = setInterval(() => this._tick(), PING_EVERY);
    this._onVisible = () => {
      if (document.visibilityState === 'visible' && !this.stopped) {
        if (!this.isOpen() || Date.now() - this.lastMsgAt > PING_EVERY * 2) this.reconnectNow();
      }
    };
    document.addEventListener('visibilitychange', this._onVisible);
    window.addEventListener('online', this._onVisible);
  }

  isOpen() {
    return Boolean(this.ch && !this.ch.closed);
  }

  _status(s) {
    this.status = s;
    this.opts.onStatus?.(s);
  }

  start() {
    this.stopped = false;
    this._attempt();
  }

  _destroyPeer(peer) {
    if (!peer) return;
    try {
      peer.destroy();
    } catch {
      /* ignore */
    }
    if (this.peer === peer) this.peer = null;
  }

  async _attempt() {
    if (this.stopped || this.attempting) return;
    this.attempting = true;
    clearTimeout(this.retryTimer);
    this._status(this.everConnected ? 'reconnecting' : 'connecting');
    const mode = this.opts.mode || 'auto';
    const use = {
      p2p: ['auto', 'p2p'].includes(mode),
      sig: ['auto', 'relay', 'sig'].includes(mode),
      mqtt: ['auto', 'relay', 'mqtt'].includes(mode) && Boolean(this.opts.brokers?.length),
    };
    // つながらなかったときに原因を表示するための記録
    const diag = {
      server: 'off',
      serverMsg: '',
      p2p: use.p2p ? 'trying' : 'off',
      sig: use.sig ? 'trying' : 'off',
      relay: use.mqtt ? 'trying' : 'off',
    };
    this.diag = diag;

    // PeerJS のサーバーへの接続は1本だけ作り、直接と PeerJS 中継で共用する
    let peer = null;
    if ((use.p2p || use.sig) && typeof Peer !== 'undefined') {
      diag.server = 'trying';
      try {
        peer = new Peer({ debug: 0, ...this.opts.peerOptions });
        peer.on('open', () => (diag.server = 'ok'));
        peer.on('error', (e) => {
          if (diag.server !== 'ok' && e?.type !== 'peer-unavailable') {
            diag.server = e?.type || 'error';
            diag.serverMsg = String(e?.message || '').slice(0, 80);
          }
        });
      } catch (e) {
        diag.server = 'error';
        diag.serverMsg = String(e?.message || '').slice(0, 80);
        peer = null;
      }
    }

    const track = (key, t) => {
      t.then(
        () => (diag[key] = 'ok'),
        (e) => (diag[key] = key === 'relay' && e?.relay ? { reason: e.message, ...e.relay } : e?.type || e?.message || 'error'),
      );
      return t;
    };
    const tries = [];
    const p2p = use.p2p && peer ? track('p2p', dialP2P({ hostId: this.opts.hostId, peer })) : null;
    if (p2p) tries.push(p2p);
    const startRelays = () => {
      const list = [];
      if (use.sig && peer) list.push(track('sig', dialSignal({ hostId: this.opts.hostId, peer })));
      if (use.mqtt) list.push(track('relay', dialRelay({ room: this.opts.room, brokers: this.opts.brokers, timeout: RELAY_TIMEOUT })));
      tries.push(...list);
      return list;
    };
    // 直接つながればそれが一番よいので、中継は少し待ってから試す（直接が先に失敗したらすぐ試す）
    const relays = p2p
      ? new Promise((res) => {
          const t = setTimeout(() => res(startRelays()), RELAY_DELAY);
          p2p.then(
            () => {
              clearTimeout(t);
              res([]);
            },
            () => {
              clearTimeout(t);
              res(startRelays());
            },
          );
        })
      : Promise.resolve(startRelays());
    const relayWinner = relays.then((list) => (list.length ? Promise.any(list) : Promise.reject(new Error('none'))));
    let winner = null;
    try {
      winner = await Promise.any(p2p ? [p2p, relayWinner] : [relayWinner]);
    } catch {
      winner = null;
    }
    // 遅れてつながった方は閉じる
    const closeLosers = () => {
      for (const t of tries) {
        t.then(
          (ch) => {
            if (ch !== winner) ch.close();
          },
          () => {},
        );
      }
    };
    closeLosers();
    relays.then(closeLosers);
    this.attempting = false;
    // PeerJS の接続は、直接か PeerJS 中継で使うときだけ残す
    if (!winner || winner.kind === 'relay' || this.stopped) this._destroyPeer(peer);
    else this.peer = peer;
    if (this.stopped) {
      winner?.close();
      return;
    }
    if (!winner) {
      this.failures++;
      this._status(this.everConnected ? 'reconnecting' : 'host-unavailable');
      this._scheduleRetry();
      return;
    }
    this._use(winner, peer);
  }

  _use(ch, peer) {
    this.ch = ch;
    this.kind = ch.kind;
    this.failures = 0;
    this.everConnected = true;
    this.lastMsgAt = Date.now();
    ch.onmessage = (msg) => {
      if (ch !== this.ch) return;
      this.lastMsgAt = Date.now();
      if (msg && msg.t === 'pong') return;
      this.opts.onMessage?.(msg);
    };
    ch.onclose = () => {
      if (ch !== this.ch || this.stopped) return;
      this.ch = null;
      if (ch.kind !== 'relay') this._destroyPeer(peer);
      this._status('reconnecting');
      this._scheduleRetry(500);
    };
    this._status('connected');
    this.opts.onOpen?.();
  }

  _scheduleRetry(delay) {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const d = delay ?? Math.min(10000, 1000 * 2 ** Math.min(this.failures, 3));
    this.retryTimer = setTimeout(() => this._attempt(), d);
  }

  reconnectNow() {
    if (this.stopped) return;
    const ch = this.ch;
    this.ch = null;
    ch?.close();
    this._destroyPeer(this.peer);
    clearTimeout(this.retryTimer);
    this._attempt();
  }

  _tick() {
    if (this.stopped || !this.isOpen()) return;
    if (Date.now() - this.lastMsgAt > STALE_AFTER) {
      // 応答がない：切れているとみなしてつなぎ直す
      this.reconnectNow();
      return;
    }
    this.send({ t: 'ping' });
  }

  send(msg) {
    if (!this.isOpen()) return false;
    return this.ch.send(msg);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.pingTimer);
    document.removeEventListener('visibilitychange', this._onVisible);
    window.removeEventListener('online', this._onVisible);
    const ch = this.ch;
    this.ch = null;
    ch?.close();
    this._destroyPeer(this.peer);
  }
}

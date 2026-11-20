// 参加者側の通信。ホストへ「直接（WebRTC）」でつなぎに行き、少し待ってもつながらなければ
// 「PeerJS 中継」「MQTT 中継」（どちらも暗号化）も同時に試し、最初につながった方を使う。
// スマホのモバイル回線などで直接つながらなくても、中継で参加できる。
// 切れたら自動でつなぎ直す。
/* global Peer */
import { dialRelay, dialSignal } from './relay.js?v=1.4.0';

const PING_EVERY = 4000;
const STALE_AFTER = 15000;
const P2P_TIMEOUT = 12000;
const RELAY_TIMEOUT = 15000;
const RELAY_DELAY = 2500;

/** 直接（WebRTC）でホストにつなぐ。つながったら channel を返す。 */
export function dialP2P({ hostId, peerOptions, timeout = P2P_TIMEOUT }) {
  return new Promise((resolve, reject) => {
    if (typeof Peer === 'undefined' || typeof RTCPeerConnection === 'undefined') {
      reject(new Error('p2p-unavailable'));
      return;
    }
    let settled = false;
    let peer;
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
        try {
          conn?.close();
        } catch {
          /* ignore */
        }
        try {
          peer?.destroy();
        } catch {
          /* ignore */
        }
      },
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        peer?.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error('timeout')), timeout);
    try {
      peer = new Peer({ debug: 0, ...peerOptions });
    } catch (e) {
      fail(e);
      return;
    }
    peer.on('error', (err) => {
      if (!settled) fail(Object.assign(new Error(err?.type || 'peer-error'), { type: err?.type }));
    });
    peer.on('open', () => {
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
        if (!settled) fail(new Error('closed'));
        else if (!ch.closed) {
          ch.closed = true;
          try {
            peer.destroy();
          } catch {
            /* ignore */
          }
          ch.onclose?.();
        }
      };
      conn.on('close', lost);
      conn.on('error', lost);
      conn.on('iceStateChanged', (s) => {
        if (s === 'failed' || s === 'closed') lost();
      });
    });
  });
}

export class PlayerNet {
  /**
   * @param {object} opts
   * @param {string} opts.room
   * @param {string} opts.hostId          PeerJS 上のホストの ID
   * @param {object} opts.peerOptions
   * @param {string[]} opts.brokers       中継に使う MQTT ブローカー（wss://…）
   * @param {'auto'|'p2p'|'relay'|'sig'|'mqtt'} opts.mode  relay = 中継の両方
   * @param {(status:string)=>void} opts.onStatus
   * @param {()=>void} opts.onOpen        つながったとき（hello を送る）
   * @param {(msg:any)=>void} opts.onMessage
   */
  constructor(opts) {
    this.opts = opts;
    this.ch = null;
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
    const diag = { p2p: use.p2p ? 'trying' : 'off', sig: use.sig ? 'trying' : 'off', relay: use.mqtt ? 'trying' : 'off' };
    this.diag = diag;
    const track = (key, t) => {
      t.then(
        () => (diag[key] = 'ok'),
        (e) => (diag[key] = key === 'relay' && e?.relay ? { reason: e.message, ...e.relay } : e?.type || e?.message || 'error'),
      );
      return t;
    };
    const tries = [];
    const p2p = use.p2p ? track('p2p', dialP2P({ hostId: this.opts.hostId, peerOptions: this.opts.peerOptions })) : null;
    if (p2p) tries.push(p2p);
    const startRelays = () => {
      const list = [];
      if (use.sig) list.push(track('sig', dialSignal({ hostId: this.opts.hostId, peerOptions: this.opts.peerOptions })));
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
    this._use(winner);
  }

  _use(ch) {
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
  }
}

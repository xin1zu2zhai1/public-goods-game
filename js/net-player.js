// 参加者側の通信（PeerJS / WebRTC）。ホストのブラウザに直接つなぎ、切れたら自動でつなぎ直す。
/* global Peer */

const OPEN_TIMEOUT = 12000;
const PING_EVERY = 4000;
const STALE_AFTER = 14000;

export class PlayerNet {
  /**
   * @param {object} opts
   * @param {string} opts.hostId
   * @param {object} opts.peerOptions
   * @param {(status:string, detail?:string)=>void} opts.onStatus
   * @param {()=>void} opts.onOpen       接続できたとき（hello を送る）
   * @param {(msg:any)=>void} opts.onMessage
   */
  constructor(opts) {
    this.opts = opts;
    this.peer = null;
    this.conn = null;
    this.stopped = false;
    this.everConnected = false;
    this.failures = 0;
    this.retryTimer = null;
    this.openTimer = null;
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
    return Boolean(this.conn && this.conn.open);
  }

  _status(s, detail) {
    this.status = s;
    this.opts.onStatus?.(s, detail);
  }

  start() {
    this.stopped = false;
    this._ensurePeer();
  }

  _ensurePeer() {
    if (this.stopped) return;
    if (typeof Peer === 'undefined') {
      this._status('error', '通信ライブラリを読み込めませんでした。ページを再読み込みしてください。');
      return;
    }
    if (this.peer && !this.peer.destroyed) {
      if (this.peer.disconnected) {
        try {
          this.peer.reconnect();
        } catch {
          this._newPeer();
        }
        return;
      }
      if (this.peer.open) this._connect();
      return;
    }
    this._newPeer();
  }

  _newPeer() {
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this._status(this.everConnected ? 'reconnecting' : 'connecting');
    const peer = new Peer({ debug: 1, ...this.opts.peerOptions });
    this.peer = peer;
    peer.on('open', () => {
      if (peer === this.peer) this._connect();
    });
    peer.on('disconnected', () => {
      if (peer !== this.peer || this.stopped) return;
      // シグナリングサーバーとだけ切れた。ホストとの通信が生きていればそのまま使う。
      if (!this.isOpen()) this._scheduleRetry();
    });
    peer.on('error', (err) => {
      if (peer !== this.peer || this.stopped) return;
      if (err?.type === 'peer-unavailable') {
        this.failures++;
        this._status(this.everConnected ? 'reconnecting' : 'host-unavailable');
        this._scheduleRetry();
        return;
      }
      if (err?.type === 'browser-incompatible') {
        this._status('error', 'このブラウザは対応していません。別のブラウザ（Chrome / Safari など）で開いてください。');
        return;
      }
      this.failures++;
      this._status('reconnecting');
      if (peer.destroyed) this.peer = null;
      this._scheduleRetry();
    });
  }

  _connect() {
    if (this.stopped) return;
    if (this.conn) {
      try {
        this.conn.close();
      } catch {
        /* ignore */
      }
    }
    const conn = this.peer.connect(this.opts.hostId, { reliable: true, serialization: 'json' });
    if (!conn) {
      this._scheduleRetry();
      return;
    }
    this.conn = conn;
    clearTimeout(this.openTimer);
    this.openTimer = setTimeout(() => {
      if (conn === this.conn && !conn.open) {
        this.failures++;
        try {
          conn.close();
        } catch {
          /* ignore */
        }
        this._status(this.everConnected ? 'reconnecting' : 'host-unavailable');
        this._scheduleRetry();
      }
    }, OPEN_TIMEOUT);
    conn.on('open', () => {
      if (conn !== this.conn) return;
      clearTimeout(this.openTimer);
      this.failures = 0;
      this.everConnected = true;
      this.lastMsgAt = Date.now();
      this._status('connected');
      this.opts.onOpen?.();
    });
    conn.on('data', (msg) => {
      if (conn !== this.conn) return;
      this.lastMsgAt = Date.now();
      if (msg && msg.t === 'pong') return;
      this.opts.onMessage?.(msg);
    });
    const lost = () => {
      if (conn !== this.conn || this.stopped) return;
      this.conn = null;
      this._status('reconnecting');
      this._scheduleRetry();
    };
    conn.on('close', lost);
    conn.on('error', lost);
    conn.on('iceStateChanged', (s) => {
      if (s === 'failed' || s === 'closed') lost();
    });
  }

  _scheduleRetry() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    const delay = Math.min(10000, 1500 * 2 ** Math.min(this.failures, 3));
    this.retryTimer = setTimeout(() => this._ensurePeer(), delay);
  }

  reconnectNow() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    if (this.conn) {
      const c = this.conn;
      this.conn = null;
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    this._ensurePeer();
  }

  _tick() {
    if (this.stopped) return;
    if (this.isOpen()) {
      if (Date.now() - this.lastMsgAt > STALE_AFTER) {
        // 応答がない：切れているとみなしてつなぎ直す
        this.reconnectNow();
        return;
      }
      this.send({ t: 'ping' });
    }
  }

  send(msg) {
    if (!this.isOpen()) return false;
    try {
      this.conn.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.openTimer);
    clearInterval(this.pingTimer);
    document.removeEventListener('visibilitychange', this._onVisible);
    window.removeEventListener('online', this._onVisible);
    try {
      this.conn?.close();
    } catch {
      /* ignore */
    }
    try {
      this.peer?.destroy();
    } catch {
      /* ignore */
    }
    this.conn = null;
    this.peer = null;
  }
}

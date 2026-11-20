// 設定値。ホスト側リポジトリ（public-goods-host）の js/config.js と PEER_ID_PREFIX を必ず揃えること。

/** PeerJS のサーバー上でルームを識別する接頭辞（ルームコードの前に付く） */
export const PEER_ID_PREFIX = 'pgg7f3k-';

/** ホストと通信の取り決めのバージョン（ホストの game.js の PROTOCOL_VERSION と同じ値） */
export const PROTOCOL_VERSION = 1;

/**
 * 中継（リレー）に使う公開 MQTT ブローカー（WebSocket / wss）。
 * ブラウザ同士が直接つながらないとき（スマホのモバイル回線など）に、ここを経由して通信する。
 * 中身は暗号化されるので、ブローカーには読めない。ホスト側と参加者側で同じ一覧にすること。
 * URL に ?relay=wss://…,wss://… を付けると差し替えられる（QRコードにも引き継がれる）。
 */
export const RELAY_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://mqtt.eclipseprojects.io:443/mqtt',
];

export function relayBrokersFromParam(value) {
  if (value === null || value === undefined || value === '') return RELAY_BROKERS;
  if (value === 'off') return [];
  const list = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^wss?:\/\/[^\s]+$/i.test(s));
  return list.length ? list : RELAY_BROKERS;
}

/**
 * 接続サーバーの指定。通常は空（PeerJS の公開サーバーを使う）。
 * ホストが ?peer=... を付けて開いた場合は、QRコードにも同じ値が入る。
 */
export function peerOptionsFromParam(value) {
  if (!value) return {};
  try {
    const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(value);
    const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `${local ? 'http' : 'https'}://${value}`);
    const secure = url.protocol === 'https:';
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : secure ? 443 : 80,
      path: url.pathname || '/',
      secure,
    };
  } catch {
    return {};
  }
}

export function newPid() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

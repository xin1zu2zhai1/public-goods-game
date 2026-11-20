// 設定値。ホスト側リポジトリ（public-goods-host）の js/config.js と PEER_ID_PREFIX を必ず揃えること。

/** PeerJS のサーバー上でルームを識別する接頭辞（ルームコードの前に付く） */
export const PEER_ID_PREFIX = 'pgg7f3k-';

/** ホストと通信の取り決めのバージョン（ホストの game.js の PROTOCOL_VERSION と同じ値） */
export const PROTOCOL_VERSION = 1;

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

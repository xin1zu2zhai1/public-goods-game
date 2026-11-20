import { PlayerNet } from './net-player.js?v=1.6.0';
import { PEER_ID_PREFIX, PROTOCOL_VERSION, peerOptionsFromParam, relayBrokersFromParam, newPid } from './config.js?v=1.6.0';
import { lineChart, legend } from './chart.js?v=1.6.0';
import { h, replace, yen, downloadText } from './dom.js?v=1.6.0';

const params = new URLSearchParams(location.search);
const peerParam = params.get('peer') || '';
const peerOptions = peerOptionsFromParam(peerParam);
const relayBrokers = relayBrokersFromParam(params.get('relay'));
// 接続方法の指定（トラブル調査用）：?transport=p2p（直接のみ）/ sig（PeerJS中継のみ）/ mqtt（MQTT中継のみ）/ relay（中継のみ）/ auto（通常）
const transport = ['relay', 'p2p', 'sig', 'mqtt'].includes(params.get('transport')) ? params.get('transport') : 'auto';
const $ = (id) => document.getElementById(id);

const app = {
  room: '',
  identity: null,
  net: null,
  status: 'idle',
  view: null,
  viewSeq: 0,
  refused: null,
  joinError: '',
  joinDiag: '',
  unavailable: 0,
  screenKey: '',
  screen: null,
  builtSeq: -1,
  draft: { round: 0, contribution: null, punish: {} },
  editing: false,
  sending: null,
  sendTimer: null,
  commentDraft: '',
};

// ------------------------------------------------------------------ 保存

const idKey = (room) => `pgg-id-${room}`;

function loadIdentity(room) {
  try {
    const v = JSON.parse(localStorage.getItem(idKey(room)) || 'null');
    if (v && typeof v.pid === 'string' && v.pid.length >= 8) return v;
  } catch {
    /* ignore */
  }
  return null;
}

function saveIdentity() {
  try {
    localStorage.setItem(idKey(app.room), JSON.stringify(app.identity));
    localStorage.setItem('pgg-last-name', app.identity.name || '');
  } catch {
    /* ignore */
  }
}

function clearIdentity(room) {
  try {
    localStorage.removeItem(idKey(room));
  } catch {
    /* ignore */
  }
}

function lastName() {
  try {
    return localStorage.getItem('pgg-last-name') || '';
  } catch {
    return '';
  }
}

function normalizeRoom(v) {
  const s = String(v ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\D/g, '');
  return s.length === 6 ? s : '';
}

// ------------------------------------------------------------------ 接続

function join(room, name) {
  app.net?.stop();
  app.room = room;
  const known = loadIdentity(room);
  app.identity = known ?? { pid: newPid(), name: '' };
  if (name !== undefined) app.identity.name = String(name).trim().slice(0, 16);
  if (known) saveIdentity(); // 新しい参加者はホストに受け付けられてから保存する
  app.view = null;
  app.refused = null;
  app.joinError = '';
  app.unavailable = 0;
  app.editing = false;
  app.sending = null;
  const u = new URL(location.href);
  u.searchParams.set('room', room);
  history.replaceState(null, '', u);
  app.net = new PlayerNet({
    room,
    hostId: PEER_ID_PREFIX + room,
    peerOptions,
    brokers: relayBrokers,
    mode: transport,
    onStatus,
    onOpen: () => app.net.send({ t: 'hello', v: PROTOCOL_VERSION, pid: app.identity.pid, name: app.identity.name }),
    onMessage,
  });
  app.net.start();
  render();
}

function describeDiag(d) {
  if (!d) return '';
  const p2p =
    {
      off: '使用しない',
      trying: '確認中',
      ok: 'OK',
      'peer-unavailable': 'ルームなし',
      timeout: '時間切れ',
      'p2p-unavailable': '非対応',
      closed: '切断された',
      'server-timeout': 'サーバーの応答なし',
      network: 'サーバーにつながらない',
      'server-error': 'サーバーにつながらない',
      'socket-error': 'サーバーにつながらない',
      'socket-closed': 'サーバーにつながらない',
    }[d.p2p] ?? `失敗（${d.p2p}）`;
  let relay;
  if (typeof d.relay === 'object' && d.relay) {
    const list = d.relay.brokers ?? [];
    relay = list.length
      ? list.map((b) => `${b.label} ${!b.connected ? '×接続できない' : b.host ? '○ホストあり' : '○ホストなし'}`).join('、')
      : `サーバー ${d.relay.connected}/${d.relay.total}`;
  } else {
    relay = { off: '使用しない', trying: '確認中', ok: 'OK', 'relay-unavailable': '非対応' }[d.relay] ?? `失敗（${d.relay}）`;
  }
  const sig =
    {
      off: '使用しない',
      trying: '確認中',
      ok: 'OK',
      'peer-unavailable': 'ルームなし',
      'no-reply': 'ホストの応答なし',
      timeout: '時間切れ',
      'sig-unavailable': '非対応',
      'server-timeout': 'サーバーの応答なし',
      network: 'サーバーにつながらない',
      'server-error': 'サーバーにつながらない',
      'socket-error': 'サーバーにつながらない',
      'socket-closed': 'サーバーにつながらない',
    }[d.sig] ?? `失敗（${d.sig}）`;
  const server =
    { off: '使用しない', trying: '確認中', ok: '接続OK', 'server-timeout': '応答なし' }[d.server] ??
    `接続できない（${d.server}${d.serverMsg ? `：${d.serverMsg}` : ''}）`;
  return `詳細：PeerJSサーバー＝${server}／直接＝${p2p}／PeerJS中継＝${sig}／MQTT中継＝${relay}`;
}

function leave(error = '') {
  app.joinDiag = error ? describeDiag(app.net?.diag) : '';
  app.net?.stop();
  app.net = null;
  app.view = null;
  app.refused = null;
  app.joinError = error;
  render();
}

function onStatus(s) {
  app.status = s;
  if (s === 'host-unavailable' && app.net && !app.net.everConnected) {
    app.unavailable++;
    if (app.unavailable >= 2) {
      leave('ルームにつながりませんでした。ルームコードが正しいか、先生の画面が開いているかを確認して、もう一度「参加する」を押してください。');
      return;
    }
  }
  render();
}

function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.t) {
    case 'welcome':
      if (typeof msg.name === 'string') app.identity.name = msg.name;
      saveIdentity();
      break;
    case 'view':
      app.view = msg;
      app.viewSeq++;
      if (app.draft.round !== msg.roundNo) {
        app.draft = { round: msg.roundNo, contribution: null, punish: {} };
        app.editing = false;
      }
      break;
    case 'ack':
      clearTimeout(app.sendTimer);
      app.sending = null;
      if (msg.ok) {
        if (msg.what === 'comment') {
          app.commentDraft = '';
          const ta = document.getElementById('commentText');
          if (ta) ta.value = '';
          toast('コメントを送りました');
        } else {
          app.editing = false;
        }
      } else {
        const why = {
          phase: '締め切られたため、送信できませんでした',
          rate: '少し時間をおいてから送ってください',
          closed: 'コメントの受付は終了しています',
          empty: 'コメントを入力してください',
        }[msg.reason] ?? '送信できませんでした';
        toast(why);
      }
      break;
    case 'refused':
      app.refused = msg.reason || 'invalid';
      app.net?.stop();
      break;
    case 'replaced':
      app.refused = 'replaced';
      app.net?.stop();
      break;
    case 'closed':
      app.refused = 'room-closed';
      app.net?.stop();
      break;
    default:
      return;
  }
  render();
}

function send(what, payload) {
  if (!app.net || !app.net.send({ t: what, ...payload })) {
    toast('接続が切れています。再接続を待ってからもう一度押してください');
    return false;
  }
  app.sending = what;
  clearTimeout(app.sendTimer);
  app.sendTimer = setTimeout(() => {
    if (app.sending === what) {
      app.sending = null;
      toast('送信を確認できませんでした。もう一度押してください');
      render();
    }
  }, 7000);
  render();
  return true;
}

// ------------------------------------------------------------------ 描画

function render() {
  const [key, build] = pickScreen();
  const viewChanged = app.builtSeq !== app.viewSeq;
  if (key !== app.screenKey || !app.screen) {
    app.screenKey = key;
    app.screen = build(app.view);
    app.builtSeq = app.viewSeq;
    replace($('screen'), app.screen.el);
    window.scrollTo({ top: 0 });
  } else if (app.screen.update) {
    app.screen.update(app.view);
    app.builtSeq = app.viewSeq;
  } else if (viewChanged) {
    const open = [...$('screen').querySelectorAll('details[data-k]')].filter((d) => d.open).map((d) => d.dataset.k);
    app.screen = build(app.view);
    app.builtSeq = app.viewSeq;
    replace($('screen'), app.screen.el);
    for (const k of open) {
      const d = $('screen').querySelector(`details[data-k="${k}"]`);
      if (d) d.open = true;
    }
  }
  renderHeader();
}

function pickScreen() {
  if (app.refused) return [`refused:${app.refused}`, screenRefused];
  if (!app.net) return ['join', screenJoin];
  const v = app.view;
  if (!v) return [`connecting`, screenConnecting];
  const sig = `${v.roundNo}:${v.punishment}:${v.params.endowment}:${v.params.multiplier}:${v.params.punishCost}:${v.params.punishEffect}:${v.params.punishMax}:${v.group?.size}:${v.showNames}`;
  switch (v.phase) {
    case 'lobby':
      return ['lobby', screenLobby];
    case 'contribute':
      if (!v.inRound) return ['wait', screenWait];
      if (v.my.contribution !== null && !app.editing) return [`csent:${v.roundNo}`, screenContributeSent];
      return [`contribute:${sig}`, screenContribute];
    case 'punish':
      if (!v.inRound) return ['wait', screenWait];
      if (v.my.punishment !== null && !app.editing) return [`psent:${v.roundNo}`, screenPunishSent];
      return [`punish:${sig}`, screenPunish];
    case 'result':
      if (!v.inRound || !v.result) return ['wait', screenWait];
      return [`result:${v.roundNo}`, screenResult];
    case 'ended':
      return [`ended:${v.acceptComments}`, screenEnded];
    default:
      return ['connecting', screenConnecting];
  }
}

function renderHeader() {
  const v = app.view;
  const parts = [];
  if (app.net) {
    if (app.identity?.name) parts.push(app.identity.name);
    if (v?.me?.groupId) parts.push(`G${v.me.groupId}-${v.me.label}`);
    if (!parts.length && app.room) parts.push(`ルーム ${app.room}`);
  }
  $('who').textContent = parts.join(' ・ ');
  $('who').title = app.room ? `ルーム ${app.room}` : '';
  const net = $('netStatus');
  const s = app.net ? app.status : 'idle';
  net.dataset.s = s;
  net.textContent = app.net
    ? {
        connecting: '接続中…',
        connected: app.net.kind === 'p2p' ? '接続OK（直接）' : '接続OK（中継）',
        reconnecting: '再接続中…',
        'host-unavailable': 'ルームを探しています…',
        error: 'エラー',
      }[s] ?? ''
    : '';
  const banner = $('banner');
  const lost = app.net && app.view && s !== 'connected';
  banner.hidden = !lost;
  if (lost) banner.textContent = '接続が切れました。自動で再接続しています…（このページは閉じないでください）';
}

// ---------- 共通パーツ

function memberName(m) {
  if (m.me) return 'あなた';
  return m.name ? m.name : `メンバー${m.label}`;
}

function roundBadges(v, extra) {
  return h(
    'div',
    { class: 'badges' },
    h('span', { class: 'badge accent' }, `ラウンド ${v.roundNo}`),
    h('span', { class: `badge ${v.punishment ? 'punish' : ''}` }, v.punishment ? '罰則あり' : '罰則なし'),
    v.group ? h('span', { class: 'badge' }, `グループ${v.group.id}（${v.group.size}人）`) : null,
    extra,
  );
}

function progressBlock(v, label) {
  const g = v.progress?.group ?? { submitted: 0, total: 0 };
  const text = h('div', { class: 'num' }, `${label}：${g.submitted} / ${g.total}人`);
  const bar = h('i', { style: { width: `${g.total ? (100 * g.submitted) / g.total : 0}%` } });
  const el = h('div', null, text, h('div', { class: 'bar' }, bar));
  return {
    el,
    update(nv) {
      const gg = nv.progress?.group ?? { submitted: 0, total: 0 };
      text.textContent = `${label}：${gg.submitted} / ${gg.total}人`;
      bar.style.width = `${gg.total ? (100 * gg.submitted) / gg.total : 0}%`;
    },
  };
}

function historyChart(v) {
  if (!v.history.length) return null;
  const xs = v.history.map((x) => `R${x.no}`);
  const E = Math.max(...v.history.map((x) => x.endowment));
  const anyP = v.history.some((x) => x.punishment);
  const items = [
    { name: 'あなた', color: 'var(--series-1)' },
    { name: 'グループ平均', color: 'var(--series-2)', dash: true },
    { name: 'クラス平均', color: 'var(--series-3)' },
  ];
  if (anyP) items.push({ name: '罰則あり', shade: true });
  return h(
    'section',
    { class: 'card' },
    h('h3', null, '拠出額の推移'),
    lineChart({
      xLabels: xs,
      series: [
        { name: 'クラス平均', values: v.history.map((x) => x.classAvg), color: 'var(--series-3)', width: 2.5 },
        { name: 'グループ平均', values: v.history.map((x) => x.groupAvg), color: 'var(--series-2)', width: 2.5, dash: '6 4' },
        { name: 'あなた', values: v.history.map((x) => x.contribution), color: 'var(--series-1)', width: 3.5, dotSize: 5 },
      ],
      shade: v.history.map((x) => x.punishment),
      shadeLabel: '罰則',
      yMax: E,
      width: 360,
      height: 230,
      title: 'ラウンドごとの拠出額（円）',
    }),
    legend(items),
  );
}

function historyTable(v, open = false) {
  if (!v.history.length) return null;
  return h(
    'details',
    { class: 'card', 'data-k': 'history', open },
    h('summary', null, `これまでの記録（${v.history.length}ラウンド）`),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'mtable', style: { marginTop: '10px' } },
        h('thead', null, h('tr', null, ['回', '罰則', '出した額', 'グループ平均', '利得', '累計'].map((t) => h('th', { scope: 'col' }, t)))),
        h(
          'tbody',
          null,
          v.history.map((x) =>
            h(
              'tr',
              null,
              h('td', null, `R${x.no}`),
              h('td', null, x.punishment ? 'あり' : 'なし'),
              h('td', null, yen(x.contribution), x.missing ? h('span', { class: 'tag' }, '未入力') : null),
              h('td', null, yen(x.groupAvg)),
              h('td', null, yen(x.payoff)),
              h('td', null, yen(x.cumulative)),
            ),
          ),
        ),
      ),
    ),
  );
}

function rulesCard(v, open = true) {
  const p = v.params;
  const n = v.group?.size;
  return h(
    'details',
    { class: 'card', 'data-k': 'rules', open },
    h('summary', null, 'ルール'),
    h(
      'ol',
      { class: 'rules' },
      h('li', null, `はじめに、一人 ${yen(p.endowment)} を持っています。`),
      h('li', null, `そのうちいくらをグループの「共有財産」に出すかを決めます（0〜${yen(p.endowment)}）。だれがいくら出したかは匿名です。`),
      h('li', null, `共有財産に集まったお金は ${p.multiplier}倍 になり、グループ${n ? `の${n}人` : ''}全員で等しく分けます（出した額に関係なく）。`),
      h('li', null, '出さなかったお金は、そのまま自分のものになります。'),
      v.nextPunishment || v.punishment
        ? h('li', null, `【罰則ルール】結果を見たあとで、ほかのメンバーに罰を与えられます。罰1回につき、あなたは ${yen(p.punishCost)} 払い、相手は ${yen(p.punishEffect)} 減ります。`)
        : null,
    ),
    h('p', { class: 'hint' }, 'あなたの利得 ＝（持っているお金 − 出した額）＋（グループの合計 × ', `${p.multiplier}`, ' ÷ 人数）'),
  );
}

// ---------- 参加

function screenJoin() {
  const preRoom = normalizeRoom(params.get('room')) || app.room;
  const known = preRoom ? loadIdentity(preRoom) : null;
  const roomInput = h('input', {
    id: 'room',
    class: 'code-input',
    inputmode: 'numeric',
    autocomplete: 'off',
    maxlength: 7,
    placeholder: '000000',
    'aria-describedby': 'roomHelp',
    value: preRoom,
  });
  const nameInput = h('input', {
    id: 'name',
    type: 'text',
    maxlength: 16,
    placeholder: '例：たろう（空欄でもOK）',
    autocomplete: 'nickname',
    value: known?.name || lastName(),
  });
  const err = h(
    'div',
    { role: 'alert' },
    h('p', { class: 'error' }, app.joinError || ''),
    app.joinDiag ? h('p', { class: 'note' }, app.joinDiag) : null,
  );
  if (!app.joinError) err.hidden = true;
  const form = h(
    'form',
    {
      class: 'card',
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        const room = normalizeRoom(roomInput.value);
        if (!room) {
          err.textContent = 'ルームコードは6けたの数字です';
          err.hidden = false;
          roomInput.focus();
          return;
        }
        join(room, nameInput.value);
      },
    },
    h('h2', null, 'ゲームに参加する'),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'room' }, 'ルームコード（6けた）'),
      roomInput,
      h('p', { class: 'note', id: 'roomHelp' }, '先生の画面に表示されている数字です。QRコードから開いた場合は入力済みです。'),
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'name' }, 'ニックネーム'),
      nameInput,
      h('p', { class: 'note' }, '先生の画面に表示されます。ほかの参加者には、ふだんは「A」「B」などの記号で表示されます。'),
    ),
    err,
    h('button', { class: 'btn primary block', type: 'submit' }, '参加する'),
  );
  const parts = [];
  if (known) {
    parts.push(
      h(
        'section',
        { class: 'card' },
        h('h2', null, 'つづきから参加'),
        h('p', null, `ルーム ${preRoom} に「${known.name || '（名前なし）'}」として参加していました。`),
        h('button', { class: 'btn primary block', type: 'button', onclick: () => join(preRoom, known.name) }, 'この名前でもう一度参加'),
        h(
          'button',
          {
            class: 'link',
            type: 'button',
            onclick: () => {
              clearIdentity(preRoom);
              app.screenKey = '';
              render();
            },
          },
          '別の参加者として参加する',
        ),
      ),
    );
  }
  parts.push(form);
  parts.push(
    h(
      'section',
      { class: 'card' },
      h('h3', null, '公共財ゲームとは'),
      h(
        'p',
        { class: 'note' },
        'グループのみんなでお金を出し合うゲームです。みんなが協力すれば全員が得をしますが、自分だけ出さないともっと得をするかもしれません。あなたならどうしますか？',
      ),
    ),
  );
  const el = h('div', { class: 'stack' }, parts);
  setTimeout(() => (preRoom ? nameInput : roomInput).focus({ preventScroll: true }), 0);
  return { el };
}

function screenConnecting() {
  const msg = h('p', null, '');
  const el = h(
    'section',
    { class: 'card center' },
    h('div', { class: 'spinner', 'aria-hidden': 'true' }),
    h('h2', null, `ルーム ${app.room}`),
    msg,
    h('button', { class: 'btn', type: 'button', onclick: () => leave('') }, 'やめる'),
  );
  const update = () => {
    msg.textContent =
      {
        'host-unavailable': 'ルームを探しています…（先生の画面が開いているか確認してください）',
        reconnecting: '再接続しています…',
        error: '接続できませんでした。ページを再読み込みしてください。',
      }[app.status] ?? 'ルームに接続しています…';
  };
  update();
  return { el, update };
}

function screenRefused() {
  const reason = app.refused;
  const info = {
    closed: ['参加の受付が締め切られています', '先生に伝えて、受付を再開してもらってください。', 'もう一度試す', () => join(app.room)],
    removed: ['ゲームから外れました', '先生がこの参加を取り消しました。参加し直す場合は、新しい参加者として参加してください。', '新しい参加者として参加', () => { clearIdentity(app.room); join(app.room); }],
    version: ['ページを更新してください', '先生の画面とこのページのバージョンが違います。再読み込みしてください。', '再読み込み', () => location.reload()],
    replaced: ['別の画面で接続しました', '同じ参加者として、別のタブや端末から接続されました。', 'この画面で接続し直す', () => join(app.room)],
    'room-closed': ['このルームは終了しました', '先生が新しいルームを作りました。新しいルームコードを入力してください。', '別のルームに参加', () => { app.refused = null; leave(''); }],
  }[reason] ?? ['参加できませんでした', 'もう一度お試しください。', 'やり直す', () => leave('')];
  const el = h(
    'section',
    { class: 'card center' },
    h('h2', null, info[0]),
    h('p', null, info[1]),
    h('button', { class: 'btn primary block', type: 'button', onclick: info[3] }, info[2]),
  );
  return { el };
}

// ---------- 待機

function screenLobby(v) {
  const el = h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card center' },
      h('div', { class: 'sent' }, h('div', { class: 'check', 'aria-hidden': 'true' }, '✓')),
      h('h2', null, '参加しました'),
      h('p', { class: 'big-label' }, app.identity?.name || ''),
      v.group
        ? h('p', null, 'あなたは ', h('b', null, `グループ${v.group.id}`), ' の ', h('b', null, `メンバー${v.me.label}`), ` です（${v.group.size}人）`)
        : null,
      h('p', { class: 'muted' }, '先生がゲームを始めるまで、このままお待ちください。'),
    ),
    rulesCard(v, true),
    h('p', { class: 'note', style: { textAlign: 'center' } }, 'ゲーム中はこのページを開いたままにしてください。閉じてしまったら、同じQRコードから開き直せば続きから参加できます。'),
  );
  return { el };
}

function screenWait(v) {
  const el = h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card center' },
      h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('h2', null, '次のラウンドから参加します'),
      h('p', { class: 'muted' }, `いまはラウンド${v.roundNo}の途中です。次のラウンドが始まるまでお待ちください。`),
    ),
    historyChart(v),
    rulesCard(v, false),
  );
  return { el };
}

// ---------- 拠出

function screenContribute(v) {
  const E = v.params.endowment;
  const m = v.params.multiplier;
  const n = v.group?.size || 1;
  const step = Math.max(1, Math.round(E / 100));
  const prev = v.history.length ? v.history[v.history.length - 1].contribution : null;
  let amount = app.draft.contribution ?? v.my.contribution ?? (prev !== null ? Math.min(prev, E) : null);

  const giveV = h('div', { class: 'v' }, '—');
  const keepV = h('div', { class: 'v' }, '—');
  const range = h('input', { type: 'range', min: 0, max: E, step, value: amount ?? 0, 'aria-label': '共有財産に出す金額' });
  const exact = h('input', { type: 'number', min: 0, max: E, step: 1, inputmode: 'numeric', 'aria-label': '金額をぴったり入力' });
  const quickVals = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(E * f));
  const quickBtns = quickVals.map((q) => h('button', { class: 'btn', type: 'button', onclick: () => set(q) }, yen(q)));
  const submit = h('button', { class: 'btn primary block', type: 'button' }, 'この金額で決定');
  const others = h('input', { type: 'range', min: 0, max: E, step, value: Math.round(E / 2), 'aria-label': 'ほかのメンバーの平均拠出額' });
  const othersV = h('b', null, yen(E / 2));
  const simOut = h('div', { class: 'sim-out' });

  function set(a, fromExact = false) {
    amount = Math.min(E, Math.max(0, Math.round(Number(a))));
    if (!Number.isFinite(amount)) amount = 0;
    app.draft.contribution = amount;
    refresh(fromExact);
  }

  function refresh(fromExact = false) {
    const chosen = amount !== null;
    giveV.textContent = chosen ? yen(amount) : '—';
    keepV.textContent = chosen ? yen(E - amount) : '—';
    range.value = String(amount ?? 0);
    if (!fromExact) exact.value = chosen ? String(amount) : '';
    quickBtns.forEach((b, i) => b.classList.toggle('sel', chosen && quickVals[i] === amount));
    const o = Number(others.value);
    othersV.textContent = yen(o);
    const c = amount ?? 0;
    const mine = E - c + (m * (c + o * (n - 1))) / n;
    simOut.textContent = `→ あなたの利得は ${yen(mine)}（全員が全額出せば ${yen(E * m)}）`;
    updateSubmit();
  }

  function updateSubmit() {
    const connected = app.status === 'connected';
    submit.disabled = amount === null || !connected || app.sending === 'contribute';
    submit.textContent =
      app.sending === 'contribute' ? '送信中…' : !connected ? '再接続を待っています…' : amount === null ? '金額を選んでください' : `${yen(amount)} を出して決定`;
  }

  range.addEventListener('input', () => set(range.value));
  exact.addEventListener('input', () => {
    if (exact.value !== '') set(exact.value, true);
  });
  exact.addEventListener('change', () => refresh());
  others.addEventListener('input', () => refresh());
  submit.addEventListener('click', () => {
    if (amount === null) return;
    send('contribute', { round: v.roundNo, amount });
  });

  const mpcr = Math.round((m / n) * 100) / 100;
  const el = h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card' },
      roundBadges(v),
      h('h2', null, 'いくら出しますか？'),
      h('p', null, `持っている ${yen(E)} のうち、グループの「共有財産」に出す金額を決めてください。`),
      h(
        'div',
        { class: 'amount-row' },
        h('div', { class: 'amount-box give' }, h('div', { class: 'k' }, '共有財産に出す'), giveV),
        h('div', { class: 'amount-box' }, h('div', { class: 'k' }, '手元に残す'), keepV),
      ),
      range,
      h('div', { class: 'quick' }, quickBtns),
      h('label', { class: 'exact' }, 'ぴったり入力：', exact, '円'),
      h('div', { style: { marginTop: '16px' } }, submit),
      v.punishment ? h('p', { class: 'note', style: { marginTop: '10px' } }, 'このラウンドは罰則ありです。全員が出し終わると、ほかのメンバーが出した額を見て罰を与えるかどうかを決めます。') : null,
    ),
    h(
      'section',
      { class: 'hint' },
      `集まったお金は ${m}倍 になり、${n}人で等しく分けます。あなたが出した1円は、あなたには `,
      h('b', null, `${mpcr}円`),
      ' しか戻りません。でも、みんなが出せば全員が得をします。',
    ),
    h(
      'details',
      { class: 'card sim', 'data-k': 'sim' },
      h('summary', null, '利得を試算する'),
      h('p', { class: 'note' }, 'ほかのメンバーが平均いくら出したら、あなたの利得はいくらになるかを計算できます（結果には影響しません）。'),
      h('label', null, 'ほかのメンバーの平均：', othersV),
      others,
      simOut,
    ),
    rulesCard(v, false),
  );
  refresh();
  return { el, update: () => updateSubmit() };
}

function screenContributeSent(v) {
  const prog = progressBlock(v, 'グループの入力');
  const el = h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card sent' },
      roundBadges(v),
      h('div', { class: 'check', 'aria-hidden': 'true' }, '✓'),
      h('h2', null, '送信しました'),
      h('p', null, 'あなたが共有財産に出す額'),
      h('p', { class: 'big-label' }, yen(v.my.contribution)),
      prog.el,
      h('p', { class: 'muted' }, '全員がそろうまでお待ちください。締め切られるまでは変更できます。'),
      h(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: () => {
            app.editing = true;
            app.draft.contribution = v.my.contribution;
            render();
          },
        },
        '金額を変更する',
      ),
    ),
    rulesCard(v, false),
  );
  return { el, update: (nv) => prog.update(nv) };
}

// ---------- 罰則

function screenPunish(v) {
  const p = v.params;
  const E = p.endowment;
  const alloc = { ...(app.draft.punish && Object.keys(app.draft.punish).length ? app.draft.punish : v.my.punishment ?? {}) };
  app.draft.punish = alloc;
  const me = v.reveal.find((x) => x.me);
  const others = v.reveal.filter((x) => !x.me);
  const avg = v.reveal.reduce((a, x) => a + x.contribution, 0) / Math.max(1, v.reveal.length);
  const costV = h('span', { class: 'num' });
  const submit = h('button', { class: 'btn punish block', type: 'button' });
  const rowsUpdaters = [];

  const total = () => Object.values(alloc).reduce((a, b) => a + b, 0);

  function refresh() {
    rowsUpdaters.forEach((f) => f());
    costV.textContent = `${yen(total() * p.punishCost)}（${total()}回）`;
    updateSubmit();
  }
  function updateSubmit() {
    const connected = app.status === 'connected';
    submit.disabled = !connected || app.sending === 'punish';
    submit.textContent = app.sending === 'punish' ? '送信中…' : !connected ? '再接続を待っています…' : total() ? 'この内容で決定' : '罰を与えずに決定';
  }

  const row = (x) => {
    const cnt = h('span', { class: 'cnt' });
    const effect = h('div', { class: 'sub' });
    const minus = h('button', { type: 'button', 'aria-label': `${memberName(x)}への罰を1回減らす` }, '−');
    const plus = h('button', { type: 'button', 'aria-label': `${memberName(x)}への罰を1回増やす` }, '＋');
    const upd = () => {
      const u = alloc[x.label] ?? 0;
      cnt.textContent = `${u}回`;
      cnt.classList.toggle('on', u > 0);
      effect.textContent = u ? `相手 −${yen(u * p.punishEffect)}` : '罰なし';
      minus.disabled = u <= 0;
      plus.disabled = u >= p.punishMax;
    };
    minus.addEventListener('click', () => {
      alloc[x.label] = Math.max(0, (alloc[x.label] ?? 0) - 1);
      if (!alloc[x.label]) delete alloc[x.label];
      refresh();
    });
    plus.addEventListener('click', () => {
      alloc[x.label] = Math.min(p.punishMax, (alloc[x.label] ?? 0) + 1);
      refresh();
    });
    rowsUpdaters.push(upd);
    return h(
      'div',
      { class: 'prow' },
      h('span', { class: 'lab' }, x.label),
      h(
        'div',
        { class: 'info' },
        h('div', { class: 'nm' }, memberName(x)),
        h('div', { class: 'sub num' }, `出した額 ${yen(x.contribution)}`, x.missing ? '（未入力）' : ''),
        h('div', { class: 'mini-bar' }, h('i', { style: { width: `${(100 * x.contribution) / E}%` } })),
      ),
      h('div', { style: { textAlign: 'center' } }, h('div', { class: 'stepper' }, minus, cnt, plus), effect),
    );
  };

  submit.addEventListener('click', () => send('punish', { round: v.roundNo, alloc: { ...alloc } }));

  const el = h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card' },
      roundBadges(v),
      h('h2', null, '罰を与えますか？'),
      h('p', null, `今回、グループのメンバーが出した額です。罰を1回与えるごとに、あなたは ${yen(p.punishCost)} 払い、相手は ${yen(p.punishEffect)} 減ります（1人に最大${p.punishMax}回）。`),
      h(
        'div',
        { class: 'plist' },
        h(
          'div',
          { class: 'prow me' },
          h('span', { class: 'lab' }, me.label),
          h(
            'div',
            { class: 'info' },
            h('div', { class: 'nm' }, 'あなた'),
            h('div', { class: 'sub num' }, `出した額 ${yen(me.contribution)}`),
            h('div', { class: 'mini-bar' }, h('i', { style: { width: `${(100 * me.contribution) / E}%` } })),
          ),
          h('span'),
        ),
        others.map(row),
      ),
      h('p', { class: 'note' }, `グループの平均：${yen(avg)}`),
      h('div', { class: 'cost-line' }, h('span', null, 'あなたが払う費用'), costV),
      submit,
      h('p', { class: 'note', style: { marginTop: '10px' } }, 'だれが罰を与えたかは、ほかの人には知らされません。罰を与えても、あなたのお金は増えません。'),
    ),
  );
  refresh();
  return { el, update: () => updateSubmit() };
}

function screenPunishSent(v) {
  const prog = progressBlock(v, 'グループの入力');
  const entries = Object.entries(v.my.punishment ?? {}).filter(([, u]) => u > 0);
  const sum = entries.reduce((a, [, u]) => a + u, 0);
  const el = h(
    'section',
    { class: 'card sent' },
    roundBadges(v),
    h('div', { class: 'check', 'aria-hidden': 'true' }, '✓'),
    h('h2', null, '送信しました'),
    entries.length
      ? h('p', null, entries.map(([lab, u]) => `メンバー${lab}に${u}回`).join('、'), ` の罰（費用 ${yen(sum * v.params.punishCost)}）`)
      : h('p', null, '罰は与えませんでした'),
    prog.el,
    h('p', { class: 'muted' }, '全員がそろうまでお待ちください。締め切られるまでは変更できます。'),
    h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: () => {
          app.editing = true;
          app.draft.punish = { ...(v.my.punishment ?? {}) };
          render();
        },
      },
      '変更する',
    ),
  );
  return { el, update: (nv) => prog.update(nv) };
}

// ---------- 結果

function screenResult(v) {
  const r = v.result;
  const p = r.params;
  const calcRows = [
    h('tr', null, h('td', null, '手元に残したお金', h('span', { class: 'sub' }, `${yen(p.endowment)} − 出した ${yen(r.contribution)}`)), h('td', null, yen(p.endowment - r.contribution))),
    h(
      'tr',
      null,
      h('td', null, '＋ グループからの分配', h('span', { class: 'sub' }, `合計 ${yen(r.groupSum)} × ${p.multiplier} ÷ ${r.groupN}人`)),
      h('td', null, `＋${yen(r.share)}`),
    ),
  ];
  if (r.punishment) {
    calcRows.push(
      h('tr', null, h('td', null, '− 罰を与えた費用', h('span', { class: 'sub' }, `${r.punishGiven}回 × ${yen(p.punishCost)}`)), h('td', { class: r.cost ? 'minus' : '' }, `−${yen(r.cost)}`)),
      h('tr', null, h('td', null, '− 受けた罰', h('span', { class: 'sub' }, `${r.punishReceived}回 × ${yen(p.punishEffect)}`)), h('td', { class: r.loss ? 'minus' : '' }, `−${yen(r.loss)}`)),
    );
  }
  calcRows.push(h('tr', { class: 'total' }, h('td', null, '＝ 今回の利得'), h('td', null, yen(r.payoff))));

  const showPunishCol = r.punishment;
  const members = h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'mtable' },
      h(
        'thead',
        null,
        h('tr', null, h('th', { scope: 'col' }, 'メンバー'), h('th', { scope: 'col' }, '出した額'), showPunishCol ? h('th', { scope: 'col' }, '受けた罰') : null, h('th', { scope: 'col' }, '利得')),
      ),
      h(
        'tbody',
        null,
        r.members.map((m) =>
          h(
            'tr',
            { class: m.me ? 'me' : '' },
            h('td', null, `${m.label}　${memberName(m)}`),
            h('td', null, yen(m.contribution), m.missing ? h('span', { class: 'tag' }, '未入力') : null),
            showPunishCol ? h('td', null, `${m.punishReceived}回`) : null,
            h('td', null, yen(m.payoff)),
          ),
        ),
      ),
    ),
  );

  let nextNote = '次のラウンドが始まるまでお待ちください。';
  if (v.nextPunishment !== r.punishment) nextNote = `次のラウンドから罰則${v.nextPunishment ? 'あり' : 'なし'}になります。`;

  const el = h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card payoff' },
      h(
        'div',
        { class: 'badges', style: { justifyContent: 'center' } },
        h('span', { class: 'badge ok' }, `ラウンド${v.roundNo}の結果`),
        h('span', { class: `badge ${r.punishment ? 'punish' : ''}` }, r.punishment ? '罰則あり' : '罰則なし'),
      ),
      h('div', { class: 'muted' }, '今回の利得'),
      h('div', { class: `v ${r.payoff < 0 ? 'neg' : ''}` }, yen(r.payoff)),
      h('div', { class: 'muted num' }, `累計 ${yen(v.total)}`),
      h('table', { class: 'calc' }, h('tbody', null, calcRows)),
    ),
    h(
      'section',
      { class: 'card' },
      h('h3', null, `グループ${r.groupId}の結果`),
      members,
      h(
        'div',
        { class: 'compare' },
        h('div', { class: 'c' }, h('div', { class: 'k' }, 'あなた'), h('div', { class: 'v' }, yen(r.contribution))),
        h('div', { class: 'c' }, h('div', { class: 'k' }, 'グループ平均'), h('div', { class: 'v' }, yen(r.groupAvg))),
        h('div', { class: 'c' }, h('div', { class: 'k' }, 'クラス平均'), h('div', { class: 'v' }, yen(r.classAvg))),
      ),
      h('p', { class: 'note', style: { marginTop: '8px' } }, `グループ全体の幸福度：${Math.round(r.groupEfficiency * 100)}%（全員が全額出した場合を100%）`),
    ),
    historyChart(v),
    historyTable(v),
    h('p', { class: 'next-info' }, nextNote),
  );
  return { el };
}

// ---------- 終了

function screenEnded(v) {
  const s = v.summary;
  const ta = h('textarea', { id: 'commentText', maxlength: 200, placeholder: '感じたこと、気づいたことを書いてみよう（200字まで）' });
  ta.value = app.commentDraft;
  ta.addEventListener('input', () => {
    app.commentDraft = ta.value;
  });
  const sendBtn = h('button', { class: 'btn primary', type: 'button' }, '匿名で送る');
  sendBtn.addEventListener('click', () => {
    const text = ta.value.trim();
    if (!text) {
      toast('コメントを入力してください');
      return;
    }
    send('comment', { text });
  });

  const el = h(
    'div',
    { class: 'stack' },
    h(
      'section',
      { class: 'card payoff' },
      h('h2', null, 'ゲーム終了！おつかれさまでした'),
      s && s.rounds
        ? [
            h('div', { class: 'muted', style: { marginTop: '10px' } }, `あなたの累計利得（${s.rounds}ラウンド）`),
            h('div', { class: `v ${s.myTotal < 0 ? 'neg' : ''}` }, yen(s.myTotal)),
            h(
              'div',
              { class: 'compare' },
              h('div', { class: 'c' }, h('div', { class: 'k' }, 'クラス平均'), h('div', { class: 'v' }, yen(s.classAvgTotal))),
              h('div', { class: 'c' }, h('div', { class: 'k' }, '全員が毎回全額出したら'), h('div', { class: 'v' }, yen(s.bestCase))),
              h('div', { class: 'c' }, h('div', { class: 'k' }, 'だれも出さなかったら'), h('div', { class: 'v' }, yen(s.worstCase))),
            ),
          ]
        : h('p', { class: 'muted' }, 'あなたが参加したラウンドはありませんでした。'),
    ),
    historyChart(v),
    historyTable(v, true),
    h(
      'section',
      { class: 'card' },
      h('h3', null, '振り返ってみよう'),
      h(
        'ol',
        { class: 'qs' },
        h('li', null, h('span', { class: 'tag' }, '自分の気持ち'), 'なぜあの時、自分は出す額を減らした（または増やした）のだろう？'),
        h('li', null, h('span', { class: 'tag' }, 'ルールの効果'), '罰則があるとき・ないときで、グループの雰囲気はどう変わった？'),
        h('li', null, h('span', { class: 'tag' }, '社会とのつながり'), 'このゲームの状況は、現実のどんな問題（ゴミ問題、気候変動など）に似ている？'),
        h('li', null, h('span', { class: 'tag' }, 'これから'), 'みんながもっと協力しやすい社会にするには、どんな工夫が必要だと思う？'),
      ),
    ),
    v.acceptComments
      ? h(
          'section',
          { class: 'card' },
          h('h3', null, '先生の画面にコメントを送る'),
          h('p', { class: 'note' }, '名前は表示されません。'),
          h('div', { class: 'field' }, ta),
          sendBtn,
        )
      : null,
    v.history.length
      ? h(
          'section',
          { class: 'card' },
          h('h3', null, '記録を保存'),
          h('p', { class: 'note' }, 'レポート課題などに使えるよう、自分の記録をファイル（CSV）で保存できます。'),
          h('button', { class: 'btn', type: 'button', onclick: () => downloadMine(v) }, '自分の記録をダウンロード'),
        )
      : null,
  );
  const update = () => {
    sendBtn.disabled = app.sending === 'comment' || app.status !== 'connected';
    sendBtn.textContent = app.sending === 'comment' ? '送信中…' : '匿名で送る';
  };
  update();
  return { el, update };
}

function downloadMine(v) {
  const head = ['ラウンド', 'ステージ', '罰則', '出した額', '未入力', 'グループ人数', 'グループ合計', 'グループ平均', 'クラス平均', '分配額', '罰の費用', '受けた罰による減額', '利得', '累計'];
  const r1 = (x) => Math.round(x * 10) / 10;
  const rows = v.history.map((x) => [x.no, x.stage, x.punishment ? 'あり' : 'なし', x.contribution, x.missing ? '未入力' : '', x.groupN, x.groupSum, r1(x.groupAvg), r1(x.classAvg), r1(x.share), x.cost, x.loss, r1(x.payoff), r1(x.cumulative)]);
  const csv = [head, ...rows].map((r) => r.join(',')).join('\r\n');
  downloadText(`公共財ゲーム_自分の記録_${v.room}.csv`, csv);
}

// ------------------------------------------------------------------ その他

let toastTimer = null;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 2600);
}

function setupFont() {
  let large = false;
  try {
    large = localStorage.getItem('pgg-font-large') === '1';
  } catch {
    /* ignore */
  }
  const apply = () => {
    document.body.classList.toggle('large', large);
    $('btnFont').setAttribute('aria-pressed', String(large));
    $('btnFont').textContent = large ? '文字 標準' : '文字 大';
  };
  $('btnFont').addEventListener('click', () => {
    large = !large;
    try {
      localStorage.setItem('pgg-font-large', large ? '1' : '0');
    } catch {
      /* ignore */
    }
    apply();
  });
  apply();
}

function setupWakeLock() {
  let lock = null;
  const req = async () => {
    try {
      if ('wakeLock' in navigator && !lock && document.visibilityState === 'visible' && app.net) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => {
          lock = null;
        });
      }
    } catch {
      /* ignore */
    }
  };
  document.addEventListener('click', req);
  document.addEventListener('visibilitychange', req);
}

function main() {
  setupFont();
  setupWakeLock();
  const room = normalizeRoom(params.get('room'));
  const known = room ? loadIdentity(room) : null;
  if (room && known) join(room, known.name);
  else render();
}

main();

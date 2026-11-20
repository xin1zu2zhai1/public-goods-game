# 公共財ゲーム（参加者用）

授業で行う「公共財ゲーム（Public Goods Game）」の、参加者（生徒）用の画面です。
教員が使うホスト画面は [public-goods-host](https://github.com/xin1zu2zhai1/public-goods-host) リポジトリにあります。

- 参加者画面：https://xin1zu2zhai1.github.io/public-goods-game/
- ホスト画面：https://xin1zu2zhai1.github.io/public-goods-host/

## 参加のしかた

1. 先生の画面に表示されたQRコードをスマホのカメラで読み取ります（またはこのページを開いて、6けたのルームコードを入力）。
2. ニックネームを入れて「参加する」を押します（空欄でも参加できます）。
3. ラウンドが始まったら、持っているお金のうち、グループの「共有財産」に出す金額を決めて送ります。
4. 全員がそろうと、結果（自分の利得の計算、グループのメンバーが出した額、これまでの推移）が表示されます。
5. 罰則ルールがあるラウンドでは、結果を見てほかのメンバーに罰を与えるかどうかを決めます。
6. ゲームが終わると、最終結果と振り返りの問いが表示されます。自分の記録はCSVで保存できます。

ゲーム中はこのページを開いたままにしてください。閉じてしまっても、同じ端末で同じQRコードから開き直せば続きから参加できます。
右上の「文字 大」で文字を大きくできます。

## 公開の準備（最初に1回だけ）

リポジトリの **Settings → Pages** で、Source を **Deploy from a branch**、Branch を **main** / **(root)** にして保存します。

## 開発者向け

```
index.html          参加者画面
css/player.css
js/app.js           画面
js/net-player.js    通信（PeerJS）。切れたら自動で再接続
js/config.js        PeerID の接頭辞・通信形式のバージョン
js/chart.js         グラフ（SVG）
vendor/peerjs.min.js  PeerJS 1.5.5（MIT ライセンス）
```

- `js/config.js` の `PEER_ID_PREFIX` と `PROTOCOL_VERSION` は、ホスト側リポジトリと同じ値にしてください。
- ゲームのルールと計算はすべてホスト側（`public-goods-host/js/game.js`）で行い、この画面は受け取った結果を表示します。

---
title: "LINE Webhook の「検証」が初回必ず失敗する理由とコールドスタート対策"
description: "LINE Messaging API の Webhook URL 検証が Cloud Run / Cloud Functions のコールドスタートに引っかかって毎回タイムアウトする。署名検証 (HMAC-SHA256) 込みの実装と、検証成功させるための実用的な回避策。"
publishDate: 2026-05-19
tags: [LINE, Webhook, Cloud Functions, コールドスタート]
series: "LINE ミニアプリ開発記"
seriesNo: 10
draft: false
---

LINE Messaging API の **Webhook URL 検証** ボタンを押して、初回だけ `Could not validate webhook` で失敗する、というのはあるあるです。再度押すと通る。これに 1 時間ほど悩んだあとで「あ、Cloud Run のコールドスタート時間と検証タイムアウトの戦争か」と気付いて、対策を入れました。

本記事は LINE Webhook の検証フローと、コールドスタート問題を回避するための現実的な手当を、署名検証 (HMAC-SHA256) のフルコードと一緒に書きます。

## 状況・前提

- Cloud Functions（**第 2 世代** = Cloud Run）
- ランタイム: Node.js 20
- リージョン: `us-central1`
- 関数の中身: 友だち追加 / メッセージ受信 / リッチメニュー誘導
- LINE 側: Messaging API の Webhook URL 検証

## なぜ初回失敗するのか

LINE 側の Webhook URL 検証は、**1〜2 秒程度のタイムアウト** で空 POST を送ってくる仕様です。一方、Cloud Functions（第 2 世代）の **コールドスタート** は、関数のサイズや依存にもよりますが **2〜3 秒** かかることがあります。

```
[1] LINE が検証 POST を送信
    └─ タイムアウト 1〜2 秒
       ↓
[2] Cloud Run コンテナがコールドスタート開始
    └─ 起動 + Node.js + 依存ロードで 2〜3 秒
       ↓
[3] 関数が応答する頃には LINE 側のタイムアウトが先に切れている
    └─ 検証失敗の表示
       ↓
[4] 2 回目の検証を押すと、コンテナが既に起動済み
    └─ レスポンスが速い
       ★ 検証成功
```

つまり、**コードに問題があるわけではない**、という事実に気付くまでが時間を食います。私もコード側のバグを延々疑って探したあとで、これが原因だと分かりました。

## Webhook ハンドラの実装

検証だけでなく実運用も視野に入れたコードです。`functions/src/lineWebhook.ts`:

```ts
import { onRequest } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import * as crypto from "crypto";

const LINE_CHANNEL_SECRET = defineSecret("LINE_CHANNEL_SECRET");
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");

export const lineWebhook = onRequest(
  {
    secrets: [LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN],
    minInstances: 1, // ★ コールドスタート対策
  },
  async (req, res) => {
    // [A] 検証用の空 POST はすぐ 200 で返す
    if (!req.body || !Array.isArray(req.body.events)) {
      res.status(200).send("OK");
      return;
    }

    // [B] 署名検証
    const signature = req.header("X-Line-Signature") || "";
    const bodyText = JSON.stringify(req.body);
    const expected = crypto
      .createHmac("sha256", LINE_CHANNEL_SECRET.value())
      .update(bodyText)
      .digest("base64");

    if (signature !== expected) {
      res.status(401).send("invalid signature");
      return;
    }

    // [C] イベントごとの処理
    for (const event of req.body.events) {
      if (event.type === "follow") {
        await replyFollowGreeting(event.replyToken);
      } else if (event.type === "message" && event.message?.type === "text") {
        await replyMessage(event.replyToken, event.message.text);
      }
    }

    res.status(200).send("OK");
  }
);

async function replyFollowGreeting(replyToken: string) {
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN.value()}`,
    },
    body: JSON.stringify({
      replyToken,
      messages: [{ type: "text", text: "友だち追加ありがとうございます。" }],
    }),
  });
}

async function replyMessage(replyToken: string, _text: string) {
  // ...省略
}
```

3 つのポイントを順に解説します。

### [A] 検証用の空 POST に対応

LINE の Webhook URL 検証は `events` が空の POST を投げてきます。`req.body.events` が配列でなかったり長さ 0 のときは、署名検証も処理もスキップして即 200 を返します。これがないと、検証時の挙動が後段の処理に依存して不安定になります。

### [B] 署名検証 (HMAC-SHA256)

LINE は `X-Line-Signature` ヘッダーに、リクエストボディを `LINE_CHANNEL_SECRET` で **HMAC-SHA256** したものを Base64 で乗せてきます。サーバー側で同じ計算をして一致を確認します。一致しなければ 401。

注意点: **計算対象は受信した生 body** です。`req.body` を JSON 化したテキストと一致するためには、Express / Functions のミドルウェアが body を再シリアライズしないことが前提。Cloud Functions v2 の `onRequest` ではデフォルト挙動で動きました。

### [C] `minInstances: 1` でコールドスタート回避

`minInstances: 1` を指定すると、**最低 1 つのインスタンスが常時待機** されます。これが今回のコールドスタート問題の本命の解決策です。

ただし、**インスタンスを 1 つ常駐させると、Cloud Run の従量課金が発生** します。Webhook 用の関数は呼び出し頻度が低いため、`minInstances: 0`（デフォルト）でも実害は少ないことが多いですが、検証通過の確実性を優先するなら 1 にしておくのが楽です。

## 解決手順

### Step 1: 署名検証を含む関数をデプロイ

```bash
cd functions
npm run build
firebase deploy --only functions:lineWebhook
```

デプロイ完了時に出る Cloud Run の URL を控えます。

### Step 2: LINE 側の Webhook URL を設定

LINE Developers Console → Messaging API チャネル → 「Webhook URL」に上記 URL を入れて「更新」→「検証」ボタン。

ここで **1 回目に失敗しても、2〜3 秒待ってから再度押す** と通ります。`minInstances: 1` を設定していれば 1 回で通ります。

### Step 3: 「Webhook の利用」を ON

検証ボタンの下にある **「Webhook の利用」を ON** にしないと、本番で Webhook が届きません。検証が通っただけで満足して忘れがちです。

## コールドスタートの代替策

`minInstances: 1` 以外にも次の手があります。

| 手段 | 効き具合 | コスト |
|---|---|---|
| `minInstances: 1` | ★★★ 確実 | Cloud Run の常時課金（個人開発でも数百円〜/月） |
| 関数を軽くする（依存削減・bundle 最小化） | ★★ コールドスタートが 1 秒台に | コードを書く工数 |
| 検証時だけ事前に手動で 1 度関数を叩いて温める | ★ 検証時のみ有効 | 手間 |
| 第 1 世代 Functions に戻す | ★★ 第 1 世代のほうが起動速い場合あり | 機能制約あり |

私は最初 `minInstances: 0` で運用して検証時だけ手動で叩く運用にしていましたが、半年運用してみて月数十円程度のコストなら **`minInstances: 1` で常時温めておくほうが運用が楽** という結論になりました。

## 学び・余談

「Webhook 検証が通らない」と「Webhook の中身が動かない」は、原因の階層が全然違います。コールドスタート問題はコードの問題ではないので、コード側を疑い続けるとずっと解けません。**「2 回目に押すと通る = タイミング問題」という直感** を持っておくと、似た症状で次に詰まったときに早く抜けられます。

`minInstances: 1` の良いところは「Webhook を設定する平和な日常」を取り戻せることです。検証ボタンを押すたびに祈らなくてよい、というのは想像以上に体験が改善します。

## 関連記事

- [#11 LINE Developers Console の「LINE ログインチャネル」と「Messaging API チャネル」を取り違えた末路](/blog/11-line-channel-mixup/)
- [#8 Cloud Functions のサービスアカウント権限地獄を脱出するまで](/blog/08-cloud-functions-iam-roles/)

## 参考

- [LINE 公式: Webhook を実装する](https://developers.line.biz/ja/docs/messaging-api/receiving-messages/)
- [LINE 公式: 署名を検証する](https://developers.line.biz/ja/docs/messaging-api/receiving-messages/#signature-validation)
- [Firebase 公式: 第 2 世代 Functions のコールドスタートを最小化する](https://firebase.google.com/docs/functions/manage-functions?hl=ja#min-instances)

---


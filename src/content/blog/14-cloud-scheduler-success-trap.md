---
title: "Cloud Scheduler が「成功」と言うのに通知が届かない時に確認すべき 3 つのこと"
description: "Cloud Scheduler の HTTP 200 = 成功表示に騙されて通知未達に気付けない罠。Cloud Logging Explorer の使い方、firebase functions:log のラグ、Push 失敗時のサーバー側自己通知まで含めて切り分け方を解説。"
publishDate: 2026-05-22
tags: [Cloud Scheduler, Cloud Functions, GCP, ログ調査]
series: "LINE ミニアプリ開発記"
seriesNo: 14
draft: false
---

Cloud Scheduler の管理画面で「成功」と表示されているのに、利用者の LINE には何も届いていない。最初に見たときは、これは Cloud Scheduler のバグなんじゃないか、と一瞬思いました。違いました。**Cloud Scheduler の「成功」は、HTTP 200 が返った、というだけの意味** で、関数の中身が動いたかどうかは見ていません。

本記事はこの罠の正体と、通知未達を切り分けるときに確認する 3 つの場所を、ログコマンド込みでまとめます。「成功」表示を信用しないで済むようになるのが終端目標です。

## 状況・前提

- Cloud Scheduler → Cloud Functions（第 2 世代）→ LINE Messaging API Push という構成
- cron スケジュール: 毎朝 09:00 JST
- 症状: ジョブ詳細では「成功」表示なのに、自分の LINE に通知が届かない

## 詰まったポイント

### Cloud Scheduler の「成功」は誤解を招く表現

Cloud Scheduler のジョブ実行履歴には、各実行に **「成功 / 失敗」** が表示されます。私はこれを「関数が最後まで実行できたかどうか」だと長らく勘違いしていました。実際には次の違いです。

```
Cloud Scheduler の「成功」= ターゲット URL が HTTP 200 を返した
   └─ 関数の中身がエラーで落ちていても、catch して 200 を返したら「成功」
   └─ Push が 1 通も飛んでいなくても、関数自体が 200 で終わったら「成功」

Cloud Scheduler の「失敗」= HTTP 5xx が返った / リトライ上限超過 / タイムアウト
   └─ ここはまっとうに「失敗」
```

つまり、関数の中で `try/catch` で握りつぶしてレスポンスを 200 にしている部分があれば、Cloud Scheduler から見ると永遠に「成功」になり続けます。

私のケースでは、対象ユーザーへの Push 失敗を「次のユーザーの処理を続けるため」に try/catch で握っていて、さらにその catch で `console.error` だけ呼んで終わっていました。Cloud Scheduler は満面の笑みで「成功」と言い続けていた、というわけです。

## 切り分け: 確認すべき 3 つの場所

### 1. Cloud Logging Explorer

Cloud Scheduler の「成功」を信用せず、まず Cloud Logging Explorer で **関数本体のログ** を見ます。GCP コンソール → ロギング → ログエクスプローラ。

クエリの例（**第 2 世代 Functions = Cloud Run functions** の場合）:

```
resource.type="cloud_run_revision"
resource.labels.service_name="senddailyreminders"
severity>=ERROR
```

第 2 世代 Functions（2024 年 8 月以降は Cloud Run functions に改称）は **`cloud_run_revision`** で取得します。第 1 世代を使っている場合は **`cloud_function`** に変えてください。`resource.type` を間違えると 1 件もヒットしないので、最初の切り分けでここを疑うのは有効です。

ここで `console.error` の出力や未捕捉エラーが見えます。`severity>=DEFAULT` にすれば `console.log` も含めて全部出ます。これが一番情報量が多いです。

クエリ言語のポイントは:
- `resource.type` `logName` `severity` `timestamp` は **インデックスされている** ので最初に書くと検索が速い
- 部分一致は `=~` の正規表現より、`textPayload : "timeout"` のような **`:` 演算子** のほうが速い
- 結果が多すぎるときは `sample(insertId, 0.1)` で 10% サンプリングできる

### 2. `firebase functions:log` の挙動と限界

CLI でも見れます。

```bash
firebase functions:log --only sendDailyReminders --lines 200
```

ただしこのコマンドは内部で Cloud Logging を叩いているので、**Cloud Logging の取り込み遅延** がそのまま反映されます。体感では **数秒〜十数秒** 程度のことが多く、関数が並列実行されているとログが順番通りに表示されない（インターリーブ）こともあります。私は最初これに気付かず、「ログが空だ → 関数が動いてない → 焦る」を繰り返しました。

```
[1] ジョブ実行 09:00:00
    ↓ 数秒〜十数秒
[2] firebase functions:log で見えるようになる
    └─ ただし複数インスタンスのログが入り混じる
[3] Cloud Logging Explorer は live tail で ほぼリアルタイム表示が可能
    ★ 緊急時は Logging Explorer の live tail のほうが向いている
```

短いタイムスパンで切り分けるなら、Cloud Logging Explorer の **ライブテール機能** を使うのがおすすめです。`firebase functions:log` は事後の確認用、開発中の即時確認は Firebase Emulator のローカルログ、と使い分けると無駄な「ログ待ち」がなくなります。

### 3. 自己通知（Push 失敗を運営側にも飛ばす）

ログを開かなくても気付ける仕組みも必要です。私が入れているのは **Push 失敗を運営の LINE 側にも飛ばす** 仕組みです。`reportError` という別の Cloud Function を用意して、関数のなかから例外時にそこを叩きます。

```ts
async function pushTo(lineUserId: string, text: string) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", { /* ... */ });
  if (!res.ok) {
    // Push 失敗を運営自身の LINE に通知
    await fetch(REPORT_ERROR_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: `Push failed: ${res.status} for ${lineUserId}`,
      }),
    });
  }
}
```

`reportError` 側は **管理者の LINE userId**（`U` で始まる 33 文字）を別 Secret に持たせて、そこへ Push します。これがあると、利用者からのフィードバックを待たずに「あ、今朝のリマインダー失敗してる」と運営が気付けます。

## 解決手順: 切り分けの順序

実際に通知未達に遭遇したときの動き方:

```
[1] Cloud Logging Explorer を開く
    └─ severity>=ERROR で関数のエラーを確認
       ├─ エラーがある → 中身を読む（PERMISSION_DENIED / fetch failed / 等）
       └─ エラーなし → [2] へ
          ↓
[2] severity>=DEFAULT で console.log を確認
    └─ 「N 件対象 / N 件 push 成功」のような自前ログを仕込んでおく
       ├─ 対象 0 件 → クエリ条件のミス（複合インデックス未デプロイ等）
       └─ Push 失敗 → [3] へ
          ↓
[3] LINE Messaging API のレスポンスを確認
    └─ 401 / 403 → アクセストークン / シークレット切れ
    └─ 429 → レート制限・同時実行・月次上限のいずれか
    └─ 400 → リクエスト構造の不正（メッセージ形式・to の値）
       ★ 各ケースに合わせて修正
```

LINE Messaging API の **429 は実は 3 種類** あります。レスポンスボディの `description` で見分けます。

| 種類 | description の典型 | 復帰方法 |
|---|---|---|
| 月次上限超過 | `You have reached your monthly limit.` | **翌月 1 日の自動リセット** または プランアップグレード |
| レート制限超過 | `Exceeded the rate limit for requests` | 少し待ってから再試行（指数バックオフ） |
| 同時実行制限超過 | （ナローキャストなど）一時的に発生 | 少し待ってから再試行 |

「同じ 429 だから同じ対処」ではないので、`description` を必ずログに残します。さらに LINE は **Retry Key**（UUID 形式の任意ヘッダ）でべき等な再試行をサポートしているので、再送時の二重 Push を避けたければ Retry Key を仕込んでおくのが堅いです。

## ログを仕込んでおくべき場所

将来の自分のために、関数のなかには **自前のサマリログ** を仕込んでおきます。

```ts
console.log(JSON.stringify({
  event: "sendDailyReminders.summary",
  targetCount: snapshot.size,
  groupedUsers: grouped.size,
  pushSuccess,
  pushFailed,
}));
```

これがあると Logging Explorer のクエリで **`jsonPayload.event="sendDailyReminders.summary"`** だけ抽出して、毎日の運用状況を一覧できます。問題があった日の異常も発見しやすい。

## 学び・余談

「成功」「失敗」の語感を疑う、というのが今回の本当の教訓でした。プラットフォームが言う「成功」は **そのプラットフォームの責任範囲内での成功** であって、ビジネスロジック上の成功とは別物。Cloud Scheduler は HTTP 200 を返す相手と話せたら成功で、その内部で何が起きていようが関心がない。当たり前と言えば当たり前なのですが、**通知未達のような「届くべきものが届かない」種類の事故** は、表面上の「成功」に化けやすいので特に警戒します。

自己通知の仕組みは、入れた直後はやり過ぎに感じましたが、結局 1 回でも本番事故を未然に拾えれば元が取れる、という性質のものでした。個人開発で運営側の通知チャネルを 1 本確保しておくことを、強くおすすめします。

## 関連記事

- [#12 LINE 公式アカウントで日次リマインダー Push を実装する](/blog/12-daily-reminder-push/)
- [#8 Cloud Functions のサービスアカウント権限地獄を脱出するまで](/blog/08-cloud-functions-iam-roles/)

## 参考

- [GCP 公式: Cloud Logging Explorer](https://cloud.google.com/logging/docs/view/logs-explorer-interface)
- [GCP 公式: Logging クエリ言語](https://cloud.google.com/logging/docs/view/logging-query-language)
- [Firebase 公式: Cloud Functions のログ](https://firebase.google.com/docs/functions/writing-and-viewing-logs?hl=ja)
- [LINE 公式: Messaging API 開発ガイドライン（レート制限・429）](https://developers.line.biz/ja/docs/messaging-api/development-guidelines/)

---


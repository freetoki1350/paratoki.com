---
title: "LINE 公式アカウントで日次リマインダー Push を実装する — Cloud Functions cron + 月 200 通制限への対策"
description: "Cloud Scheduler から Cloud Functions の cron を呼び出し、Firestore collectionGroup で対象を抽出して LINE Messaging API で Push を投げる実装。1 ヶ月前 / 1 週間前 / 前日の多段階通知を、ユーザー単位グルーピングで月 200 通枠に収める設計。"
publishDate: 2026-05-20
tags: [LINE, Messaging API, Cloud Functions, Cloud Scheduler]
series: "LINE ミニアプリ開発記"
seriesNo: 12
draft: false
---

LINE 公式アカウントで「日次でリマインダーを送る」機能は、個人開発でも需要が高いわりに、**月 200 通の Push 上限** が地味に効く制約です。素朴に「該当レコード 1 件 = Push 1 通」で書くと、ユーザー数が伸びた瞬間に超過します。

本記事は Cloud Functions の cron で Firestore を集計し、**ユーザー単位で 1 通に集約** して Push する実装の全体像をまとめます。多段階通知（1 ヶ月前 / 1 週間前 / 前日）も同じ仕組みに乗せて、月 200 通の枠に押し込む設計です。

## 状況・前提

- Cloud Functions（第 2 世代）+ Cloud Scheduler の組み合わせ
- Firestore は階層型（`users/{uid}/children/{cid}/records/{rid}`）
- Push 先: LINE Messaging API
- 通知タイミング: 予定日の **1 ヶ月前 / 1 週間前 / 前日**
- 対象規模: 数百ユーザー（無料枠の 200 通で運用したい）

## 全体図

```
Cloud Scheduler（毎朝 09:00 JST）
    │
    │ ① cron トリガー
    ▼
Cloud Functions: sendDailyReminders
    │
    │ ② Firestore collectionGroup で
    │    "scheduledDate が 1ヶ月後 / 1週間後 / 明日 のいずれか"
    │    かつ "completedDate が null" を抽出
    ▼
ユーザー単位でグルーピング
    │
    │ ③ uid ごとに「対象レコード一覧」を作る
    ▼
ユーザーごとに Push を 1 通ずつ
    │
    │ ④ uid → "line:Uxxxx" の prefix を取って LINE userId に
    │    Messaging API push に投げる
    ▼
利用者の LINE に通知
```

ポイントは **③ のグルーピング**。ここを抜くと「1 ユーザーに 1 日 3 通」みたいなことが起こります。

## Cloud Functions 側の実装

`functions/src/sendDailyReminders.ts` の主要部:

```ts
import { onSchedule } from "firebase-functions/v2/scheduler";
import { defineSecret } from "firebase-functions/params";
import { getFirestore } from "firebase-admin/firestore";
import { initializeApp } from "firebase-admin/app";

initializeApp();
const LINE_CHANNEL_ACCESS_TOKEN = defineSecret("LINE_CHANNEL_ACCESS_TOKEN");

export const sendDailyReminders = onSchedule(
  {
    schedule: "every day 09:00",
    timeZone: "Asia/Tokyo",
    secrets: [LINE_CHANNEL_ACCESS_TOKEN],
    region: "asia-northeast1",
  },
  async () => {
    const today = jstDate();
    const targets = {
      monthAhead: addDaysJst(today, 30),
      weekAhead: addDaysJst(today, 7),
      tomorrow: addDaysJst(today, 1),
    };

    // [A] 対象レコードを 1 度の collectionGroup クエリで取り切る
    const snapshot = await getFirestore()
      .collectionGroup("records")
      .where("completedDate", "==", null)
      .where("scheduledDate", "in", Object.values(targets))
      .get();

    // [B] uid 単位にグルーピング
    const grouped = new Map<string, Array<{ tip: string; record: any }>>();
    for (const doc of snapshot.docs) {
      const uid = uidFromPath(doc.ref.path); // "users/{uid}/children/.../records/..." から uid を取り出す
      if (!uid.startsWith("line:")) continue;

      const data = doc.data();
      const tip = tipBy(data.scheduledDate, targets);
      if (!grouped.has(uid)) grouped.set(uid, []);
      grouped.get(uid)!.push({ tip, record: data });
    }

    // [C] ユーザーごとに Push 1 通
    for (const [uid, items] of grouped.entries()) {
      const lineUserId = uid.slice("line:".length);
      const text = buildText(items);
      await pushTo(lineUserId, text);
    }
  }
);

function tipBy(scheduledDate: string, t: { monthAhead: string; weekAhead: string; tomorrow: string }) {
  if (scheduledDate === t.tomorrow) return "明日が予定日です";
  if (scheduledDate === t.weekAhead) return "1 週間後が予定日です";
  if (scheduledDate === t.monthAhead) return "1 ヶ月後が予定日です";
  return "";
}

function buildText(items: Array<{ tip: string; record: any }>) {
  if (items.length === 1) {
    return `${items[0].tip}: ${items[0].record.name}`;
  }
  const lines = items.map((i) => `・${i.tip}: ${i.record.name}`);
  return `本日のお知らせ\n${lines.join("\n")}`;
}

async function pushTo(lineUserId: string, text: string) {
  await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN.value()}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [{ type: "text", text }],
    }),
  });
}
```

### [A] collectionGroup で「1 度に取り切る」

ユーザーごとに 1 件ずつクエリすると、Firestore の読み取り回数が膨れます。`collectionGroup("records")` で全ユーザーを横断し、**`scheduledDate in [...]` の 1 クエリ** に圧縮するのが基本。`completedDate == null` の条件と組み合わせるため、複合インデックスが必要です。

`firestore.indexes.json` に書いておきます。

```json
{
  "indexes": [
    {
      "collectionGroup": "records",
      "queryScope": "COLLECTION_GROUP",
      "fields": [
        { "fieldPath": "scheduledDate", "order": "ASCENDING" },
        { "fieldPath": "completedDate", "order": "ASCENDING" }
      ]
    }
  ]
}
```

### [B] uid 単位にグルーピング

ドキュメントパス `users/{uid}/children/{cid}/records/{rid}` から uid を取り出します。階層設計の素直なメリットで、パスを切るだけで所有者が分かります。

```ts
function uidFromPath(path: string): string {
  const segments = path.split("/");
  return segments[1] ?? "";
}
```

### [C] ユーザーごとに Push 1 通

`buildText` で対象 1 件なら短文、複数件なら箇条書きにします。これで Push 数 = アクティブユーザー数の上限に圧縮できます。

## Push 数の見積もり

ユーザー数 N、各ユーザーが対象に該当する確率 p としたとき、1 日の Push 数の期待値はおおよそ **N × p**。月の上限が 200 通なので、**N × p × 30 ≤ 200**、つまり **N × p ≤ 6.67/日** までが無料枠です。

p は機能の性質次第で、私のケースでは「3 種類の通知タイミングのいずれかに該当する確率」を 5% 程度と見積もっています。

```
N = 100 人、p = 5% の場合
  → 1 日の Push = 5 通
  → 30 日で 150 通
  → 月 200 通の無料枠内 ✅

N = 500 人、p = 5% の場合
  → 1 日の Push = 25 通
  → 30 日で 750 通
  → 上限超過 ❌
```

500 ユーザーを越えるあたりで有料プランへの切り替えを判断するライン、というのが私のメンタルモデルです。

## 「Cloud Scheduler は成功と言うのに通知が届かない」問題

cron の動作確認は別記事 #14 で扱いますが、ここでも軽く触れます。Cloud Scheduler のジョブ詳細画面で「成功」と表示されていても、それは **HTTP 200 が返った** という意味です。Function の中で fetch エラーが起きて `console.error` だけで止まっていても、外側からは成功扱い。

対策: **Push 失敗時はサーバー側のエラーチャンネル（Slack / メール / 別 LINE）にも通知** する仕組みを 1 行入れておきます。これがないと「届かない」のに気付くのが利用者からの問い合わせ後になります。

## 学び・余談

cron + Push の機能は、コードの行数は短いのに **設計の選択肢が多い** やつでした。1 件ずつ送る / ユーザー単位で集約する / 通知タイミングを別 Function に分ける、いずれの選択も実装は通せる。なかでも「**ユーザー単位で 1 通に集約**」を最初から選んでおくと、後から無料枠に対応するためにコードを書き直す量が一番少なく済みます。

公開前にもうひとつ準備しておきたいのは、「Push 失敗時に運営側に通知を回すフロー」です。届かない症状を利用者に教えてもらってから動くのは、個人開発で一番怖いパターンです。

## 関連記事

- [#14 Cloud Scheduler が「成功」と言うのに通知が届かない時に確認すべき 3 つのこと](/blog/14-cloud-scheduler-success-trap/)
- [#5 Firestore 複合インデックスを忘れて「すべて完了しました」と誤表示された話](/blog/05-firestore-composite-index/)
- [#10 LINE Webhook の「検証」が初回必ず失敗する理由とコールドスタート対策](/blog/10-line-webhook-cold-start/)

## 参考

- [Firebase 公式: スケジュールされた Functions](https://firebase.google.com/docs/functions/schedule-functions?hl=ja)
- [LINE 公式: メッセージを送信する（Push）](https://developers.line.biz/ja/reference/messaging-api/#send-push-message)

---


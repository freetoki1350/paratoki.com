---
title: "LINE LIFF + Firebase + Vercel で月額 0 円運用するためのアーキテクチャ全体図"
description: "個人開発の LINE ミニアプリを月額 0 円で運用するために組んだ構成図。各サービスの無料枠を最大限使う設計と、LINE Push 月 200 通制限への現実的な回避策。"
publishDate: 2026-05-14
tags: [アーキテクチャ, LIFF, Firebase, Vercel, LINE, 個人開発]
series: "LINE ミニアプリ開発記"
seriesNo: 2
draft: false
---

個人開発で「クラウドに月いくら払うか」は、続けるか潰すかを左右する地味に重い変数です。固定費がゼロなら、PV が伸びなくても放置できる。月数千円かかっていると、忙しいときに止めたくなる。今回作った LINE ミニアプリは **月額 0 円で年単位の運用を回す** ことを最初の制約として置きました。

本記事はそのときに組んだ構成図と、各サービスの無料枠を使い切る設計、そして LINE Push の月 200 通制限という個人開発の壁をどう避けたかをまとめます。同じ規模感の個人開発をしている人に、構成のたたき台として読んでもらえる形を目指します。

## 状況・前提

- 開発者: 個人 1 人
- ターゲット規模: 公開初期は数十〜数百人、半年で数千人を想定
- リマインダー: 利用者ごとに日次で 1 通前後の Push（最大）
- データ量: ユーザー 1 人あたり数十 KB（テキスト中心）
- 公開前提: AdSense 審査を通すためにトップドメインに技術ブログを併設（後述の Vercel 規約上の制約により、ブログは別ホスティングに分離）

## 全体図

```
LINE アプリ（ユーザー端末）
   │
   │ ① 公式アカウント友だち追加 → リッチメニューから LIFF 起動
   ▼
LIFF アプリ（Next.js 15 App Router + LIFF SDK）
  Hosted on Vercel Hobby  https://app.既存ドメイン.xxx
  ※ 広告は貼らない。商用利用判定を避ける
   │
   │ ② liff.getIDToken()
   ▼
Cloud Run functions: verifyLineIdToken (HTTPS、旧 第 2 世代 Functions)
   │ ③ LINE Verify API で検証 → Firebase Custom Token 発行
   ▼
Firebase Auth (uid = "line:Uxxxx" 形式)
   │
   │ ④ Firestore SDK でクライアントから直接アクセス
   ▼
Firestore
  └─ users/{uid}/...

Cloud Scheduler → Cloud Run functions: sendDailyReminders (cron)
   ⑤ collectionGroup で対象抽出
   ⑥ uid → LINE userId へ復号 → Messaging API push

Cloud Run functions: lineWebhook (HTTPS)
   ⑦ 公式アカウントの follow / message を受信
   ⑧ あいさつ・LIFF 誘導を返信


[別ホスト: 技術ブログ]
トップドメイン  https://既存ドメイン.xxx
  Hosted on Cloudflare Pages（または GitHub Pages）
   │
   │ Astro で静的配信
   │ AdSense バナー設置
   ▼
広告収入 → 連載記事の SEO で集客
```

LIFF 本体 (Vercel) と技術ブログ (Cloudflare Pages 等) を **別のホスティングサービスに分離** しているのがポイントです。理由は次節の通り、Vercel の規約上の制約を避けるためです。

各層が独立した無料枠を持っていて、ほとんどの個人開発は無料枠の合計内で収まる、というのがこの構成のキモです。

## 月額 0 円のための無料枠戦略

| 層 | サービス | 無料枠 | 個人開発で枠を使い切る目安 |
|---|---|---|---|
| LIFF 本体配信 | Vercel Hobby | 帯域 100GB / 月、Function 呼び出し 100 万回 / 月 など | 数千 DAU まで |
| ブログ + 広告配信 | Cloudflare Pages | 帯域・リクエスト無制限、ビルド 500 回 / 月 | まず溢れない |
| 認証 | Firebase Auth | 無料 | 月 50,000 アクティブユーザー |
| DB | Firestore | 1 日 50K 読み取り / 20K 書き込み / 1GiB ストレージ | 数千 DAU 程度 |
| サーバー | Cloud Run functions（旧 第 2 世代 Functions） | 月 200 万リクエスト + 180,000 vCPU-秒 + 360,000 GiB-秒 | Webhook と cron だけならまず溢れない |
| 通知 | LINE Messaging API（コミュニケーションプラン） | **月 200 通** | 後述、ここがボトルネック |
| ドメイン | お名前.com 既取得 | 既に支払い済み（年単位） | サブドメインは無料 |
| 広告 | Google AdSense | 設置無料、収益化のみ | **トップドメインのブログに貼る** |

**ボトルネックは LINE Messaging API の月 200 通だけ**、というのがこの構成の特徴です。Firestore も Cloud Run functions も、個人開発の規模では無料枠を埋めるほうが難しい。

## なぜ LIFF とブログを別ホストに分けるか

ここが一番の落とし穴で、Vercel の Fair Use Guidelines は **「広告掲載を含むデプロイは商用利用」** と明示しています。AdSense を貼ったページを Vercel Hobby で配信すると、規約違反扱いになる可能性が高いです。

> The inclusion of advertisements, including but not limited to online advertising platforms like Google AdSense.
> ─ Vercel Fair Use Guidelines

回避策として 3 つの選択肢があります。

| 案 | 概要 | コスト |
|---|---|---|
| A. 全部 Pro に上げる | LIFF もブログも Vercel Pro に統一 | 月 $20 |
| B. ブログを別の無料ホスティングに分離 | LIFF: Vercel Hobby（広告なし）／ブログ: Cloudflare Pages 等 | 0 円 |
| C. Vercel をやめる | 全部 Cloudflare Pages や Netlify に乗せる | 0 円、ただし移行作業 |

私は **案 B** を採っています。LIFF 本体は Vercel の体験が良いのでそのまま、AdSense を貼るブログだけ Cloudflare Pages に逃がす、という二段構え。

LIFF 本体側は **広告を一切貼らない** 前提で、Hobby プランでの運用を続けています。ただし「収益化を目指している全体プロジェクトの一部」と判断されると Pro 必須になる解釈もあり、ここは規約の解釈次第のグレーゾーンです。心配なら Vercel サポートに直接問い合わせるのが確実、というのが個人開発で取れる一番堅い動き方かもしれません。

## LINE Push 月 200 通制限とどう向き合うか

「リマインダーが本機能なのに 200 通しか送れない」は致命傷に見えます。私が取った対策は次の通りです。

### 1. 通知をユーザーごとに集約する

ナイーブな実装だと「対象レコード 1 件 = Push 1 通」になりますが、これだと利用者が増えた瞬間に 200 通を越えます。同一ユーザーの該当レコードを **1 通のメッセージに集約** すれば、通数 = アクティブユーザー数まで圧縮できます。

```ts
// 悪い例: レコードごとに送る
for (const record of upcomingRecords) {
  await pushTo(record.userId, render(record));
}

// 良い例: ユーザー単位で集約
const grouped = groupBy(upcomingRecords, "userId");
for (const [userId, records] of Object.entries(grouped)) {
  await pushTo(userId, renderDigest(records));
}
```

### 2. 多段階通知にして「1 ヶ月前 / 1 週間前 / 前日」を 1 通にまとめる

予定日の 1 ヶ月前・1 週間前・前日にそれぞれ Push を投げる構造にしていますが、運悪く同じ日にこの 3 段階が重なるユーザーがいた場合は、それも 1 通にまとめます。これでユーザー × 日付の総当たりになり、Push 数の見積もりが立てやすい。

### 3. それでも不足したら有料枠

Messaging API の有料プランに切り替えると 1,000 通から段階的に増やせます。0 円運用は崩れますが、利用者数が広告収益でカバーできる規模になっていれば気にする必要は少ないはずです。

## 設計上の小ネタ

### Firebase Auth の uid を `"line:Uxxxx"` 形式にする

LINE userId（`U` で始まる 33 文字）はそのまま `auth.uid` に使えますが、私はプレフィックスを付けて `line:Uxxxx` にしました。理由は将来別の認証手段（Twitter / メール）を追加したときに **「どの認証由来の uid か」が一目で分かる** ようにしておくためです。Push のときは prefix を取るだけで LINE userId に戻せます。

### Firestore は階層型

`users/{uid}/children/{cid}/records/{rid}` のように階層で持つと、セキュリティルールが `match /users/{uid}` の入口で uid 一致を確認するだけで配下を全部守れます。フラット構造にすると各コレクションでルールを書き分ける必要があり、個人開発では事故りやすい。

### 日付は文字列 `YYYY-MM-DD` で持つ

Firestore の `Timestamp` 型はタイムゾーンの罠が多いので、「カレンダー上の日」は素直に文字列にしました。並び替えも文字列比較で動きます。これは別記事で深掘り予定。

## 学び・余談

無料枠で組み切るのは、技術的にはそれほど難しくありません。難しいのは **「無料枠を越えそうなときに何を選ぶか」を先に決めておく** ことです。LINE Push が一番先に詰まる、と分かっていれば、コードの書き方も「集約優先」に自然と寄ります。逆に「全部無料で行こう」と漠然と始めると、後でアーキテクチャを書き直す羽目になります。

連載の次回からは、この図のなかの細部（認証フロー、Firestore 階層、cron Push の中身）に踏み込んでいきます。

## 関連記事

- [#1 LINE で動くミニアプリを個人開発した記録 — 構想・収益モデル・技術スタック選定の裏側](/blog/01-line-mini-app-concept/)
- #3 LINE LIFF の ID トークンを Firebase Custom Token に変換する認証フロー実装（後日掲載）
- #4 Firestore の階層設計でセキュリティルールを劇的にシンプルにする方法（後日掲載）
- #12 LINE 公式アカウントで日次リマインダー Push を実装する（後日掲載）

---


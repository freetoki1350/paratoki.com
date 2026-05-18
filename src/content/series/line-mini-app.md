---
title: "連載: LINE ミニアプリ開発記"
description: "個人開発で LIFF + Firebase + Vercel + Cloud Run functions を組み合わせて、月額 0 円で動く LINE ミニアプリを公開した記録。構想から運用まで全 15 本。"
publishDate: 2026-05-18
updatedDate: 2026-05-18
---

個人開発で LINE ミニアプリ（LIFF）を公開した記録を、構想 → 技術選定 → 実装 → ハマり → デプロイ → 運用 → 振り返り の流れで全 15 本に整理した連載です。スタックは **Next.js 15 / Firebase / Vercel / Cloud Run functions / LINE Messaging API**。月額 0 円運用を制約として、無料枠の境界・規約のグレーゾーン・実装の落とし穴を、すべて自分の手で踏んだ範囲で書いています。

各記事は独立して読めますが、シリーズで読むと **個人開発で LINE ミニアプリを公開するまでに踏むべき意思決定の地図** になるよう設計しています。

---

## 🎁 連載で開発しているアプリを使ってみる

連載で扱っている **「チックンノート」** は、お子さまの予防接種スケジュールを LINE で管理できる無料サービスとして実際に公開・運用しています。LINE で友だち追加するだけで、すぐ使えます。

→ [**LINE で友だち追加してチックンノートを使う**](https://lin.ee/VWlYYzF)

子育て世代の方は実際の使い心地を、エンジニアの方は連載で取り上げているアーキテクチャがどう動いているかを確認できます。

---

## Phase 1: 導入・基盤

連載の入口。プロダクトの構想、月額 0 円運用のためのアーキテクチャ、独自ドメイン接続、そして法務まわり。

- [#1 LINE で動くミニアプリを個人開発した記録 — 構想・収益モデル・技術スタック選定の裏側](/blog/01-line-mini-app-concept/)
- [#2 LINE LIFF + Firebase + Vercel で月額 0 円運用するためのアーキテクチャ全体図](/blog/02-architecture-overview/)
- [#13 お名前.com で取得したドメインを Vercel に CNAME 接続する完全手順（2026 年版）](/blog/13-onamae-vercel-custom-domain/)
- [#15 個人開発で医療系アプリのプライバシーポリシー・利用規約を書くときの最低ライン](/blog/15-privacy-policy-terms/)

## Phase 2: 実装系 SEO（ハマり保存版）

検索流入を狙えるエラー解決系。env 系・IAM・チャネル取り違えなど、踏んだら半日溶ける罠の保存版。

- [#6 Next.js で process.env[varName] が undefined になる罠 — 静的置換の仕組みと対策](/blog/06-nextjs-process-env-dynamic/)
- [#7 Vercel デプロイで半日溶かした 4 つの罠 — Sensitive、ビルドキャッシュ、env スコープ、空文字フォールバック](/blog/07-vercel-deploy-traps/)
- [#8 Cloud Functions のサービスアカウント権限地獄を脱出するまで — 7 つの IAM ロールの正体](/blog/08-cloud-functions-iam-roles/)
- [#11 LINE Developers Console の「LINE ログインチャネル」と「Messaging API チャネル」を取り違えた末路](/blog/11-line-channel-mixup/)

## Phase 3: 認証・データ・配信の中身

LIFF → Firebase Auth ブリッジ、Firestore 階層設計、Webhook、cron Push の実装。

- [#3 LINE LIFF の ID トークンを Firebase Custom Token に変換する認証フロー実装](/blog/03-liff-firebase-custom-token/)
- [#4 Firestore の階層設計でセキュリティルールを劇的にシンプルにする方法](/blog/04-firestore-hierarchy/)
- [#5 Firestore 複合インデックスを忘れて「すべて完了しました」と誤表示された話](/blog/05-firestore-composite-index/)
- [#10 LINE Webhook の「検証」が初回必ず失敗する理由とコールドスタート対策](/blog/10-line-webhook-cold-start/)
- [#12 LINE 公式アカウントで日次リマインダー Push を実装する — Cloud Functions cron + 月 200 通制限への対策](/blog/12-daily-reminder-push/)

## Phase 4: 運用・観測

運用フェーズで気付いたエラーハンドリングとログ調査の落とし穴。

- [#9 AuthGate のエラーが握りつぶされて画面が無限ローディングになっていた話](/blog/09-authgate-swallowed-error/)
- [#14 Cloud Scheduler が「成功」と言うのに通知が届かない時に確認すべき 3 つのこと](/blog/14-cloud-scheduler-success-trap/)

---

## 連載全体の前提

| 項目 | 値 |
|---|---|
| アプリ形態 | LINE LIFF + 公式アカウント Bot |
| フロントエンド | Next.js 15.5（App Router） |
| LIFF 配信 | Vercel Hobby（広告なし） |
| ブログ配信 | Cloudflare Pages（AdSense 設置予定） |
| 認証 | Firebase Auth（LINE Custom Token） |
| データ | Firestore（階層設計） |
| サーバー | Cloud Run functions（旧 第 2 世代 Functions） |
| 通知 | LINE Messaging API（コミュニケーションプラン = 月 200 通） |
| 開発期間 | 約 1 ヶ月（オフライン実装含む） |

---

## 読み方の推奨

- **個人開発の進め方が知りたい人**: Phase 1 → Phase 2（保存版）の順
- **特定のエラーで詰まっている人**: Phase 2 / Phase 4 から該当記事を直接
- **構造設計の参考にしたい人**: Phase 3 を順に
- **連載全体を通して読みたい人**: #1 → #2 → #3 → ... → #15 の番号順

---

## もう一度、アプリを試す

連載を読んで興味を持っていただけたら、実際にアプリも触ってみてください。

→ [**LINE で友だち追加してチックンノートを使う**](https://lin.ee/VWlYYzF)

公式アカウントの紹介ページ: [/apps/chickenote/](/apps/chickenote/)

---

## 連載の更新情報

連載は 2026 年 5 月 9 日に全 15 本完結しました。今後は **続編記事**（運用してから新しく踏んだ罠 / Phase L4 機能の実装記など）を本シリーズに追加していく予定です。

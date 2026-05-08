---
title: "LINE Developers Console の「LINE ログインチャネル」と「Messaging API チャネル」を取り違えた末路"
description: "LIFF + 公式アカウントの構成では LINE ログインチャネルと Messaging API チャネルを別々に作る必要がある。取り違えると 401 invalid LINE id token で詰まる。シークレットの使い分けと 2025 年の仕様変更含めて解説。"
publishDate: 2026-05-10
tags: [LINE, LIFF, Messaging API]
series: "LINE ミニアプリ開発記"
seriesNo: 11
draft: false
---

LINE 連携アプリを久しぶりに作ろうとすると、最初に必ず「あれ、チャネルって 2 種類あったっけ?」で軽く混乱します。LINE ログインチャネルと Messaging API チャネルは別もので、それぞれ別の設定値を持っていて、取り違えると本番リリース寸前に 401 を投げ続けるサーバー関数を眺めることになります。

先日も個人開発中の LINE ミニアプリで、LIFF の ID トークン検証だけなぜか 401 が返り続けて 30 分ほど消費しました。原因は `LINE_CHANNEL_ID` シークレットに **Messaging API チャネル側のチャネル ID** を入れていたことでした。本記事はこの 2 チャネルの責務分担と、2025 年に起きたコンソール側のフロー変更をまとめます。

## 状況・前提

- LINE ログインチャネル + LIFF アプリ + Messaging API（公式アカウント）の 3 点セット構成
- LIFF からの ID トークンをサーバーで検証し、Firebase Custom Token に変換する仕組み（`functions/src/verifyLineIdToken.ts`）
- LINE Developers Console の操作は 2026 年 5 月時点

LIFF が「ユーザー認証」を、公式アカウント（Messaging API）が「Push 通知」を担当する、というよくある分業です。

## 詰まったポイント

### 2 つのチャネルがある

LINE Developers Console には、用途の異なるチャネルが 2 種類あります。

| チャネル | 主な用途 | 必要な値 |
|---|---|---|
| **LINE ログインチャネル** | LIFF / LINE ログインの ID トークン発行・検証 | チャネル ID, LIFF ID |
| **Messaging API チャネル**（公式アカウント） | Webhook 受信・Push 送信・メッセージ応答 | チャネルアクセストークン（長期）, チャネルシークレット |

ID トークン検証 API（`https://api.line.me/oauth2/v2.1/verify`）は、`client_id` パラメータに **ID トークンを発行したチャネル** のチャネル ID を要求します。つまりここに渡すべきは **LINE ログインチャネル** の ID。Messaging API 側のチャネル ID を渡すと、エンドポイントは 400 系で蹴ります。

私が踏んだのはこのパターンで、`firebase functions:secrets:set LINE_CHANNEL_ID` の値に、コンソールの「Messaging API設定」タブで一番目立つ位置に表示されていたチャネル ID を入れてしまっていました。サーバー側のレスポンスはずっとこれです。

```json
{ "error": "invalid LINE id token" }
```

### 切り分け

```
[1] LIFF 側で idToken は取れている?
    └─ console.log で確認
       └─ 取れている。長さも妥当
          ↓
[2] サーバーの fetch が verify エンドポイントに届いている?
    └─ Cloud Functions のログ確認
       └─ 届いている。ステータスは 400 系
          ↓
[3] verify の引数のうち idToken は壊れてない?
    └─ クライアント側の値とサーバー側で受け取った値を比較
       └─ 一致している
          ↓
[4] 残るは client_id（= LINE_CHANNEL_ID）
    └─ シークレットの値を確認
       └─ Messaging API 側のチャネル ID が入っていた
          ★ LINE ログインチャネルの ID と取り違えていたと気付く
```

### 2025 年のコンソール側フロー変更

ややこしさを倍増させるのが、2025 年に LINE 公式アカウント作成のフローが変わった点です。Developers Console から **Messaging API チャネルを直接作成する機能は廃止** され、代わりに次の手順になりました。

1. Developers Console の「新規チャネル作成」で「LINE 公式アカウントを作成する」を選ぶ
2. **LINE Official Account Manager**（manager.line.biz）に遷移
3. 公式アカウントを作る
4. その公式アカウントの設定画面で **「Messaging API を利用する」** を有効化
5. プロバイダーを紐付ける
6. Developers Console に戻ると、選択したプロバイダーの下に Messaging API チャネルが追加されている

古い記事や生成 AI に手順を聞くと、まだ廃止前のフローを返してくることがあります。「Console から直接 Messaging API チャネルを作れない」と分かっていれば回り道はしないで済みます。

## 解決手順

シークレットの対応を表で固定するのが一番事故が起きません。

| シークレット | 値の出どころ | コンソール上の場所 |
|---|---|---|
| `LINE_CHANNEL_ID` | **LINE ログインチャネル** のチャネル ID | LINE ログインチャネル → 基本設定 → チャネル ID |
| `LINE_CHANNEL_SECRET` | **Messaging API チャネル** のチャネルシークレット | Messaging API チャネル → 基本設定 → チャネルシークレット |
| `LINE_CHANNEL_ACCESS_TOKEN` | **Messaging API チャネル** のチャネルアクセストークン（長期） | Messaging API 設定 → チャネルアクセストークン（長期）→ 発行 |
| `NEXT_PUBLIC_LIFF_ID` | LIFF アプリ ID | LINE ログインチャネル → LIFF タブ → LIFF ID |

設定し直したあとは Cloud Functions の再デプロイが必要です。

```bash
firebase functions:secrets:set LINE_CHANNEL_ID
# → LINE ログインチャネルの ID を貼り付け
firebase deploy --only functions:verifyLineIdToken
```

これで verify エンドポイントが 200 を返すようになります。

## 学び・余談

「2 つのチャネルがある」というのは公式ドキュメントを真面目に読めば書いてあるのですが、最初に作るときは LIFF の動作確認に意識が行き過ぎて、Messaging API は後回しになりがちです。後回しのまま「公式アカウントから Push 飛ばすついでに `LINE_CHANNEL_ID` も設定しちゃおう」とやると、まさに私が踏んだ罠に落ちます。

頭の整理に役立ったのは「**ID トークンを発行した側のチャネル ID で検証する**」という一行のメンタルモデルでした。LIFF のトークンは LINE ログインチャネルが発行するので、検証には LINE ログイン側の ID を使う、それだけ。シークレットの命名も `LINE_LOGIN_CHANNEL_ID` のように発行元を明示しておけば、似た罠は減るかもしれません。

## 関連記事

- [#3 LINE LIFF の ID トークンを Firebase Custom Token に変換する認証フロー実装](./03-liff-firebase-custom-token.md)
- [#10 LINE Webhook の「検証」が初回必ず失敗する理由とコールドスタート対策](./10-line-webhook-cold-start.md)

## 参考

- [LINE 公式: チャネルとは](https://developers.line.biz/ja/docs/messaging-api/getting-started/)
- [LINE 公式: ID トークンを検証する](https://developers.line.biz/ja/reference/line-login/#verify-id-token)
- [LINE 公式: LIFF を始める](https://developers.line.biz/ja/docs/liff/)

---


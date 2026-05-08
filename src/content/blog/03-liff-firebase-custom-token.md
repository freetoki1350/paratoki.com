---
title: "LINE LIFF の ID トークンを Firebase Custom Token に変換する認証フロー実装"
description: "LIFF の ID トークンを Cloud Functions で検証し、Firebase Custom Token を発行してクライアントで signInWithCustomToken する実装。クライアント・サーバー両側のフルコードと line:Uxxx プレフィックス設計の意図。"
publishDate: 2026-05-17
tags: [LIFF, Firebase, 認証, Cloud Functions, TypeScript]
series: "LINE ミニアプリ開発記"
seriesNo: 3
draft: false
---

LINE LIFF を使って何かを作るとき、「LINE のユーザー識別を Firebase 側のセッションにつなぐ」工程は最初に作るわりに毎回ググりながら書くやつです。LIFF SDK が `getIDToken()` をくれるので、これを **Cloud Functions の片側で検証** して、検証 OK なら **Firebase Auth Custom Token** を発行してクライアントに返す、という流れになります。

本記事は LIFF + Firebase Custom Token の認証フローを、クライアント側・サーバー側の **コピペで動くコード** と一緒に解説します。`line:Uxxx` という uid プレフィックスの設計意図など、後から効いてくる小ネタも書きます。

## 状況・前提

- Next.js 15.5.15（App Router、クライアント側）
- LIFF SDK v2 系
- Cloud Functions（第 2 世代、TypeScript）
- Firebase Auth は **Custom Token** を使う（Email / Google 等の Sign-in method は無効でよい）

## 認証フローの全体像

```
[1] LIFF アプリが起動
    └─ liff.init() → liff.getIDToken() で ID トークン取得
       ↓
[2] クライアント → Cloud Functions: verifyLineIdToken
    └─ POST /verifyLineIdToken { idToken }
       ↓
[3] サーバー側で LINE Verify API に問い合わせ
    └─ https://api.line.me/oauth2/v2.1/verify
       └─ client_id = LINE ログインチャネルの ID
          ↓
[4] 検証 OK なら sub（LINE userId）から Firebase Custom Token 発行
    └─ admin.auth().createCustomToken(`line:${userId}`)
       ↓
[5] クライアントで signInWithCustomToken
    └─ Firebase Auth セッションが確立
       ★ 以降は Firestore SDK が自動でセッション付き
```

ポイントは **2 段階** にしていること。LIFF の ID トークンを毎リクエスト送って検証するのではなく、**初回 1 回** だけ Custom Token に変換して、以降は Firebase Auth のセッションで動かします。Firestore SDK もこのセッションを勝手に拾ってくれるので、クライアントコードはほぼ普通の Firebase アプリと同じ書き味になります。

## サーバー側の実装

`functions/src/verifyLineIdToken.ts`:

```ts
import { onRequest } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { defineSecret } from "firebase-functions/params";

const LINE_CHANNEL_ID = defineSecret("LINE_CHANNEL_ID");

export const verifyLineIdToken = onRequest(
  { secrets: [LINE_CHANNEL_ID], cors: true },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method Not Allowed");
      return;
    }

    const { idToken } = req.body as { idToken?: string };
    if (!idToken) {
      res.status(400).json({ error: "idToken required" });
      return;
    }

    const params = new URLSearchParams({
      id_token: idToken,
      client_id: LINE_CHANNEL_ID.value(),
    });

    const verifyRes = await fetch("https://api.line.me/oauth2/v2.1/verify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    if (!verifyRes.ok) {
      res.status(401).json({ error: "invalid LINE id token" });
      return;
    }

    const payload = (await verifyRes.json()) as { sub: string };
    const lineUserId = payload.sub;

    const firebaseToken = await getAuth().createCustomToken(`line:${lineUserId}`);
    res.json({ firebaseToken });
  }
);
```

Secret として `LINE_CHANNEL_ID` を `defineSecret` で取り込むのが第 2 世代 Functions の流儀です。`firebase functions:secrets:set LINE_CHANNEL_ID` で値を入れておきます。

`client_id` に渡すのは **LINE ログインチャネル** のチャネル ID。Messaging API チャネル側の ID を間違って入れると 401 が返り続けます（別記事 #11 参照）。

## クライアント側の実装

`lib/liffAuth.ts`:

```ts
import liff from "@line/liff";
import { getAuth, signInWithCustomToken } from "firebase/auth";
import { firebaseApp } from "./firebase";

const LIFF_ID = process.env.NEXT_PUBLIC_LIFF_ID!;
const VERIFY_ENDPOINT = process.env.NEXT_PUBLIC_VERIFY_TOKEN_ENDPOINT!;

export async function signInWithLiff() {
  await liff.init({ liffId: LIFF_ID });
  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }

  const idToken = liff.getIDToken();
  if (!idToken) throw new Error("LIFF id token unavailable");

  const verifyRes = await fetch(VERIFY_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });

  if (!verifyRes.ok) {
    throw new Error(`verify failed: ${verifyRes.status}`);
  }

  const { firebaseToken } = (await verifyRes.json()) as {
    firebaseToken: string;
  };

  await signInWithCustomToken(getAuth(firebaseApp), firebaseToken);
}
```

クライアント側は `liff.init()` → `getIDToken()` → `fetch(検証関数)` → `signInWithCustomToken()` の 4 ステップ。`signInWithCustomToken()` まで通れば、`getAuth().currentUser.uid` が `line:Uxxxx...` の形で取れる状態になります。

### `AuthGate` コンポーネントで起動時に呼び出す

ルート近くにこういうゲートを置くと、画面ロジックは認証済みを前提に書けます。

```tsx
"use client";
import { useEffect, useState } from "react";
import { onAuthStateChanged, getAuth } from "firebase/auth";
import { firebaseApp } from "@/lib/firebase";
import { signInWithLiff } from "@/lib/liffAuth";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(getAuth(firebaseApp), (user) => {
      if (user) {
        setReady(true);
      } else {
        signInWithLiff().catch(setError);
      }
    });
    return () => unsubscribe();
  }, []);

  if (error) return <div>ログインに失敗しました</div>;
  if (!ready) return <div>ログイン中…</div>;
  return <>{children}</>;
}
```

`onAuthStateChanged` で「ログイン済み」が伝わってきたら `ready` を立て、そうでなければ `signInWithLiff()` を走らせる、という素直な設計にしています。エラー時の握りつぶしには注意（別記事 #9 参照）。

## `line:Uxxx` プレフィックス設計の意図

サーバー側で `createCustomToken` に渡している uid を `line:Uxxxx` の形にしています。LINE userId（U で始まる 33 文字）はそのまま `auth.uid` の制約を満たすので、プレフィックスは技術的に不要です。それでも付けている理由は **将来の拡張への保険** です。

```
[1] 今: LINE 認証だけ
    line:U1234abcd...
[2] 将来: メール認証や Twitter 認証を追加するとき
    email:user@example.com
    twitter:1234567890
    ★ 認証手段の混在が uid を見ただけで分かる
```

DB 側の uid を見ただけで「どの認証由来か」が分かるので、後で別経路をつないだときに分岐が書きやすくなります。Push 通知のために uid から LINE userId に戻すときも `uid.startsWith("line:") ? uid.slice(5) : null` で済みます。

## 学び・余談

LIFF + Firebase の認証は、**1 回だけ ID トークンを検証して以降は Firebase Auth で動かす** というパターンを覚えてしまえば、ほぼボイラープレートです。毎リクエストで LINE Verify API を叩くと、レスポンス時間と LINE 側のレート制限の両方で詰みます。Custom Token に変換した瞬間に、それ以降は普通の Firebase アプリと変わらない開発体験になる、というのがこの構成の気持ちよさです。

エラーハンドリングはまだ薄めの実装です。`liff.init` のリトライ、`signInWithCustomToken` 失敗時の再試行、ネットワーク不安定時の挙動などは別記事で扱います。

## 関連記事

- [#11 LINE Developers Console の「LINE ログインチャネル」と「Messaging API チャネル」を取り違えた末路](/blog/11-line-channel-mixup/)
- [#9 AuthGate のエラーが握りつぶされて画面が無限ローディングになっていた話](/blog/09-authgate-swallowed-error/)
- [#4 Firestore の階層設計でセキュリティルールを劇的にシンプルにする方法](/blog/04-firestore-hierarchy/)

## 参考

- [LINE 公式: ID トークンを検証する](https://developers.line.biz/ja/reference/line-login/#verify-id-token)
- [Firebase 公式: Custom Authentication System を統合する](https://firebase.google.com/docs/auth/admin/create-custom-tokens?hl=ja)

---


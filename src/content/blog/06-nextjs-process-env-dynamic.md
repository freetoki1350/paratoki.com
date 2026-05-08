---
title: "Next.js で process.env[varName] が undefined になる罠 — 静的置換の仕組みと対策"
description: "Next.js + Vercel で「必須の環境変数が未設定です」と Application error: a client-side exception が出た。原因は process.env[varName] の動的添字アクセス。仕組みと対策を解説。"
publishDate: 2026-05-08
tags: [Next.js, Vercel, TypeScript, 環境変数]
series: "LINE ミニアプリ開発記"
seriesNo: 6
draft: false
---

Next.js で書いたアプリを Vercel に上げたとたん、画面が真っ白になる。ローカルではちゃんと動いていたのに本番ビルドだけで症状が出る、というのは何度味わってもこたえます。

先日も個人開発中の LINE ミニアプリを Vercel にデプロイしたところ、まったく同じ目に遭いました。ブラウザに表示されたのは `Application error: a client-side exception has occurred` の一行だけ。`.env.local` に値はちゃんと入っているはずなのに、クライアント側からは「必須の環境変数が未設定です」というエラーが投げられている。

原因は `process.env[varName]` の **動的添字アクセス** が Next.js のビルド時静的置換の対象外だったことでした。本記事は同じ症状で詰まった Next.js 利用者向けに、仕組みと対策を実コード付きでまとめます。

## 状況・前提

- Next.js 15.5.15（App Router）
- TypeScript 5.x
- ホスティング: Vercel（Production 環境）
- 環境変数は 8 本ほど（`NEXT_PUBLIC_LIFF_ID` ほか Firebase 関連の `NEXT_PUBLIC_FIREBASE_*` 一式）
- 起動時に必須キーをまとめて検証する `getPublicEnv()` ヘルパーをライブラリ側（`lib/env.ts`）に用意していました

ローカルの `npm run dev` ではエラーが出ず、Vercel にデプロイした瞬間だけ症状が出る、というのが厄介でした。

## 詰まったポイント

### エラーメッセージ

ブラウザのコンソールに表示されたのはこれだけです。

```
Application error: a client-side exception has occurred (see the browser console for more information).
```

そのうしろに、私の場合は自前の検証で投げているエラーが続きました。

```
Error: 必須の環境変数が未設定です: NEXT_PUBLIC_LIFF_ID, NEXT_PUBLIC_FIREBASE_API_KEY, NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN, NEXT_PUBLIC_FIREBASE_PROJECT_ID, NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET, NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID, NEXT_PUBLIC_FIREBASE_APP_ID, NEXT_PUBLIC_VERIFY_TOKEN_ENDPOINT
.env.local または Vercel/CI の Project Settings を確認してください。
```

### 最初に試したこと

頭の中の切り分けはおおまかにこう進みました。

```
[1] Vercel の環境変数の設定漏れでは?
    └─ Project Settings を 3 周見直す
       └─ 値は全部入っている。空欄なし
          ↓
[2] 環境スコープのミスでは?（Production だけに入れてないとか）
    └─ Production / Preview / Development を確認
       └─ 全部入っている
          ↓
[3] デプロイにキャッシュが残ってるのでは?
    └─ 再デプロイ
       └─ 結果は同じ。エラーも一字一句同じ
          ↓
[4] そもそも Vercel から見えていない?
    └─ Edge Function を仕込んで process.env をログ出力
       └─ サーバー側ではちゃんと読めている
          ↓
[5] ……サーバーでは読めて、クライアントで読めない?
    ★ 問題はクライアント側だけで起きている、と気付く
```

[1] から [5] にたどり着くまでに 30 分溶かしました。「サーバーで読めてクライアントで読めない」のフレーズが頭の中で組み上がった瞬間に、ようやく Next.js のバンドル仕様の話だと当たりがつきました。

### 真因

`lib/env.ts` の検証ループはこう書いていました。

```ts
const REQUIRED_KEYS: Array<{ env: string; path: string }> = [
  { env: "NEXT_PUBLIC_LIFF_ID", path: "liffId" },
  { env: "NEXT_PUBLIC_FIREBASE_API_KEY", path: "firebase.apiKey" },
  // ...
];

export function getPublicEnv(): PublicEnv {
  const missing: string[] = [];
  for (const { env } of REQUIRED_KEYS) {
    if (!process.env[env]) missing.push(env); // ← これ
  }
  // ...
}
```

`process.env[env]` の `env` は文字列変数。**動的な添字アクセス** です。

Next.js は `NEXT_PUBLIC_*` プレフィックスの環境変数をクライアントへ届けるために、ビルド時に **ソース中の `process.env.NEXT_PUBLIC_FOO` というリテラル参照を値に置換** しています。一方、`process.env[varName]` のような動的アクセスは静的解析できないため置換対象から外れます。クライアント側のバンドルでは `process.env` 自体が空オブジェクトになっているので、`process.env[env]` は **常に undefined** を返す。検証ループから見ると「全部欠けている」ことになり、起動時に例外が飛ぶ、という連鎖でした。

ローカルの `next dev` では Node.js プロセスから直接 `process.env` が見えるため動的アクセスでも値が取れてしまい、ビルド成果物だけで再現する罠です。

## 解決手順

検証ループも **リテラルアクセス** に書き換えます。`NEXT_PUBLIC_*` を読む場所は必ず `process.env.NEXT_PUBLIC_XXX` の形にする、というのが鉄則です。

```ts
const REQUIRED_ENVS = {
  NEXT_PUBLIC_LIFF_ID: process.env.NEXT_PUBLIC_LIFF_ID,
  NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  NEXT_PUBLIC_VERIFY_TOKEN_ENDPOINT: process.env.NEXT_PUBLIC_VERIFY_TOKEN_ENDPOINT,
} as const;

export function getPublicEnv(): PublicEnv {
  const missing = Object.entries(REQUIRED_ENVS)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`必須の環境変数が未設定です: ${missing.join(", ")}`);
  }
  // ...以降は REQUIRED_ENVS から型安全に取り出す
}
```

このオブジェクトはビルド時に各値が静的に置換されるため、クライアント側でも値が読めます。

### 検証

`npm run build && npm start` でローカルに本番ビルドを立ち上げると、Vercel と同じ条件で再現できます。修正前は `next dev` では問題が出ないので、必ず `next build` 経由で動作確認してください。私はこれを習慣にしてから、似たクラスのバグを Vercel 行きで踏まなくなりました。

## 学び

`process.env` は普通の JavaScript オブジェクトに見えますが、Next.js の世界では **ビルド時のテキスト置換マクロ** に近い扱いをされています。「変数経由でアクセス」「分割代入」「スプレッド」など、リテラル形でない参照は基本的に届きません。原則は単純で、

- `NEXT_PUBLIC_*` を読むコードでは必ず `process.env.NEXT_PUBLIC_XXX` の **リテラル形** を書く
- 検証ヘルパーを作るときも、キー一覧を for ループで回さず、オブジェクトに**書き下す**

という 2 点を守れば踏まないバグでした。子どもと絵本を読んでいる最中に「あ、添字のせいか」とはっと気付いたのは、このプロジェクトを通じて一番気持ちのいい瞬間でした。同じ罠に落ちた人が検索で辿り着けるよう、原文のエラーメッセージを置いておきます。

## 関連記事

- [#7 Vercel デプロイで半日溶かした 4 つの罠](./07-vercel-deploy-traps.md)
- [#2 LINE LIFF + Firebase + Vercel で月額 0 円運用するためのアーキテクチャ全体図](./02-architecture-overview.md)

## 参考

- [Next.js 公式: Environment Variables](https://nextjs.org/docs/app/building-your-application/configuring/environment-variables)
- [Next.js 公式: Bundling Environment Variables for the Browser](https://nextjs.org/docs/app/building-your-application/configuring/environment-variables#bundling-environment-variables-for-the-browser)

---


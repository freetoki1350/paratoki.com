---
title: "AuthGate のエラーが握りつぶされて画面が無限ローディングになっていた話"
description: "onAuthStateChanged の async コールバックで try/catch を書き忘れると、認証エラーが Promise の闇に消えて画面が永遠に「ログイン中…」のままになる。エラーを必ず UI に出す原則と実装パターン。"
publishDate: 2026-05-21
tags: [React, Firebase, 認証, エラーハンドリング]
series: "LINE ミニアプリ開発記"
seriesNo: 9
draft: false
---

「画面が永遠にローディング」は、利用者にとっては **失敗とすら認識されない** 種類の事故です。少なくともエラー画面が出れば「あ、何か起きた」と分かります。ローディングのままだと「自分のネットが遅いのかな?」と利用者が疑い始める。

私はこれを LIFF アプリの認証ゲートでやらかしました。`onAuthStateChanged` の async コールバックの中で `signInWithLiff()` を呼んでいて、そこで例外が出ると **どこにも届かないまま揉み消される** 設計になっていました。本記事はその修正過程と、「エラーは必ず UI まで届ける」を保証するためのパターンを書きます。

## 状況・前提

- Next.js 15.5.15（App Router、クライアントコンポーネント）
- Firebase Auth + LIFF Custom Token
- 認証ゲートコンポーネント `AuthGate.tsx`
- 起動時に LIFF 経由で自動ログインする構成

## 詰まったポイント

### 症状: 「ログイン中…」のまま動かない

LIFF を開くと、画面に出るのは「ログイン中…」のローディング表示だけ。10 秒待っても 1 分待っても変わらない。エラーは画面のどこにも出ていない。リロードすると同じ。

開発者ツールのコンソールにも何も出ていません。これが厄介でした。

### 原因の構造

最初に書いていた `AuthGate` のコードはこんな感じでした。

```tsx
"use client";
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const unsub = onAuthStateChanged(getAuth(), async (user) => {
      if (user) {
        setReady(true);
      } else {
        await signInWithLiff(); // ← ここで例外が出ると...
      }
    });
    return () => unsub();
  }, []);

  if (!ready) return <div>ログイン中…</div>;
  return <>{children}</>;
}
```

`signInWithLiff()` のなかで例外が投げられると、`onAuthStateChanged` のコールバックは **async 関数** なので返り値の Promise が reject されます。`onAuthStateChanged` 自体はその Promise を **誰も await していない**。結果、エラーはそのまま **未捕捉の Promise rejection** として宙に消えます。

```
[1] Auth 状態が "未ログイン" で発火
    └─ async コールバックが走り出す
       ↓
[2] signInWithLiff() の中で fetch が 401 を返す
    └─ throw new Error("verify failed: 401")
       ↓
[3] async コールバックの Promise が reject
    └─ onAuthStateChanged は Promise を return 値として持っていない
       └─ 誰も await していない
          ↓
[4] React の state は変わらない（setReady(true) も呼ばれない）
    └─ 画面はローディングのまま
       ★ エラーは静かに消滅
```

ブラウザの DevTools が `Uncaught (in promise)` を出してくれることもありますが、LIFF 内ブラウザだとログ自体が見えにくく、気付きにくい状態でした。

## 解決手順

### 1. async コールバックの内側で try/catch を必ず書く

最低限の修正はこれです。

```tsx
useEffect(() => {
  const unsub = onAuthStateChanged(getAuth(), async (user) => {
    try {
      if (user) {
        setReady(true);
      } else {
        await signInWithLiff();
      }
    } catch (e) {
      setError(e);
    }
  });
  return () => unsub();
}, []);
```

`setError(e)` で React state にエラーを記録して、UI に出します。これだけで「無言のローディング」は解消します。

### 2. UI に必ずエラー分岐を出す

state を増やしただけでは UI には出ません。**ローディング・エラー・ready の 3 状態** を明示します。

```tsx
const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
const [errorMessage, setErrorMessage] = useState<string | null>(null);

useEffect(() => {
  const unsub = onAuthStateChanged(getAuth(), async (user) => {
    try {
      if (user) {
        setPhase("ready");
      } else {
        await signInWithLiff();
      }
    } catch (e) {
      setErrorMessage(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  });
  return () => unsub();
}, []);

if (phase === "loading") return <div>ログイン中…</div>;
if (phase === "error") return (
  <div>
    <p>ログインに失敗しました</p>
    <p>{errorMessage}</p>
    <button onClick={() => location.reload()}>再試行</button>
  </div>
);
return <>{children}</>;
```

「再試行」ボタンが付くだけで、利用者が取れる行動が増えます。私はこの修正を入れた直後の数日で、利用者から「再試行で動きました」というフィードバックを実際にもらいました。エラーを出すこと自体が UX のひとつだと痛感しました。

### 3. グローバルな未捕捉 Promise の網

万一 `try/catch` を書き忘れた場合の最後の砦として、グローバルハンドラを用意します。

```tsx
useEffect(() => {
  const handler = (e: PromiseRejectionEvent) => {
    console.error("unhandled rejection:", e.reason);
    // 任意: Cloud Functions 経由でサーバー側にも通知
  };
  window.addEventListener("unhandledrejection", handler);
  return () => window.removeEventListener("unhandledrejection", handler);
}, []);
```

これで「気付かないまま消えるエラー」を最低限ログには残せます。本気でやるなら、サーバー側の `reportError` 関数を呼んで運営の LINE に通知を飛ばすところまで仕組み化しておくと、本番事故への気付きが早まります。

## 設計の原則

今回の修正で自分のなかに残った原則は 3 つです。

```
[1] async コールバックの中身は必ず try/catch で囲む
    └─ 特に「コールバック側が Promise を await しない」関数 に渡す async は要警戒
[2] UI は必ず loading / ready / error の 3 状態を持つ
    └─ 2 状態（loading / ready）はバグの温床
[3] グローバルな unhandledrejection ハンドラで最後の砦を作る
    ★ 「無言のローディング」を構造的に潰す
```

`onAuthStateChanged` のような **コールバック型 API に async 関数を渡す** ときは、特にこの 3 つを意識します。Promise を返してもどこにも捕まらない設計になっていることが多く、そこが闇です。

## 学び・余談

このバグの一番こわい点は、**気付くまでの遅さ** でした。エラー画面が出ていれば即気付きます。ログに出ていればすぐ追えます。「無言のローディング」は誰も悲鳴を上げないので、自分が利用者ぶって LIFF を開くまで気付かなかったのが、半日くらいかかりました。

エラーを必ず可視化する、という原則は、コードを書くときには面倒に感じるのですが、**自分が利用者になって自分のアプリを使ったときに一番効く** タイプの工数だと思います。今では新しい async コールバックを書くたびに、まず空の try/catch を貼ってから中身を埋めるようにしています。

## 関連記事

- [#3 LINE LIFF の ID トークンを Firebase Custom Token に変換する認証フロー実装](/blog/03-liff-firebase-custom-token/)
- [#5 Firestore 複合インデックスを忘れて「すべて完了しました」と誤表示された話](/blog/05-firestore-composite-index/)

## 参考

- [MDN: PromiseRejectionEvent](https://developer.mozilla.org/ja/docs/Web/API/PromiseRejectionEvent)
- [Firebase 公式: 認証状態の変化を監視する](https://firebase.google.com/docs/auth/web/manage-users?hl=ja#get_the_currently_signed-in_user)

---


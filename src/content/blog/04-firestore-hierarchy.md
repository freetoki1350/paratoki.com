---
title: "Firestore の階層設計でセキュリティルールを劇的にシンプルにする方法"
description: "users/{uid}/... のネスト構造で Firestore を設計すると、isOwner(uid) 1 関数だけで配下のすべてのリソースを保護できる。フラット設計と比較しながらシンプル化の効果を解説。"
publishDate: 2026-05-18
tags: [Firestore, Firebase, セキュリティ, アーキテクチャ]
series: "LINE ミニアプリ開発記"
seriesNo: 4
draft: false
---

Firestore のセキュリティルールは、書き始めると **コレクションごとに同じような分岐を何度も書くことになって地味に長くなる** やつです。ユーザーが自分のデータだけにアクセスできる、という当たり前の保証を、コレクション数 × 操作（read/write/create/update/delete）の数だけ繰り返す。これが膨らむと、ある日「あれ、ここの create に owner チェックが抜けてる?」が事故の発火点になります。

本記事は、Firestore のドキュメント階層を **`users/{uid}/...` の入れ子構造** にすることで、セキュリティルールを **1 関数 1 行** に圧縮できる、という設計の話です。フラット設計と比較して、何が短くなって何を諦めるかを整理します。

## 状況・前提

- Firestore（asia-northeast1、本番モード）
- Firebase Auth で uid が設定される構成
- リソース: ユーザー、ユーザーごとの子リソース（複数）、さらにその子リソース（孫）あり
- 個人アプリ規模、コレクション数は 5〜10

## 設計の比較

### フラット設計（よくあるやつ）

ルートにすべてのコレクションを並べて、各ドキュメントに `userId` フィールドを持たせる方式です。

```
users/{userId}
profiles/{profileId}        // userId フィールドあり
records/{recordId}          // userId フィールドあり
logs/{logId}                // userId フィールドあり
```

セキュリティルールは各コレクションで `userId == request.auth.uid` を確認します。

```js
match /databases/{database}/documents {
  match /profiles/{id} {
    allow read, write: if request.auth != null
      && request.auth.uid == resource.data.userId;
    allow create: if request.auth != null
      && request.auth.uid == request.resource.data.userId;
  }
  match /records/{id} {
    allow read, write: if request.auth != null
      && request.auth.uid == resource.data.userId;
    allow create: if request.auth != null
      && request.auth.uid == request.resource.data.userId;
  }
  match /logs/{id} {
    allow read, write: if request.auth != null
      && request.auth.uid == resource.data.userId;
    // ...
  }
}
```

コレクションが増えるたびにブロックがコピペされます。`create` と他の操作で `resource.data` と `request.resource.data` を使い分ける必要もあるため、**ルールの書き間違い・確認漏れの温床** になります。

### 階層設計（今回の推奨）

ユーザー配下に子・孫リソースを入れ子にします。

```
users/{uid}
  profile/                       // ユーザー直下のサブコレクション
  children/{cid}/
    records/{rid}
    logs/{logId}
```

セキュリティルールは入口を 1 箇所だけ守れば、配下が全部守られます。

```js
match /databases/{database}/documents {
  function isOwner(uid) {
    return request.auth != null && request.auth.uid == uid;
  }

  match /users/{uid}/{document=**} {
    allow read, write: if isOwner(uid);
  }
}
```

これだけ。`{document=**}` のワイルドカードで、`users/{uid}` 配下のあらゆる深さのドキュメントが対象になります。`isOwner(uid)` の 1 関数で読み書きどちらも判定できます。

### 比較表

| 観点 | フラット設計 | 階層設計 |
|---|---|---|
| ルールの長さ | コレクションごとに分岐、合計 50〜100 行 | 1 関数 + 1 ブロック = 5〜10 行 |
| 新コレクション追加時の作業 | 同パターンを 1 ブロック追記 | **追加作業ゼロ**（自動で守られる） |
| `userId` フィールドの保守 | 各ドキュメントに必須、漏れると無防備 | パス自体が所有者を表すので不要 |
| 横断クエリ | `where('userId', '==', uid)` で 1 発 | collectionGroup を使う |
| マイグレーション容易性 | フィールド追加で済む | パスを変えるとクライアント全書き換え |

ルールを短く、追加作業をゼロに寄せられる代わりに、**横断クエリで collectionGroup を使う** ことになるのが主なトレードオフです。

## 階層設計の細部

### 型バリデーションも入口で 1 度だけ

セキュリティルールで型チェックを入れたい場合も、入口の `match` の中で 1 関数として定義すれば配下にかかります。

```js
match /databases/{database}/documents {
  function isOwner(uid) {
    return request.auth != null && request.auth.uid == uid;
  }

  function isString(v) { return v is string; }
  function isPositiveInt(v) { return v is int && v >= 0; }

  match /users/{uid} {
    allow read, write: if isOwner(uid);

    match /children/{cid} {
      allow create: if isOwner(uid)
        && isString(request.resource.data.name)
        && isString(request.resource.data.birthDate);
      allow read, update, delete: if isOwner(uid);

      match /records/{rid} {
        allow read, write: if isOwner(uid);
      }
    }
  }
}
```

入口の所有チェックと、子コレクションでの作成時バリデーションを分けて書ける、という二段の使い分けが可能です。

### 横断クエリは collectionGroup

cron で「全ユーザーのレコードを 1 度に取りたい」場合は `collectionGroup` を使います。

```ts
import { getFirestore } from "firebase-admin/firestore";

const records = await getFirestore()
  .collectionGroup("records")
  .where("scheduledDate", "==", tomorrow)
  .where("completedDate", "==", null)
  .get();
```

`collectionGroup` 用のインデックスは `firestore.indexes.json` に明示的に書く必要があります（複合インデックス忘れ問題は別記事 #5 参照）。

### サーバー側からはルールが効かない

Cloud Functions の `firebase-admin` から書き込むときは **セキュリティルールがバイパスされる** 点だけ注意します。階層設計でもフラット設計でも同じですが、サーバー側から書き込むときは `users/{uid}/...` のパスを **アプリ側で手で組み立てる必要** があるので、ヘルパー関数にしておくのがおすすめです。

```ts
function userPath(uid: string) {
  return `users/${uid}`;
}

function recordsPath(uid: string, cid: string) {
  return `${userPath(uid)}/children/${cid}/records`;
}
```

## 階層設計が向かないケース

- **コレクションを跨いだ複雑な集計が頻発する**: collectionGroup でカバーできない場合、ルートに集計用のコレクションを別途置く必要が出てくる
- **シェアード（共有）リソースを扱う**: 「ユーザー A のドキュメントをユーザー B にも見せる」のような共有はパスが固定されているのでやりにくい。共有が主機能のアプリには向かない
- **後からスキーマを大きく変える可能性が高い**: パスを変えるとクライアントの全書き換えが必要

私のアプリのように **ユーザーごとにデータが完結する** 個人開発には階層設計が刺さる、という判断でした。

## 学び・余談

「セキュリティルールが短い」は単に行数の問題ではなく、**新しいコレクションを足したときに既存のルールに影響しない** ことが本当の効きです。フラット設計だと、新しいコレクションごとに「ルール書いたっけ」と確認する習慣が要りますが、階層設計だと入口を守っている安心感が、機能追加のたびに払うレビューコストを下げてくれます。

シンプルなセキュリティルールは、半年ぶりに自分のコードを開いた未来の自分への一番の贈り物だと思っています。

## 関連記事

- [#5 Firestore 複合インデックスを忘れて「すべて完了しました」と誤表示された話](/blog/05-firestore-composite-index/)
- [#3 LINE LIFF の ID トークンを Firebase Custom Token に変換する認証フロー実装](/blog/03-liff-firebase-custom-token/)

## 参考

- [Firestore 公式: セキュリティルールを構造化する](https://firebase.google.com/docs/firestore/security/rules-structure?hl=ja)
- [Firestore 公式: collectionGroup クエリ](https://firebase.google.com/docs/firestore/query-data/queries?hl=ja#collection-group-query)

---


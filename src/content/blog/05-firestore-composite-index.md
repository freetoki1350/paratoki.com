---
title: "Firestore 複合インデックスを忘れて「すべて完了しました」と誤表示された話"
description: "Firestore の where + orderBy 複合クエリで複合インデックス未デプロイだと FAILED_PRECONDITION で reject。Promise.all 内で握りつぶすと state 初期値のまま「完了」表示になる連鎖バグの解説。"
publishDate: 2026-05-11
tags: [Firestore, Firebase, React, バグ]
series: "LINE ミニアプリ開発記"
seriesNo: 5
draft: false
---

「画面が真っ白」より厄介なのは、**画面が正常そうに見えるのに中身が嘘** というバグです。Firestore のクエリエラーがフロントの `Promise.all` で握りつぶされ、state が初期値のまま描画される、というパターンに私は一度ハマって、本来は件数が残っているはずの画面で **「すべて完了しました 🎉」** という祝福メッセージを眺めることになりました。

原因はシンプルで、`where + orderBy` の複合クエリに必要な **複合インデックスを Firestore にデプロイし忘れていた** こと。それだけです。それだけなのに表示は完璧に「成功」だった、というところが今回の本題です。本記事は同種の連鎖バグを早く見抜くための切り分けと予防策をまとめます。

## 状況・前提

- Firestore（`asia-northeast1`、本番モード）
- Next.js 15.5.15（App Router、クライアントサイドからの直接クエリ）
- ホーム画面の reload で 3 つのクエリを `Promise.all` で並列実行
- うち 1 つが `getNextUpcoming`（特定条件で絞り込んだうえで最も近い予定日のレコードを 1 件返す）= `where + orderBy` の複合クエリ
- ローカルエミュレータでは動いていた（エミュレータは複合インデックス不要）

ローカルでは動いていたものを、本番デプロイ後に開いて初めて症状が出ました。

## 詰まったポイント

### 表示はむしろ「成功」風

該当箇所のコードはおおよそこうなっていました。

```ts
const [nextRec, c, allRecords] = await Promise.all([
  getNextUpcoming(selectedChild.id),     // ← where + orderBy の複合クエリ
  getRecordCounts(selectedChild.id),
  listRecords(selectedChild.id),
]);
setNext(nextRec);
setCounts(c);
setWarnings(calculateWarnings(selectedChild.birthDate, allRecords));
```

`getNextUpcoming` が複合インデックス未デプロイで `FAILED_PRECONDITION` を投げる。`Promise.all` は **1 つでも reject したら全体が reject** するため、この `await` で例外が飛ぶ。`try/catch` を書いていなかったので例外は親に伝播するが、上位コンポーネントは `next`, `counts`, `warnings` の **state を初期値のまま放置** する。

初期値はこれ。

```ts
const [next, setNext] = useState<VaccineRecord | null>(null);
const [counts, setCounts] = useState({ completed: 0, remaining: 0 });
const [warnings, setWarnings] = useState<VaccineWarning[]>([]);
```

`next` が `null` で `remaining` が `0`。表示ロジックは「次の予定がなく残件が 0」を **「すべて完了」** と解釈するため、画面は祝福メッセージで埋まる、という連鎖でした。

### 切り分け

```
[1] データが入っていないだけでは?
    └─ Firestore コンソールで該当ユーザーのドキュメントを目視
       └─ 想定どおりの件数で存在
          ↓
[2] 認証されてないのでは?
    └─ DevTools の Network で他クエリの結果を確認
       └─ listRecords は想定件数を返している
          ↓
[3] 1 つだけ失敗してる?
    └─ Promise.all を Promise.allSettled に書き換えて結果を全部出す
       └─ getNextUpcoming だけ rejected
          ↓
[4] 何で reject されてる?
    └─ コンソールに出ているエラーを開く
       └─ FAILED_PRECONDITION: The query requires an index. ...
          └─ 続く URL を踏むと Firebase Console の「インデックス作成」画面
             ★ 複合インデックス未デプロイが原因と確定
```

エラーメッセージはこの形でブラウザコンソールに出ていました。

```
FirebaseError: [code=failed-precondition]: The query requires an index. You can create it here: https://console.firebase.google.com/project/...
```

`Promise.all` で握りつぶしていなければ最初に気付けたエラーで、つまり今回の本当の落とし穴は **複合インデックス忘れそのものではなく、エラーをサイレントに葬る `Promise.all` パターン** のほうでした。

## 解決手順

### 1. 複合インデックスを定義してデプロイ

`firestore.indexes.json` に追記します。

```json
{
  "indexes": [
    {
      "collectionGroup": "vaccineRecords",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "completedDate", "order": "ASCENDING" },
        { "fieldPath": "scheduledDate", "order": "ASCENDING" }
      ]
    }
  ]
}
```

```bash
firebase deploy --only firestore:indexes
```

反映には少し時間がかかります。私の場合は 5 分ほどで使えるようになりました。慌てずに待ってから本番でクエリを走らせます。

エラーメッセージに含まれる Firebase Console の URL をクリックすればワンクリックでインデックス作成も可能ですが、その方法は **Console 上にだけ存在するインデックス** を生やすことになり、Git 管理から外れます。`firebase firestore:indexes` で取得して `firestore.indexes.json` に追記し直す習慣をおすすめします。

### 2. クライアント側で `Promise.allSettled` + 個別ハンドリング

複数クエリのうち一部が失敗してもほかは表示できるよう、`Promise.all` を `Promise.allSettled` に置き換えます。

```ts
const results = await Promise.allSettled([
  getNextUpcoming(selectedChild.id),
  getRecordCounts(selectedChild.id),
  listRecords(selectedChild.id),
]);

const [nextRes, countsRes, recordsRes] = results;

if (nextRes.status === "fulfilled") setNext(nextRes.value);
else console.error("getNextUpcoming failed", nextRes.reason);

if (countsRes.status === "fulfilled") setCounts(countsRes.value);
if (recordsRes.status === "fulfilled") {
  setWarnings(calculateWarnings(selectedChild.birthDate, recordsRes.value));
}
```

`fulfilled` のもののみ state に反映、`rejected` は `console.error` でログに残す。「全部成功」を前提に書いたコードを「部分成功でも壊れない」コードへ寄せていく書き換えです。

### 3. 「全件完了」表示の前に到達失敗を区別する

UI 側でも、`next === null` を **完了 / クエリ失敗** で同じに扱わない設計に直します。

```tsx
if (loadError) return <ErrorState onRetry={reload} />;
if (next === null && counts.remaining === 0) return <AllDoneMessage />;
return <NextRecordCard record={next} />;
```

「データが取れていないこと」と「データを取った結果ゼロだったこと」を、UI レベルで区別する。これがあれば仮に複合インデックスを忘れても、ユーザーから見れば誤表示ではなく「再読み込みボタン付きのエラー画面」になります。

## 学び・余談

このバグから持ち帰れる教訓は 2 段あります。

ひとつは **Firestore の複合クエリは事前にインデックスを書き出してデプロイする**、という運用上のルール。`firestore.indexes.json` を Git 管理対象にしておけば、`getNextUpcoming` のような関数を新しく書いた時点でインデックスもセットで PR に乗ります。

もうひとつは **エラーをサイレントに葬る並列処理を書かない**。`Promise.all` は失敗したクエリの存在自体を呼び出し側から見えなくします。表示が「成功風」になるのはほぼここに集約されるので、複数クエリを走らせるときは `allSettled` を初手から選ぶ、くらいの強さで習慣化してよいと思っています。

## 関連記事

- [#4 Firestore の階層設計でセキュリティルールを劇的にシンプルにする方法](/blog/04-firestore-hierarchy/)
- [#9 AuthGate のエラーが握りつぶされて画面が無限ローディングになっていた話](/blog/09-authgate-swallowed-error/)

## 参考

- [Firestore 公式: インデックスを使ってクエリを最適化する](https://firebase.google.com/docs/firestore/query-data/indexing?hl=ja)
- [MDN: Promise.allSettled()](https://developer.mozilla.org/ja/docs/Web/JavaScript/Reference/Global_Objects/Promise/allSettled)

---


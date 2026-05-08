---
title: "Cloud Functions のサービスアカウント権限地獄を脱出するまで — 7 つの IAM ロールの正体"
description: "Firebase Cloud Functions で PERMISSION_DENIED や 500 が連続したときに必要だった IAM ロールを整理。Service Account Token Creator、Cloud Datastore User、Secret Manager Secret Accessor などの役割と付与手順。"
publishDate: 2026-05-12
tags: [Firebase, Cloud Functions, GCP, IAM]
series: "LINE ミニアプリ開発記"
seriesNo: 8
draft: false
---

Firebase Cloud Functions は最初の `firebase deploy` までは魔法のように楽です。でもデプロイの外側に出た瞬間、つまり関数のなかから Firestore を触ったり Secret を読んだり Custom Token を発行したりし始めたとき、**サービスアカウントの IAM ロール不足** で 500 エラーや `PERMISSION_DENIED` がぽろぽろ出始めます。これがまた、エラーメッセージから「どのロールを足せばいいか」が直接読み取れない種類の不親切さで、毎回小一時間ほど消費します。

先日も個人開発中の LINE ミニアプリで、Functions を本番にデプロイしてから疎通確認するまでに **7 つの IAM ロール** を足すことになりました。本記事はそのときに引いた「PERMISSION_DENIED → 何のロールを足すか」の対応表を保存版としてまとめます。

## 状況・前提

- Firebase Cloud Functions（**第 2 世代**、`firebase-functions` v5 以降）
- ランタイム: Node.js 20
- 関数の中身: Firestore 読み書き / Custom Token 発行 / Secret Manager 参照 / 外部 HTTP fetch
- リージョン: `us-central1`（一部 `asia-northeast1`）

第 2 世代の Cloud Functions は実体が **Cloud Run** なので、ロールも Cloud Run 系を含めて多めに必要です。

## 詰まったポイント

### エラーが具体的に何を求めているか分からない

最初に見たログはこれでした。

```
HTTP 500 error
Error: 7 PERMISSION_DENIED: Missing or insufficient permissions.
```

`gcloud` でも `firebase` でも、出るのは「権限が足りない」までで、**何のロールを足せばいいかは教えてくれません**。GCP コンソールの IAM ページを見ても、デフォルトのサービスアカウントには既にいくつかロールが付与されているので、「どれが足りないんだ?」と数十分眺めることになります。

### 7 つのロールの正体と、何を解決するか

私が最終的に付与したのはこの 7 つでした。各々が「どのエラーを消したか」と一緒に表で残します。付与先のサービスアカウントは Functions のデフォルト（`<project-id>@appspot.gserviceaccount.com` または `<project-id>-compute@developer.gserviceaccount.com`）が中心です。

| # | ロール | 解決したエラー / 用途 |
|---|---|---|
| 1 | **Cloud Functions Invoker**（`roles/cloudfunctions.invoker`） | 関数を HTTP で呼べないときの 403。第 2 世代では Cloud Run Invoker と同義 |
| 2 | **Cloud Run Invoker**（`roles/run.invoker`） | 第 2 世代 Functions の HTTP 起動。allUsers に付与で公開、特定 SA に付与で限定公開 |
| 3 | **Cloud Datastore User**（`roles/datastore.user`） | 関数のなかから Firestore を読み書きするときの `7 PERMISSION_DENIED` |
| 4 | **Service Account Token Creator**（`roles/iam.serviceAccountTokenCreator`） | `admin.auth().createCustomToken()` 実行時の `Permission denied on resource project ... to call iam.serviceAccounts.signBlob` |
| 5 | **Secret Manager Secret Accessor**（`roles/secretmanager.secretAccessor`） | `defineSecret()` で取り込んだシークレットを `.value()` で読むときの権限 |
| 6 | **Logs Writer**（`roles/logging.logWriter`） | `console.log` の出力が Cloud Logging に届かないときの抜け穴 |
| 7 | **Firebase Admin SDK Service Agent**（`roles/firebase.sdkAdminServiceAgent`） | Firebase Admin SDK の各種オペレーションを叩くための包括ロール |

### 切り分けのコツ

エラーログを見て、どのカテゴリの権限不足かをまず分類します。

```
500 / PERMISSION_DENIED が出た
├─ メッセージに "signBlob" or "createCustomToken" が含まれる
│   └─ Service Account Token Creator が足りていない
├─ メッセージに "datastore" or "firestore" が含まれる
│   └─ Cloud Datastore User が足りていない
├─ メッセージに "secretmanager" or "Secret" が含まれる
│   └─ Secret Manager Secret Accessor が足りていない
├─ HTTP 起動で 403 が返る（関数本体に到達しない）
│   └─ Cloud Run Invoker が足りていない
└─ Cloud Logging Explorer に何も出ない
    └─ Logs Writer が足りていない
```

このフローで切り分ければ、ロールの当てずっぽうが減ります。

## 解決手順

### gcloud コマンドで一括付与

GCP コンソールの IAM 画面で 1 個ずつポチポチ付けてもよいですが、再現性を上げるためコマンドにまとめておくのがおすすめです。

```bash
PROJECT_ID="your-project-id"
SA="${PROJECT_ID}@appspot.gserviceaccount.com"

for ROLE in \
  roles/cloudfunctions.invoker \
  roles/run.invoker \
  roles/datastore.user \
  roles/iam.serviceAccountTokenCreator \
  roles/secretmanager.secretAccessor \
  roles/logging.logWriter \
  roles/firebase.sdkAdminServiceAgent
do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:$SA" \
    --role="$ROLE"
done
```

### Secret ごとの個別付与

Secret Manager は **Secret 単位** でアクセス制御できます。プロジェクトレベルで付与せず、必要な Secret のみに付与する運用にしたい場合は次の通りです。

```bash
gcloud secrets add-iam-policy-binding LINE_CHANNEL_ID \
  --member="serviceAccount:$SA" \
  --role="roles/secretmanager.secretAccessor"
```

`firebase functions:secrets:set` で作った Secret は、本来 `firebase deploy` のタイミングで自動的に Function 側のサービスアカウントへアクセス権が付くはずですが、**Secret を CLI で先に作って Function があとからそれを参照** する順番にすると、付与が漏れる場合がありました。手で当てておくと安全です。

### 検証

付与後、すぐに反映されるとは限りません。私は **2 〜 3 分待ってから関数を再度叩き直す** のが一番確実でした。`gcloud functions describe <name> --gen2` で `serviceAccountEmail` を確認できるので、実際に動いている SA に付与しているかの取り違えだけは先に潰しておきます。

## 学び・余談

`PERMISSION_DENIED` は GCP からの「何かが足りない」という最低限の挨拶でしかなく、**何が足りないかはほぼ自分で当てに行くしかない** のがしんどいところです。今回の収穫は 2 つあって、ひとつは「7 つのロール」というセット感で覚えておけば、新しいプロジェクトを立ち上げるときに最初から付与しておけることです。もうひとつは「**第 2 世代 Functions は Cloud Run なので、Cloud Run のロールも要る**」というメンタルモデル。これがあるとロールを探しに行く先が半分に絞れます。

エラーが出るたびに IAM 画面を眺めるのではなく、最初の `firebase deploy` の前にこの 7 つを一気に付与しておくのが、結局いちばん工数が少なかったです。

## 関連記事

- [#3 LINE LIFF の ID トークンを Firebase Custom Token に変換する認証フロー実装](/blog/03-liff-firebase-custom-token/)
- [#10 LINE Webhook の「検証」が初回必ず失敗する理由とコールドスタート対策](/blog/10-line-webhook-cold-start/)

## 参考

- [Firebase 公式: Cloud Functions の IAM](https://firebase.google.com/docs/functions/manage-functions?hl=ja)
- [GCP 公式: Cloud Run IAM ロール](https://cloud.google.com/run/docs/reference/iam/roles)
- [GCP 公式: Secret Manager のアクセス制御](https://cloud.google.com/secret-manager/docs/access-control)

---


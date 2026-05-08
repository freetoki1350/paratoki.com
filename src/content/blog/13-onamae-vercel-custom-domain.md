---
title: "お名前.com で取得したドメインを Vercel に CNAME 接続する完全手順（2026 年版）"
description: "個人で取得済みのお名前.com ドメインのサブドメインを Vercel にカスタムドメインとして紐付ける手順を、画面項目名・反映時間・SSL 自動発行・LIFF Endpoint 反映までセットで解説。"
publishDate: 2026-05-15
tags: [Vercel, お名前.com, DNS, カスタムドメイン, LIFF]
series: "LINE ミニアプリ開発記"
seriesNo: 13
draft: false
---

個人開発で「とりあえず Vercel が振ってくる `*.vercel.app` で公開した」までは早いのに、**カスタムドメインに接続するところでつまずく** という人は多いと思います。私もそうで、お名前.com の DNS 設定画面と Vercel の Domain 画面を行き来しながら、何回もタブを閉じて開き直してました。

本記事は、お名前.com で既に取得済みのドメインの **サブドメイン** を、Vercel のプロジェクトにカスタムドメインとして紐付けるまでの最短手順を、画面項目名と所要時間つきでまとめます。LIFF の Endpoint URL に反映するところまでを終端にしているので、LINE ミニアプリの公開準備にもそのまま使えます。

## 状況・前提

- ドメイン: お名前.com で取得済み（例: `example.com`）
- アプリのサブドメイン: 例 `app.example.com`
- ホスティング: Vercel（Hobby プラン）
- 想定: トップドメイン（`example.com`）は別の用途で使い、サブドメインを LIFF アプリに当てる

トップドメインそのものを Vercel に当てる場合は手順が少し違います（`A` レコードを Vercel の固定 IP に向ける）。本記事はサブドメイン用の `CNAME` ルートのみ扱います。

## 全体の流れ

```
[1] Vercel 側で「使いたいドメイン名」を Project に追加する
    └─ 「DNS の設定がまだ」と注意が出る
       ↓
[2] お名前.com 側で CNAME レコードを 1 行追加
    └─ 値は cname.vercel-dns.com.
       ↓
[3] DNS 反映を待つ（数分〜数時間）
    └─ Vercel の Domain ステータスが "Valid Configuration" に
       ↓
[4] SSL が自動発行される
    └─ https でアクセスできるようになる
       ↓
[5] LIFF の Endpoint URL を本番ドメインに更新
    ★ 公開準備完了
```

順番が大事で、Vercel 側の追加を後回しにすると DNS 反映後にもう一度待ち時間が発生します。Vercel から先、が時短です。

## 詰まったポイント

### 詰まり 1: トップドメインとサブドメインで設定が違う

最初は「お名前.com 側でドメインを Vercel の DNS に丸ごと預ける（ネームサーバ変更）」が必要なのかと思って、無関係なヘルプを 1 時間読みました。サブドメインだけなら **CNAME を 1 行足すだけ** で済みます。

| 紐付け方 | お名前.com 側でやること | こんなときに使う |
|---|---|---|
| サブドメインだけ Vercel | CNAME を 1 行追加（推奨） | トップドメインを別の用途にも使いたい |
| ドメイン丸ごと Vercel | ネームサーバを Vercel のものに変更 | トップドメインも Vercel が管理してよい |
| トップドメインを Vercel に紐付け（CNAME 不可） | A レコードを Vercel の固定 IP に向ける | トップドメイン直で配信 |

個人開発で技術ブログを別のドメインに置きたい場合は、**サブドメインだけ Vercel** が一番扱いやすいです。

### 詰まり 2: お名前.com の画面が分かりにくい

お名前.com の DNS 設定は、ナビゲーションが多段で、結局どこに来ればいいのか迷子になる作りでした。私のたどり着いた経路はこれです。

```
お名前.com Navi にログイン
  └─ ドメイン一覧 → 対象ドメインの行
     └─ 「DNS」タブ → 「DNS レコード設定」または「DNS 関連機能の設定」
        └─ 該当ドメインを選んで「次へ」
           └─ 「DNS レコード設定を利用する」を選んで「設定する」
              └─ ここで CNAME レコードを 1 行追加
```

毎回ボタン名が微妙に違うことがあるので、**「DNS レコード設定」と書かれた最終画面に到達する** ことだけ覚えておけば動けます。

### 詰まり 3: 値の末尾のドットを忘れて反映待ちで詰まる

CNAME レコードの値は `cname.vercel-dns.com.` です。**末尾のドット** を忘れると相対 FQDN 扱いになり、自分のドメインが補完されて意味不明な値になります。お名前.com の入力欄は末尾のドットを自動補完してくれることが多いですが、入れた状態で保存しておくのが安全です。

## 解決手順

### Step 1: Vercel 側でドメインを追加

Vercel ダッシュボード → 対象 Project → Settings → **Domains** → `Add` →

```
app.example.com
```

を入れて確定。「DNS の設定がまだ」という旨の警告と共に、必要な CNAME 値が表示されます。

```
Type: CNAME
Name: app
Value: cname.vercel-dns.com.
```

### Step 2: お名前.com の DNS レコード設定で CNAME を追加

お名前.com Navi → ドメイン → 対象ドメイン → DNS → DNS レコード設定:

| ホスト名 | TYPE | TTL | VALUE |
|---|---|---|---|
| `app` | CNAME | 3600 | `cname.vercel-dns.com.` |

「追加」→「確認画面」→「設定する」で確定します。

### Step 3: 反映を待つ

体感では 20 〜 30 分で反映されました。`dig app.example.com CNAME +short` で確認できます。

```bash
$ dig app.example.com CNAME +short
cname.vercel-dns.com.
```

これが出れば DNS は通っています。

### Step 4: Vercel で「Valid Configuration」を確認

Vercel の Domains ページに戻ると、`Valid Configuration` の緑チェックに変わっているはず。同時に SSL 証明書が自動発行され、`https://app.example.com` でアクセス可能になります。

### Step 5: LIFF の Endpoint URL を更新

LINE Developers Console → 該当の LINE ログインチャネル → LIFF タブ → 該当 LIFF アプリ → **エンドポイント URL** を `https://example.com` から `https://app.example.com` に更新。

更新後、LINE 公式アカウントのリッチメニューを開き直すと、新しい URL に飛ぶようになります。

## 学び・余談

DNS 周りは「動かないときに何を見ればよいか」のチェックリストを 1 度作っておくと、次のドメイン追加が一気に短くなります。私のチェックリストはこれです。

```
[ ] Vercel 側にドメインが追加されているか
[ ] CNAME の値が cname.vercel-dns.com. （末尾のドット）か
[ ] CNAME のホスト名が "app" のように相対表記か（`app.example.com` と書いていないか）
[ ] dig コマンドで CNAME が引けるか
[ ] Vercel 側のステータスが "Valid Configuration" か
[ ] https でアクセスできるか
[ ] LIFF Endpoint URL を更新したか
```

このチェックリストで、半年に 1 回しか触らない DNS の手順を全部忘れても、20 分で復習できます。

## 関連記事

- [#7 Vercel デプロイで半日溶かした 4 つの罠](/blog/07-vercel-deploy-traps/)
- [#11 LINE Developers Console の「LINE ログインチャネル」と「Messaging API チャネル」を取り違えた末路](/blog/11-line-channel-mixup/)

## 参考

- [Vercel 公式: Adding & Configuring a Custom Domain](https://vercel.com/docs/projects/domains/add-a-domain)
- [お名前.com 公式: DNS レコード設定](https://help.onamae.com/answer/7883)

---


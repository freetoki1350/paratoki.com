---
title: "Vercel デプロイで半日溶かした 4 つの罠 — Sensitive、ビルドキャッシュ、env スコープ、空文字フォールバック"
description: "Vercel に Next.js を上げる過程で踏んだ 4 つの環境変数まわりの罠を 1 本にまとめた保存版。Sensitive フラグ、ビルドキャッシュ、env スコープ、`new URL(\"\")` の挙動と ?? vs || の使い分け。"
publishDate: 2026-05-09
tags: [Vercel, Next.js, 環境変数, デプロイ]
series: "LINE ミニアプリ開発記"
seriesNo: 7
draft: false
---

Vercel は Next.js のデプロイ先として完成度がとにかく高くて、普段は何も考えずに使えます。ただ、まれに「環境変数まわり」だけはピタッと止まって半日溶かす日があります。原因は単独で見ると小さいのに、組み合わさるとデバッグの方向感を完全に見失わせる、というのがやっかいなところです。

先日も個人開発中の LINE ミニアプリを本番ドメインに乗せる過程で、立て続けに 4 つの罠を踏みました。どれも「自分は引っかからないだろう」と思っていたタイプのもので、まとめて遭遇するとなかなかつらい。本記事はそのときの記録を保存版として 1 本に集約します。同じ症状で詰まった Vercel 利用者の検索クエリにヒットすることを願って書きます。

## 状況・前提

- Next.js 15.5.15（App Router）
- Vercel の Hobby プラン
- 環境変数は 10 本前後（`NEXT_PUBLIC_*` 8 本 + サーバーオンリー 2 本）
- ローカルでは `npm run build && npm start` で動作確認済み
- カスタムドメインを当てた直後にデプロイ、というタイミング

ローカルでは動く、`vercel-app.vercel.app` の自動ドメインでも動く、しかし **カスタムドメイン配下の本番ビルドだけ** で症状が出る、という追い込まれ方をしました。

## 詰まったポイント

### 罠 1: Sensitive デフォルト ON と Development 環境の鍵マーク

Vercel の環境変数設定画面には **Sensitive** というチェックがあります。2026 年 4 月のセキュリティインシデントを受けて、それまでデフォルト OFF だった挙動が **デフォルト ON** に変わりました。新規で env を追加すると、Production と Preview に対しては自動的に Sensitive 扱いになります。

ややこしいのが Development 環境です。設定画面でスコープのチェックボックスを見ると、Development だけ **鍵マークが付いていて選べない** 状態になることがあります。

```
Environments
☑ Production
☑ Preview
🔒 Development        ← この鍵マーク
```

最初は「Hobby プランの制限かな?」と疑ったのですが、これは **Sensitive と Development の組み合わせが Vercel API レベルで禁止されている** ための表示でした。Sensitive な env は Production / Preview / カスタム環境のみで作れて、Development では作れない、というのが仕様です。

挙動の整理:

```
env を追加するときの組み合わせ
  ├─ Sensitive ON × Production       ✅
  ├─ Sensitive ON × Preview          ✅
  ├─ Sensitive ON × Development      ❌（鍵マークで選択不可）
  ├─ Sensitive OFF × Production      ✅
  ├─ Sensitive OFF × Preview         ✅
  └─ Sensitive OFF × Development     ✅
```

私が踏んだのは、**Production / Preview に Sensitive で登録したつもりが、Development に同じ値が入っていない** というズレでした。Web UI で env 追加時、Sensitive のままだと Development のチェックは灰色になっていて押せない。気付かずに「Save」で確定すると、Development だけ未登録のまま残ります。

ローカルで `vercel env pull` を打って `.env.local` を作っても、Development の値が空なので、`npm run dev` 起動時に「必須の環境変数が未設定です」が再現するという流れでした。Production が動いていただけに、ローカルが落ちている理由になかなか気付けませんでした。

**対策**:

- Development でも同じ env を使いたいときは、Sensitive を **明示的にオフ** にしてから 3 スコープ全部にチェックを入れる
- もしくは Development 用には別途 Sensitive オフで同名の env を追加する（値の管理は二重になる）
- 公開してよい値（`NEXT_PUBLIC_*` など）は Sensitive にする必要がそもそも薄いので、オフ運用がシンプル
- 真に秘匿したい値は `NEXT_PUBLIC_` を付けずサーバーオンリーにし、Development では `.env.local` に手で書く

Sensitive の値はダッシュボードから後で見られないので、タイポを後追いで確認するのが面倒、という二次被害もありました。値の元ネタは別途パスワードマネージャー等に控える運用がおすすめです。

### 罠 2: ビルドキャッシュで古い env が貼り付いたまま

env を直して再デプロイしても症状が変わらない、というケース。Vercel はビルドのインクリメンタルキャッシュを効かせるため、ソース差分がない再デプロイだと **以前の env の値で焼き込まれた成果物が再利用される** ことがあります。

確認の仕方:

```
Vercel Dashboard → Deployments → 該当ビルド → Build Logs
  └─ 上のほうに "Restored build cache from previous deployment" と出ている
```

**対策**: env を変えたあとは Deployments 画面の右上の `…` メニューから **Redeploy** を選び、ダイアログ内の **Use existing Build Cache のチェックを外して** 再デプロイ。あるいは CLI で `vercel --force`。これで env 変更が確実に反映されます。

### 罠 3: env スコープを Production だけに入れていた

Vercel の env には **Production / Preview / Development** の 3 スコープがあります。Web UI の入力フォームでは 3 つともデフォルトでチェックが入っているのですが、CLI（`vercel env add`）で追加すると一度に 1 スコープしか登録されません。

私は CLI で Production だけに入れたあと、main 以外のブランチを push して Preview 環境で動作確認しようとしたところ、Preview ビルドだけ落ちました。

**対策**: env を入れたら **3 スコープすべてに同じ値が入っているか** を Vercel 設定画面で確認する。ステージング差分のあるキー（API エンドポイントなど）は意図的にスコープごと値を変える。Web UI で操作すれば 3 つ揃ってチェックが入るので、CLI を使わない運用のほうが事故は少ないです。

### 罠 4: 空文字フォールバックで `new URL("")` が爆発

これが一番たちが悪いです。`app/layout.tsx` で `metadataBase` を組み立てるためにこんなコードを書いていました。

```ts
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://vaccine-note-line.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  // ...
};
```

`??`（Nullish Coalescing）は **null / undefined のときだけ** フォールバックします。Vercel で env を「設定はしてあるが値が空」にしてしまうと、`process.env.NEXT_PUBLIC_SITE_URL` は undefined ではなく **空文字 `""`** が返ります。`?? "..."` は空文字を許容するため、`new URL("")` が走り `TypeError: Invalid URL` でクラッシュ。

```
process.env.NEXT_PUBLIC_SITE_URL の中身
  ┌─ env 未定義 ........... undefined  → ?? のフォールバックが効く ✅
  ├─ env あり値あり ........ "https://..." → そのまま使う ✅
  └─ env あり値なし（空文字） ""           → ?? は素通り ❌ → new URL("") が爆発
```

**対策**: 空文字も弾きたいときは `??` ではなく `||` を使う。

```ts
const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL || "https://vaccine-note-line.vercel.app";
```

`||` は falsy（空文字含む）でフォールバックするので、空文字も拾えます。「数値の 0 を意図的に許可したい」みたいな状況以外、env のフォールバックは `||` のほうが安全です。あるいは事前に `env.trim()` でガードする。

## まとめ（チェックリスト）

Vercel に Next.js を上げてうまく動かないとき、env 系で疑う順序を私はこう固定しています。

```
[ ] NEXT_PUBLIC_* の Sensitive はオフか
[ ] 直近のデプロイは Build Cache を使っていないか
[ ] env が Production / Preview / Development の 3 スコープすべてに入っているか
[ ] env のフォールバックは ?? ではなく || で書かれているか
[ ] env に空文字や余分なスペースが入っていないか
```

## 学び・余談

4 つの罠はどれも独立して見れば「公式ドキュメントに書いてあること」「JavaScript の仕様どおり」のものです。それが組み合わさると、ローカルで再現できないバグになって半日溶かす。個人開発で半日というのは精神的にもなかなかこたえる時間でした。

教訓は身も蓋もなくて、**env まわりは「素朴に動いてくれるだろう」と思わずに、設定値が実際にビルドへ流れた経路をそのつど確認する**、これに尽きます。Build Logs を毎回開く癖をつけてからは、同じ罠を踏まなくなりました。

## 関連記事

- [#6 Next.js で `process.env[varName]` が undefined になる罠](./06-nextjs-process-env-dynamic.md)
- [#13 お名前.com で取得したドメインを Vercel に CNAME 接続する完全手順](./13-onamae-vercel-custom-domain.md)

## 参考

- [Vercel 公式: Environment Variables](https://vercel.com/docs/projects/environment-variables)
- [Vercel 公式: Sensitive Environment Variables](https://vercel.com/docs/projects/environment-variables/sensitive-environment-variables)
- [Next.js 公式: Environment Variables](https://nextjs.org/docs/app/building-your-application/configuring/environment-variables)

---

## 執筆メモ（公開前に削除）

### ファクト未確認箇所

- 罠 1 の Sensitive 仕様: 2026-05-08 著者確認済（Vercel 公式ドキュメント参照）。2026 年 4 月のセキュリティインシデント以降、Sensitive はデフォルト ON。Development では Sensitive 不可（鍵マーク表示）
- 罠 2 のビルドキャッシュ表記: ダッシュボード UI の文言（「Restored build cache from previous deployment」）は実ログで確認
- 罠 3 の CLI 挙動: `vercel env add` のデフォルトスコープ動作の最新確認
- 「半日溶かした」「立て続けに 4 つ」の体感は著者の実体験に合わせて微修正

### ユーザー追記推奨箇所

- 各罠を踏んだときの心理状態の一文（特に罠 4 の「これが一番たちが悪い」のあとに気付きの瞬間を 1 文）
- ビルドログのスクショ抜粋（罠 2）
- 自分が実際に使っているチェックリストとの差分

### 引用元

- `vaccine-note-line/app/layout.tsx`（罠 4 の実コード）
- `vaccine-note-line/app/sitemap.ts`（同パターンの別箇所）
- `vaccine-note-line/lib/env.ts`（env 定義）
- 想定文字数: 2,000〜2,500 字 → 本文約 2,800 字（やや超過、推敲時に削る余地あり）

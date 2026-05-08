/**
 * 連載の全話タイトル定義。
 * 公開済みかどうかは Astro の content collection 側で判定するため、
 * ここには「予告込みの全話タイトル」のみを並べる。
 */

export interface SeriesEntry {
  no: number;
  title: string;
}

export const seriesIndex: Record<string, SeriesEntry[]> = {
  "LINE ミニアプリ開発記": [
    { no: 1, title: "LINE で動くミニアプリを個人開発した記録 — 構想・収益モデル・技術スタック選定の裏側" },
    { no: 2, title: "LINE LIFF + Firebase + Vercel で月額 0 円運用するためのアーキテクチャ全体図" },
    { no: 3, title: "LINE LIFF の ID トークンを Firebase Custom Token に変換する認証フロー実装" },
    { no: 4, title: "Firestore の階層設計でセキュリティルールを劇的にシンプルにする方法" },
    { no: 5, title: "Firestore 複合インデックスを忘れて「すべて完了しました」と誤表示された話" },
    { no: 6, title: "Next.js で process.env[varName] が undefined になる罠 — 静的置換の仕組みと対策" },
    { no: 7, title: "Vercel デプロイで半日溶かした 4 つの罠 — Sensitive、ビルドキャッシュ、env スコープ、空文字フォールバック" },
    { no: 8, title: "Cloud Functions のサービスアカウント権限地獄を脱出するまで — 7 つの IAM ロールの正体" },
    { no: 9, title: "AuthGate のエラーが握りつぶされて画面が無限ローディングになっていた話" },
    { no: 10, title: "LINE Webhook の「検証」が初回必ず失敗する理由とコールドスタート対策" },
    { no: 11, title: "LINE Developers Console の「LINE ログインチャネル」と「Messaging API チャネル」を取り違えた末路" },
    { no: 12, title: "LINE 公式アカウントで日次リマインダー Push を実装する — Cloud Functions cron + 月 200 通制限への対策" },
    { no: 13, title: "お名前.com で取得したドメインを Vercel に CNAME 接続する完全手順（2026 年版）" },
    { no: 14, title: "Cloud Scheduler が「成功」と言うのに通知が届かない時に確認すべき 3 つのこと" },
    { no: 15, title: "個人開発で医療系アプリのプライバシーポリシー・利用規約を書くときの最低ライン" },
  ],
};

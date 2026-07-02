# Renderでネット公開する手順

このアプリはRenderのWeb Serviceとして公開できます。

## 1. GitHubにアップロード

1. GitHubで新しいリポジトリを作成
2. このフォルダの中身を全部アップロード
3. `package.json`, `server.js`, `public/`, `render.yaml` がリポジトリ直下にある状態にする

## 2. RenderでWeb Serviceを作成

1. Renderにログイン
2. `New` → `Web Service`
3. GitHubリポジトリを接続
4. 下の設定にする

```text
Name: snow-mansion-werewolf
Runtime: Node
Build Command: npm install
Start Command: npm start
```

環境変数は必要に応じて以下を設定します。

```text
NODE_VERSION=20
```

## 3. 公開URLを開く

デプロイが完了すると、Renderから以下のようなURLが発行されます。

```text
https://snow-mansion-werewolf.onrender.com
```

このURLをスマホで開けば参加できます。

## 4. 遊び方

1. ホストが公開URLを開く
2. 部屋を作成する
3. 参加URLまたは部屋コードを共有する
4. 各プレイヤーが自分のスマホから参加する

## 注意

- 無料プランでは、しばらくアクセスがないとサーバーがスリープすることがあります。
- スリープ後の初回アクセスは起動に少し時間がかかります。
- 部屋情報はサーバーのメモリに保存しているため、サーバー再起動時に消えます。

# 9router-cli

CLI for the 9router admin API (combos, providers, models, probe)

## Install

- release のバイナリを `install.sh` で入れる。checksum が合わなければ入れずに止まる

```sh
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/9router-cli/main/install.sh | sh
```

- tag を固定するなら env は `sh` の側に付ける。`curl` の側に付けると install.sh に届かず latest が入る

```sh
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/9router-cli/main/install.sh | NINE_ROUTER_CLI_VERSION=v0.1.0 sh
```

- `NINE_ROUTER_CLI_VERSION` の既定は latest。latest は最初に 1 回だけ tag に解決し、バイナリも `SHA256SUMS` もその tag から取る
- `NINE_ROUTER_CLI_INSTALL_DIR` で置き場所を変える (既定は `$HOME/.local/bin`)
- `NINE_ROUTER_CLI_VERIFY_ATTESTATION=1` で provenance も `gh` で検証する。`gh` が無い・検証が通らないときは入れずに止まる
- 手で取るなら [Releases](https://github.com/TakashiAihara/9router-cli/releases) の `9router-cli-<os>-<arch>` と `SHA256SUMS` を使う。os は `linux` / `darwin`、arch は `x64` / `arm64`
- 対応する release が無い間は、clone して `bun install && bun run start -- --help`

## 設定

- 接続先と秘密は env か設定ファイルで渡す。env が先で、無ければ設定ファイルを読む
- 秘密は argv にも出力にも載せない

### env

| 変数 | 内容 |
| --- | --- |
| `NINE_ROUTER_URL` | 9router の URL。`http://` か `https://` で始める。既定の接続先は持たない |
| `NINE_ROUTER_DASHBOARD_PASSWORD` | dashboard のパスワード。`combos` / `providers` / `usage` と、`probe --combo` / `--all-combos` が使う |
| `NINE_ROUTER_API_KEY` | endpoint の API key。`models` と `probe` が使う |
| `NINE_ROUTER_ADMIN_TIMEOUT` | 管理 API・`models`・`version` の 1 リクエストあたりの時間切れ (秒)。既定は `20` |
| `NINE_ROUTER_COMMAND_TIMEOUT` | 設定の `*_command` の時間切れ (秒)。既定は `60` |

時間切れの 2 つは正の秒数だけ受け付ける。`abc` や `0` は通信する前に exit 2 で、変数名を示す

### config.toml

- 置き場所は `$XDG_CONFIG_HOME/9router-cli/config.toml`。`XDG_CONFIG_HOME` が空なら `~/.config/9router-cli/config.toml`
- 値はすべて文字列
- `*_command` は `sh -c` で実行し、標準出力 1 行を秘密として使う。env に値があればそちらが先で、command は走らない

```toml
url = "https://router.example.com"
api_key_command = "infisical run --silent -- printenv NINE_ROUTER_API_KEY"
dashboard_password_command = "infisical run --silent -- printenv NINE_ROUTER_DASHBOARD_PASSWORD"
```

| key | env の代わりになるもの |
| --- | --- |
| `url` | `NINE_ROUTER_URL` |
| `api_key_command` | `NINE_ROUTER_API_KEY` |
| `dashboard_password_command` | `NINE_ROUTER_DASHBOARD_PASSWORD` |

- `infisical run ...` は例。値を標準出力に 1 行返すコマンドなら何でもよい (`pass show` / `op read` など)
- command が非 0 で終わる・空を返す・複数行を返す・時間内に返らないときは、使わずに exit 2 で止まる
- command は自分のプロセスグループで走るので、時間切れでも Ctrl-C でも、command とそれが起動した子ごと止まる (孤児を残さない)
- `infisical` の login や `9router` の応答が遅いときは、`NINE_ROUTER_COMMAND_TIMEOUT` で command の時間切れを延ばす

```sh
NINE_ROUTER_COMMAND_TIMEOUT=180 9router-cli models
```

## 定期メンテナンス

`NINE_ROUTER_URL` に接続先を設定してから使う。たとえば `https://9router.takashiaihara.site`。管理操作には dashboard パスワード、`models` と `probe` には endpoint API key が必要。

```sh
9router-cli providers list
9router-cli providers test PROVIDER_ID
9router-cli providers set PROVIDER_ID --inactive
9router-cli providers set PROVIDER_ID --name backup --priority 2 --active
9router-cli providers set PROVIDER_ID --key-env NEW_PROVIDER_KEY
9router-cli providers add openrouter --key-env NEW_PROVIDER_KEY --name backup
9router-cli providers delete PROVIDER_ID

9router-cli models --prefix kr
9router-cli probe kr/model-name --combo free-forever
9router-cli probe --all-combos --json
9router-cli combos list
9router-cli combos set free-forever kr/model-name oc/model-name
9router-cli combos set new-combo kr/model-name --create
9router-cli combos delete new-combo
9router-cli version
```

`PROVIDER_ID` は `providers list` の先頭列にある接続 ID に差し替える。`providers set` / `delete` / `test` はその ID で対象を絞る。列は ID / provider / name / authType / isActive / testStatus / errorCode / lastError / expiresAt / locks。`expiresAt` が過去の oauth 接続と `testStatus` が `error` / `unavailable` の行が、認証切れの候補。

- `providers set` は ID / provider / name / isActive / priority の 5 列を返す (list / add / set のいずれも token・email・clientSecret は出さない)
- `name` の伏せ方は `authType` で分ける。`apikey` の `name` は利用者が `--name` で選んだ表示名なので、`@` を含んでいても伏せない。`oauth` の接続は `name` が本人の email として入るので、`@` を含むときだけ `-` にする。`authType` が無い・`null`・`apikey` 以外の値 (9router が将来増やす型を含む) の接続は email かもしれないので、`@` を含む `name` は同様に `-` にする。`providers add` は apikey の接続しか作らないので、応答の `authType` が無くても `--name` をそのまま出す
- `providers set --key-env` は API key 型の接続にだけ使える。0.5.91 の管理 API は `authType` が `apikey` 以外だと **200 を返して新しい鍵を黙って捨てる** ので、CLI は接続の型を GET で確かめてから書き、送らずに exit 2 で止める。止まったときは他の項目も書かないので、`--key-env` を外せば名前・優先度・有効状態だけの編集はできる
- `providers test` は接続単体の検証 (`valid` で 0 / 1 を分ける)。`probe` はモデルと combo を実際に呼ぶ検証。期限切れや提供終了モデルを調べるときは `probe --all-combos` の結果で失敗した段を確認し、`combos set` で差し替える
- `providers delete` と `combos delete` は確認を挟まず即削除する。取り消しはダッシュボードでの手作業。ID を間違えると復元できないので、`providers list` の ID を写してから実行する

`combos set` は段を全置換する。同じ combo を複数ホストから同時に更新すると、後の更新が先の更新を上書きすることがある。`combos set` / `providers set` が出す値は依頼した値ではなく、サーバが保存したと返した値 (`combos set` は `after`、`providers set` は各列、`combos set --create` も作成応答)。

`version` は認証なしで、本体の版と更新の有無を出す。上流が npm に届かず最新版を確認できなかったときは、2 列目が `unknown` になる。「更新なし」とは読めない。`--json` は応答をそのまま返すので、その場合は `latestVersion` が `null` のまま分かる

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | 相手が否と答えた。`probe` の NG、`providers test` の NG、管理 API のエラー、`version` のエラー |
| 2 | 使い方・秘密・設定・通信の誤り。`login` と `models` の失敗も、status を問わずここ |
| 70 | 想定外の例外。応答の形が想定と違うときなど。1 と 2 のどちらにも見せないため別の値 |

`providers set --key-env` を `apikey` 以外の接続に当てたときの exit 2 は、書き込みをせずに止めたためのもの。9router なら 200 を返して新しい鍵を黙って捨てるので、拒んだのは CLI 側の判定になる。

9router の手前に proxy があると、届かなかったときに 502 / 503 / 504 が HTML のエラーページで返る。HTTP の応答としては届くので、`9router` が否を答えた (exit 1) と区別する。status が 502 / 503 / 504 で本文が HTML のときは、届かなかった通信の失敗 (exit 2) として扱い、HTML は stderr に出さない。同じ status でも本文が JSON なら相手の返答なので exit 1 のまま。

## 開発

```sh
bun install
bun run check
```

### release

- main に入って CI が通った commit は、すべて `vX.Y.Z-rc.N` として自動で release になる。tag が 1 つも無いときは `package.json` の version から `v<version>-rc.1` を始める
- 「最新版」は GitHub が Latest にしている release の tag。`install.sh` の既定が引くのもそれで、main の先頭でない commit の release は Latest にしない
- 確定版は `vX.Y.Z` の tag を手で push する。release の前に `bun run check` が回り、通らなければ release しない
- 古い commit (main の先頭でない commit) に tag を手で push するなら、公開済みの release の tag (`vX.Y.Z` / `vX.Y.Z-rc.N`、数を 0 始まりにせず 9 桁までにした形) のうち最も高いもの以下の版番号に限る。それより高い版番号は、main から出た次の release が出るまで「最も新しい版」として読まれるので公開しない。release の無い tag (拒否された tag や draft) はこの上限に含まれない
- 拒否されたときの対処は 2 つ。tag を切った時に main の先頭で、その run の間に main が進んだなら、main が出す次の rc の release がその tag より上になったあとで `workflow_dispatch` する。それ以外は tag を消す (`git push origin :refs/tags/v0.2.0`)。消さないと次の run にも同じ tag が見える。とくに main の自動 rc の版番号は release の有無を問わず git の tag 全部から決まるので、残った tag は次の rc をその上まで押し上げ、その後は dispatch でこの上限を通ってしまう
- main の自動 rc の run は、tag を決めた後で main が進んでいれば何も公開しない。緑のまま終わるので、理由が run summary に `::notice::` として出る
- Actions の `workflow_dispatch` は、既に push 済みの tag を release し直すためのもの。新しい tag は切れない。上の版番号の制限も通り、その release が既にあれば再実行としてそのまま通る
- 公開済みの release は上書きしない。同じ tag の再実行で `SHA256SUMS` が同じなら何もせず成功、違えば落ちる。draft のまま、または資産が欠けている release は成功と見なさない
- tag は release の前に API で先に作る。作れなかったのは同名の tag が既にあり、その tag が別の commit を指すときで、その場合は release を作らず止まる (tag を消して送り直すか、次の tag を切る)。同じ commit を指す tag (落ちた run の再実行) なら、そのまま release を作る
- バイナリは 4 つとも形と埋め込んだ tag を検査してから、release する
- バイナリの `--version` は release の tag と同じ (`v` を除く)

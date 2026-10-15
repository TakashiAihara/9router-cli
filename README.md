# 9router-cli

CLI for the 9router admin API (combos, providers, models, probe)

## Install

- release のバイナリを `install.sh` で入れる。checksum が合わなければ入れずに止まる

```sh
curl -fsSL https://raw.githubusercontent.com/TakashiAihara/9router-cli/main/install.sh | sh
```

- `NINE_ROUTER_CLI_VERSION=v0.1.0` で tag を固定する (既定は latest)
- `NINE_ROUTER_CLI_INSTALL_DIR` で置き場所を変える (既定は `$HOME/.local/bin`)
- `NINE_ROUTER_CLI_VERIFY_ATTESTATION=1` で、`gh` があれば provenance も検証する
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

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 成功 |
| 1 | 相手が否と答えた。`probe` の NG、管理 API のエラー、`version` のエラー |
| 2 | 使い方・秘密・設定・通信の誤り。`login` と `models` の失敗も、status を問わずここ |
| 70 | 想定外の例外。応答の形が想定と違うときなど。1 と 2 のどちらにも見せないため別の値 |

## 開発

```sh
bun install
bun run check
```

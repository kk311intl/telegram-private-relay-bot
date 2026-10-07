# Telegram Private Relay Bot

[中文](#zh) · [日本語](#ja) · [English](#en)

Version: v1.3.1 · License: [GPL-3.0-only](LICENSE)

<a id="zh"></a>

## 中文

轉送 Telegram 私訊，讓管理者透過 Bot 回覆。可選擇話題模式（Topic，每位使用者一個話題）或管理者私訊模式。使用 Cloudflare Workers 與 D1，無需常駐主機。

### AI 部署提示詞

把倉庫連結和以下提示詞交給能讀取檔案、執行命令的 AI 程式助理。登入、BotFather 操作和安全輸入仍由你完成。

> 我沒有程式經驗。請閱讀 README，直接帶我部署這個 Telegram 私訊轉送 Bot。由你處理檔案、命令、本機設定與驗證；我只做登入、BotFather、授權及安全輸入。每次說明我需要做的一個操作，確認結果後繼續。
>
> 先檢查作業系統、Node.js 24 以上、pnpm、Windows 的 PowerShell 7，以及 Cloudflare／Telegram 準備狀態。只問缺少的選項：新建或沿用部署、固定語言 `zh`／`ja`／`en`、話題模式或管理者私訊模式。歡迎、封鎖、節流、無法轉送提示，以及訊息間隔和清理排程可自訂；未指定就用安全預設。缺少工具時先引導我安裝。
>
> 使用我的 Worker、D1 和 Bot，透過 `tools/` 安全取得管理者與群組 ID。依下方流程完成依賴、測試、`wrangler.jsonc`、`vars.BOT_LANGUAGE`、資料庫遷移、Secrets／Variables 和 Worker 部署。新部署確認 `/ready` 成功後才註冊 Webhook；既有部署先辨識資源、備份 D1，再沿用原設定和憑證。
>
> 遵守下方公開內容規則。Token 僅透過本機安全輸入或 Secret 欄位處理，不放入聊天、輸出或 Git；私有資料留在受 Git 忽略的位置。未經我要求，不覆寫既有設定、重建資源、輪替憑證、刪除還原備份、改寫程式、推送 GitHub 或建立 Release／tag。
>
> 最後檢查 `/health`、`/ready`、Webhook 和安全探針，指導我用非管理者帳號完成私訊往返測試。管理者私訊 `/start` 設定選單，再用 `/status` 確認；清除功能只用測試帳號。遇到阻礙時說明原因及下一個操作，不把未驗證項目當作完成。交付 Bot 連結、Worker 網址、模式、語言、驗證結果與憑證保管位置，不顯示秘密值。

### 準備

- Node.js 24 以上、pnpm、Cloudflare 帳號和 Telegram Bot Token；Windows 腳本另需 PowerShell 7。本機測試使用 [--test-isolation](https://nodejs.org/api/cli.html#--test-isolationmode) 與 `node:sqlite`。
- 話題模式需要啟用話題的超級群組，Bot 須有傳送訊息及管理話題權限。
- `tools/*.ps1` 使用 Windows DPAPI 儲存本機加密憑證，只能由同一 Windows 使用者環境解密，不能當作跨機可攜的憑證。其他系統可直接使用 Wrangler 並自行安全管理 Token。

### 部署

以下是**新部署**流程，在工程目錄的 PowerShell 7 執行；不要直接套用到既有部署。更新既有 Bot 時，先備份 D1、沿用原設定與憑證、套用尚未執行的 資料庫遷移，再用 `--keep-vars` 部署。不要重新建立 D1，也不要為更新文件而重新註冊 Webhook 或輪替 Secret。

```powershell
pnpm install --frozen-lockfile
pnpm run check
if (-not (Test-Path -LiteralPath wrangler.jsonc)) {
    Copy-Item wrangler.jsonc.example wrangler.jsonc
}
```

先在 `wrangler.jsonc` 設定自己的 Worker 名稱、D1 名稱及 `vars.BOT_LANGUAGE`（`zh`、`ja` 或 `en`，預設 `zh`）。每個部署固定一種語言，不依使用者的 Telegram 語言切換；不同語言實例使用各自的 Worker、D1、Bot 和 話題管理群組，不共用同一 Bot 的 Webhook。

新 Bot 尚未註冊 Webhook 時，先用自己的 Telegram 帳號私訊該 Bot 傳送 `/id`，再執行 `./tools/Get-TelegramUserId.ps1` 取得並確認自己的數字 `ADMIN_USER_ID`。腳本隱藏輸入 Bot Token、不保存它；若顯示多個候選 ID，請確認哪個帳號是自己。已有 Webhook 的部署則從現有設定取得 ID，不要用 [getUpdates](https://core.telegram.org/bots/api#getupdates)。

```powershell
if (-not (Test-Path -LiteralPath private-credentials/cloudflare-token.dpapi)) {
    ./tools/Save-CloudflareToken.ps1
}
./tools/Test-CloudflareToken.ps1
# 只有新資料庫才執行下一行：
./tools/Invoke-WithCloudflareToken.ps1 d1 create YOUR_D1_NAME
```

把建立資料庫後傳回的 `database_id` 填回 `wrangler.jsonc`，再執行：

```powershell
./tools/Invoke-WithCloudflareToken.ps1 d1 migrations apply BOT_DB --remote --config wrangler.jsonc
./tools/Invoke-WithCloudflareToken.ps1 deploy --keep-vars --config wrangler.jsonc
```

這次先建立 Worker；尚未填齊必要設定時 `/ready` 回傳 503 是預期結果，先不要註冊 Webhook。使用部署命令回傳的 HTTPS 根網址，將下方 `YOUR_WORKER.YOUR_SUBDOMAIN` 換成自己的值；腳本會自行加上 `/webhook`。

Cloudflare API Token 需要該帳戶的 Workers Scripts Edit 和 D1 Edit 權限。加密副本只留在本機 `private-credentials/`；保存腳本不覆寫既有副本，明確更新才加 `-Force`。[keep_vars](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth) 保留控制台中未被設定檔明確覆蓋的變數，不能阻止錯誤設定覆蓋原值。

在 Cloudflare Worker 的 Variables and Secrets 設定：

| 名稱 | 類型 | 說明 |
|---|---|---|
| `BOT_TOKEN` | Secret | 從 BotFather 取得 |
| `WEBHOOK_SECRET` | Secret | 使用下方腳本產生，與註冊 Webhook 使用同一值 |
| `ADMIN_USER_ID` | Text | 管理者的數字 Telegram User ID |
| `ADMIN_GROUP_ID` | Text，可選 | 啟用話題的超級群組 ID；省略則使用管理者私訊模式 |
| `BOT_LANGUAGE` | Text，可選 | `zh`／`ja`／`en`，預設 `zh`；與設定檔 `vars.BOT_LANGUAGE` 一致 |
| `WELCOME_MESSAGE` | Text，可選 | 覆蓋該部署語言的 `/start` 歡迎訊息 |
| `BLOCKED_MESSAGE` | Text，可選 | 覆蓋封鎖使用者收到的提示 |
| `RATE_LIMIT_MESSAGE` | Text，可選 | 覆蓋傳送過快提示 |
| `UNSUPPORTED_MESSAGE` | Text，可選 | 覆蓋訊息無法轉送提示 |
| `MESSAGE_INTERVAL_SECONDS` | Text，可選 | 一般訊息間隔，預設 2 秒，範圍 0–60 |

未設定的提示訊息使用該語言的預設翻譯，自訂文字最多 4096 字元。[清理排程](https://developers.cloudflare.com/workers/configuration/cron-triggers/)在 `triggers.crons` 調整，採 UTC；範例 `17 3 * * *` 是每日 03:17 UTC，不是使用者本機時間。關閉排程也會停用定期清理。

```powershell
if (-not (Test-Path -LiteralPath private-credentials/telegram-webhook-secret.dpapi)) {
    ./tools/New-WebhookSecret.ps1
}
./tools/Copy-WebhookSecret.ps1
# 貼入 Cloudflare 的 WEBHOOK_SECRET、填齊上表並儲存後：
Set-Clipboard $null
./tools/Invoke-WithCloudflareToken.ps1 deploy --keep-vars --config wrangler.jsonc
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/ready'
# /ready 成功後才註冊：
./tools/Register-TelegramWebhook.ps1 -WorkerUrl 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev'
```

最後一個腳本會隱藏輸入 Bot Token，並只訂閱 `message` 和 `edited_message`。已有 Secret 時，`New-WebhookSecret.ps1` 會拒絕覆寫；若要輪替，須同步更新 Cloudflare Secret 和 Telegram Webhook。

不知道群組 ID 時，先省略 `ADMIN_GROUP_ID` 以管理者私訊模式完成部署及 Webhook 註冊，再由管理者在啟用話題的目標群組傳送 `/setup`，把回覆的 ID 填入 `ADMIN_GROUP_ID` 並儲存部署。Webhook 尚未註冊時，也可在群組傳 `/setup` 後執行 `./tools/Get-TelegramChatIds.ps1`。已有 Webhook 時不要用 `getUpdates` 查 ID。

### 使用與指令

使用者私訊 Bot；話題模式由管理者在對應話題回覆，管理者私訊模式須直接回覆 Bot 轉來的訊息。支援文字、可複製的一般媒體、相簿，以及文字／媒體說明的編輯同步，不支援替換媒體。

| 使用位置 | 指令 | 用途 |
|---|---|---|
| 使用者私訊 Bot | `/start`、`/id` | 歡迎訊息、自己的 User ID |
| 使用者私訊 Bot | `/forget`、`/forget confirm` | 查看清除說明、確認清除資料 |
| 管理者私訊 Bot | `/start`、`/help`、`/status` | 設定選單、查指令、查近 24 小時處理狀態與 Webhook 待處理數 |
| 管理者私訊 Bot | `/unblock USER_ID` | 依 ID 解封，包括已清除資料的封鎖者 |
| 管理群組的使用者話題 | `/user`、`/block`、`/unblock`、`/close`、`/help`、`/status` | 查資料、封鎖／解封、關閉話題、查指令／狀態 |
| 管理者私訊模式，管理者回覆轉來的訊息 | `/user`、`/block`、`/unblock` | 操作該訊息所屬的使用者 |

管理權限只認 `ADMIN_USER_ID`；管理者私訊 Bot 傳送 `/start` 設定本人可見的選單，切換模式後可再傳一次。`/close` 只關閉話題，不封鎖使用者；要停止接收該使用者的訊息，請用 `/block`。

### 資料與限制

D1 保存路由所需的 User ID、顯示名稱／使用者名稱、話題／訊息 ID 與處理狀態，不保存訊息文字或媒體本體。管理端會看到使用者基本資料，這不是匿名服務；話題也不是獨立閱讀權限，管理群組只應加入可信任成員。

使用者傳 `/forget` 會先看到確認說明，只有傳 `/forget confirm` 才清除 Bot 的 D1 個人資料、相簿暫存及轉送對照。為防止舊請求重建資料，Bot 暫留不含顯示名稱的控制紀錄；非封鎖者的紀錄會在 7 天後依排程清理。被封鎖者的 ID、封鎖狀態與控制紀錄仍保留，管理者可私訊 Bot 傳送 `/unblock USER_ID` 解封。這**不會刪除 Telegram 兩端已有的聊天訊息或既有備份**；之後的新訊息可能重新建立資料。`/status` 也顯示處理中與處理逾時，但不能替代真人收發測試。

超過 30 天的轉送對照會在下一次排程清理刪除；對照過期後，舊訊息編輯及管理者私訊模式的回覆可能無法路由。若 Telegram 已轉送卻沒有返回結果，重試仍可能重複送達；先核對兩端再決定重送。保存對照失敗時會重試保存，再嘗試撤回副本；兩者都失敗則停止自動重送並提示發送者。

### 驗證與排查

```powershell
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/health'
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/ready'
./tools/Get-TelegramWebhookInfo.ps1
./tools/Test-WorkerRuntime.ps1 -WorkerUrl 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev'
```

`/ready` 檢查設定與 D1 結構，不檢查 Telegram 權限。正式環境探針會送安全的測試更新並清除其 D1 紀錄，但不會驗證 Telegram 實際收發；仍須用非管理者帳號實測「私訊 → 管理端收到 → 管理者回覆 → 使用者收到」。若使用自訂設定檔，探針也須加上 `-Config '你的設定檔路徑'`，以清理正確的 D1。

- `/ready` 回傳 503：核對必填設定、`BOT_DB` 綁定及 資料庫遷移，不要刪除資料庫來修復。
- Webhook 回傳 403：核對 Cloudflare 與 Telegram 使用同一個 `WEBHOOK_SECRET`，不要直接重產 Secret。
- 收不到訊息或選單不完整：查看 `/status` 與 Webhook 錯誤，確認管理者／群組 ID、Bot 群組權限與回覆位置；管理者再私訊 `/start` 更新選單。

### 公開內容邊界

公開倉庫只放共用程式、必要文件、授權和去識別範例。實際設定、ID／網址、憑證（含 DPAPI 檔）、使用者資料、D1 匯出、備份與運行紀錄留在私有位置；截圖和錯誤輸出也須去識別。推送前檢查差異與歷史，`.gitignore` 不會移除已提交的內容。整理公開檔案不等於刪除本機憑證或還原備份。

### 授權

本專案採 [GPL-3.0-only](LICENSE)。Topic 分流概念參考 [Roddy-D/cloudflare-telegrambot](https://github.com/Roddy-D/cloudflare-telegrambot)。

<a id="ja"></a>

## 日本語

Telegram の個別チャットを管理者へ転送し、Bot を通して返信できます。ユーザーごとにトピックを作るトピックモードと、管理者個別チャットモードを選べます。Cloudflare Workers と D1 で動作し、常時稼働のサーバーは不要です。

### AI デプロイ用プロンプト

リポジトリのリンクと以下のプロンプトを、ファイルの読み取りとコマンド実行ができる AI アシスタントに渡してください。ログイン、BotFather、安全な入力は本人が行います。

> プログラミングの経験がありません。README を読み、この Telegram 転送 Bot のデプロイを進めてください。ファイル、コマンド、ローカル設定、検証はあなたが担当し、私はログイン、BotFather、権限の承認、安全な入力だけ行います。必要な操作を一つずつ案内し、結果を確認してから次に進んでください。
>
> OS、Node.js 24 以降、pnpm、Windows なら PowerShell 7、Cloudflare／Telegram の準備状況を確認してください。未決定の項目だけ質問してください：新規か既存か、固定言語 `zh`／`ja`／`en`、トピックモードか管理者個別チャットモードか。開始時・ブロック時・送信頻度制限時・転送不可の案内、送信間隔、クリーンアップ時刻は任意で変更し、指定がなければ安全な既定値を使ってください。不足するツールは導入を案内してください。
>
> 私の Worker、D1、Bot を使い、`tools/` で管理者／グループ ID を安全に取得してください。下の手順で依存関係、テスト、`wrangler.jsonc`、`vars.BOT_LANGUAGE`、データベース移行、Secrets／Variables、Worker のデプロイを進めてください。新規なら `/ready` の成功後に Webhook を登録してください。既存なら対象のリソースを確認して D1 をバックアップし、元の設定と認証情報を使ってください。
>
> 下の公開ルールを守り、Token はローカルの安全な入力か Secret 欄だけで扱い、チャット・出力・Git に含めないでください。私有データは Git の対象外に置きます。依頼なしに既存設定の上書き、リソースの再作成、認証情報の更新、復旧用バックアップの削除、コード変更、GitHub への push、Release／tag の作成をしないでください。
>
> 最後に `/health`、`/ready`、Webhook、安全なプローブを確認し、管理者以外のアカウントで送信と返信を試せるよう案内してください。管理者には Bot との個別チャットで `/start` と `/status` を使ってもらい、消去機能はテスト用アカウントだけで確認してください。止まったら理由と次の操作を説明し、未確認の項目を完了扱いにしないでください。Bot のリンク、Worker URL、モード、言語、検証結果、認証情報の保管場所をまとめ、秘密の値は表示しないでください。

### 必要なもの

- Node.js 24 以降、pnpm、Cloudflare アカウント、Telegram Bot Token。Windows のスクリプトには PowerShell 7 も必要です。ローカルテストは [--test-isolation](https://nodejs.org/api/cli.html#--test-isolationmode) と `node:sqlite` を使います。
- トピックを使う場合はトピックを有効にしたスーパーグループと、Bot の送信・トピック管理権限。
- `tools/*.ps1` は Windows DPAPI で認証情報を暗号化し、元の Windows ユーザー環境でのみ復号できます。他の PC にそのまま持ち運べる認証情報ではありません。他の OS では Wrangler を直接使い、Token を安全に管理してください。

### デプロイ

以下は**新規デプロイ**の手順で、プロジェクトのディレクトリで PowerShell 7 から実行します。既存の Bot を更新する場合は D1 をバックアップし、元の設定・認証情報を使い、未適用の データベース移行 を適用して `--keep-vars` でデプロイしてください。D1 の再作成や、文書更新のための Webhook 再登録・Secret の変更は不要です。

```powershell
pnpm install --frozen-lockfile
pnpm run check
if (-not (Test-Path -LiteralPath wrangler.jsonc)) {
    Copy-Item wrangler.jsonc.example wrangler.jsonc
}
```

`wrangler.jsonc` に自分の Worker 名、D1 名、`vars.BOT_LANGUAGE`（`zh`、`ja`、`en`。既定は `zh`）を設定します。言語はデプロイごとに固定し、Telegram ユーザーの言語では切り替えません。言語別のインスタンスでは別々の Worker、D1、Bot、トピック管理グループを使用し、同じ Bot の Webhook を共有しません。

新しい Bot で Webhook を登録する前に、自分の Telegram アカウントから Bot に `/id` を個別チャットし、`./tools/Get-TelegramUserId.ps1` を実行して自分の数字の `ADMIN_USER_ID` を確認します。Bot Token の入力は非表示で、保存されません。候補が複数ある場合は自分のアカウントを確認してください。すでに Webhook がある場合は既存の設定から ID を取得し、[getUpdates](https://core.telegram.org/bots/api#getupdates) は使用しません。

```powershell
if (-not (Test-Path -LiteralPath private-credentials/cloudflare-token.dpapi)) {
    ./tools/Save-CloudflareToken.ps1
}
./tools/Test-CloudflareToken.ps1
# 新しいデータベースを作る場合だけ次の行を実行：
./tools/Invoke-WithCloudflareToken.ps1 d1 create YOUR_D1_NAME
```

返された `database_id` を `wrangler.jsonc` に記入してから実行します。

```powershell
./tools/Invoke-WithCloudflareToken.ps1 d1 migrations apply BOT_DB --remote --config wrangler.jsonc
./tools/Invoke-WithCloudflareToken.ps1 deploy --keep-vars --config wrangler.jsonc
```

まず Worker を作成します。必須の設定が揃うまでは `/ready` の 503 は想定内なので、Webhook はまだ登録しません。下記の `YOUR_WORKER.YOUR_SUBDOMAIN` はデプロイ結果の HTTPS ルート URL に置き換えてください。スクリプトが `/webhook` を追加します。

Cloudflare API Token には対象アカウントの Workers Scripts Edit と D1 Edit が必要です。暗号化したコピーは `private-credentials/` に保存し、保存スクリプトは既存のコピーを上書きしません。意図的に更新する場合だけ `-Force` を使ってください。[keep_vars](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth) は設定ファイルで明示的に上書きされない変数を保持しますが、誤った設定から元の値を保護するものではありません。

Cloudflare Worker の Variables and Secrets に次を設定します。

| 名前 | 種類 | 内容 |
|---|---|---|
| `BOT_TOKEN` | Secret | BotFather で取得 |
| `WEBHOOK_SECRET` | Secret | 下記スクリプトで生成し、Webhook 登録にも同じ値を使用 |
| `ADMIN_USER_ID` | Text | 管理者の数字の Telegram User ID |
| `ADMIN_GROUP_ID` | Text、省略可 | トピックを有効にしたスーパーグループの ID。省略時は管理者への個別チャットを使用 |
| `BOT_LANGUAGE` | Text、省略可 | `zh`／`ja`／`en`。既定は `zh`。`vars.BOT_LANGUAGE` と一致させる |
| `WELCOME_MESSAGE` | Text、省略可 | デプロイ言語の `/start` 応答文を上書き |
| `BLOCKED_MESSAGE` | Text、省略可 | ブロックされたユーザーへの案内を上書き |
| `RATE_LIMIT_MESSAGE` | Text、省略可 | 送信頻度の案内を上書き |
| `UNSUPPORTED_MESSAGE` | Text、省略可 | 転送できないメッセージの案内を上書き |
| `MESSAGE_INTERVAL_SECONDS` | Text、省略可 | 通常メッセージの間隔。既定は 2 秒、範囲は 0–60 |

案内文を設定しなければその言語の既定の翻訳を使い、カスタム文は最大 4096 文字です。[クリーンアップのスケジュール](https://developers.cloudflare.com/workers/configuration/cron-triggers/)は `triggers.crons` で変更し、時刻は UTC です。例の `17 3 * * *` は毎日 03:17 UTC で、ユーザーの現地時刻ではありません。スケジュールを無効にすると定期クリーンアップも停止します。

```powershell
if (-not (Test-Path -LiteralPath private-credentials/telegram-webhook-secret.dpapi)) {
    ./tools/New-WebhookSecret.ps1
}
./tools/Copy-WebhookSecret.ps1
# Cloudflare の WEBHOOK_SECRET に貼り付け、表の必須設定を保存した後：
Set-Clipboard $null
./tools/Invoke-WithCloudflareToken.ps1 deploy --keep-vars --config wrangler.jsonc
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/ready'
# /ready の成功後に登録：
./tools/Register-TelegramWebhook.ps1 -WorkerUrl 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev'
```

最後のスクリプトは Bot Token を非表示で入力し、`message` と `edited_message` のみを購読します。既存の Secret は `New-WebhookSecret.ps1` で上書きされません。変更時は Cloudflare Secret と Telegram Webhook を同時に更新してください。

グループ ID が不明なら `ADMIN_GROUP_ID` を省略して管理者個別チャットモードでデプロイ・Webhook 登録を済ませ、管理者が対象のトピック付きグループで `/setup` を送ります。返された ID を `ADMIN_GROUP_ID` に設定し、保存・デプロイしてください。Webhook 登録前ならグループで `/setup` を送り、`./tools/Get-TelegramChatIds.ps1` を使う方法もあります。登録済みの場合は ID の確認に `getUpdates` を使わないでください。

### 使い方とコマンド

ユーザーは Bot に個別チャットを送ります。管理者は該当トピックで、または管理者個別チャットモードで転送されたメッセージへの返信として返答します。テキスト、コピー可能な通常のメディア、アルバム、テキスト／キャプションの編集同期に対応し、メディアの置換には対応しません。

| 使用場所 | コマンド | 用途 |
|---|---|---|
| Bot との個別チャット（ユーザー） | `/start`、`/id` | 開始時のメッセージ、自分の User ID |
| Bot との個別チャット（ユーザー） | `/forget`、`/forget confirm` | 消去の説明、消去の確認 |
| Bot との個別チャット（管理者） | `/start`、`/help`、`/status` | メニュー設定、コマンド案内、過去24時間の処理状況と Webhook 保留件数 |
| Bot との個別チャット（管理者） | `/unblock USER_ID` | ID による解除。消去済みのブロックユーザーも対象 |
| 管理グループのユーザートピック | `/user`、`/block`、`/unblock`、`/close`、`/help`、`/status` | 情報表示、ブロック／解除、トピックを閉じる、案内／状況確認 |
| 管理者個別チャットモードで転送メッセージへの管理者の返信 | `/user`、`/block`、`/unblock` | そのメッセージのユーザーを操作 |

管理権限は `ADMIN_USER_ID` だけで判定します。管理者が `/start` を個別チャットすると本人用のメニューを設定でき、モード変更後は再実行できます。`/close` はトピックを閉じるだけで、ユーザーをブロックしません。受信を止めるには `/block` を使ってください。

### データと制限

D1 には転送に必要な User ID、表示名／ユーザー名、トピック／メッセージ ID、処理状況を保存し、本文やメディア本体は保存しません。管理側にはユーザーの基本情報が表示され、匿名サービスではありません。トピックは独立した閲覧権限でもないため、管理グループには信頼できるメンバーだけを招待してください。

ユーザーが `/forget` を送ると確認方法が表示され、`/forget confirm` を送った場合にのみ Bot の D1 に保存された個人情報、アルバムの一時データ、メッセージの対応情報が消去されます。表示名を含まない再作成防止の記録を一時保持し、ブロックされていないユーザーの記録は7日後の定期処理で削除します。ブロック中の ID、ブロック状態、記録は残り、管理者は Bot との個別チャットで `/unblock USER_ID` を送って解除できます。**Telegram の既存メッセージとバックアップは削除されません**。以後の新しいメッセージは情報を再作成する場合があります。`/status` は処理中と処理期限切れも表示しますが、実際の送受信テストの代わりにはなりません。

30 日を超えたメッセージの対応情報は次の定期クリーンアップで削除します。対応が失効すると古いメッセージの編集や管理者個別チャットモードの返信を転送できない場合があります。Telegram のコピー実行後に応答が失われると再試行で重複する可能性があるため、再送前に両側を確認してください。対応の保存は再試行し、失敗時はコピーの取り消しを試みます。両方失敗すると自動再送を止め、送信者に通知します。

### 確認とトラブル対応

```powershell
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/health'
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/ready'
./tools/Get-TelegramWebhookInfo.ps1
./tools/Test-WorkerRuntime.ps1 -WorkerUrl 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev'
```

`/ready` は設定と D1 の構造を確認しますが、Telegram 側の権限は確認しません。運用テストは安全な更新を送信して D1 のテスト行を消去しますが、Telegram での実際の送受信は検証しません。最後に管理者以外のアカウントで「個別チャット → 管理側への到着 → 管理者の返信 → ユーザーへの到着」を確認してください。独自の設定ファイルを使う場合は、テストにも `-Config '設定ファイルのパス'` を指定し、正しい D1 のテスト行を消去してください。

- `/ready` が 503：必須設定、`BOT_DB`、データベース移行 を確認し、修復目的で D1 を削除しないでください。
- Webhook が 403：Cloudflare と Telegram の `WEBHOOK_SECRET` が同じか確認し、安易に再生成しないでください。
- 届かない／メニュー不足：`/status` と Webhook エラー、管理者／グループ ID、Bot の権限、返信場所を確認し、管理者が `/start` を個別チャットしてメニューを更新します。

### 公開する内容

公開するのは共通コード、必要な文書、ライセンス、個人情報を除いた設定例だけです。実際の設定、ID／URL、認証情報（DPAPI ファイルも含む）、ユーザーデータ、D1 エクスポート、バックアップ、運用記録は私有の場所に置き、画像やエラー出力からも不要な情報を除きます。push 前に差分と履歴を確認してください。`.gitignore` は既存のコミットを消しません。公開ファイルの整理で私有の認証情報や復旧用バックアップを削除しないでください。

### ライセンス

このプロジェクトは [GPL-3.0-only](LICENSE) で公開しています。トピックへの振り分けは [Roddy-D/cloudflare-telegrambot](https://github.com/Roddy-D/cloudflare-telegrambot) のアイデアを参考にしました。

<a id="en"></a>

## English

Relay Telegram private messages to an admin, who replies through the bot. Choose topic mode, with one topic per user, or admin private-chat mode. Runs on Cloudflare Workers and D1 without an always-on server.

### AI deployment prompt

Give the repository link and this prompt to an AI coding assistant that can read files and run commands. You handle sign-in, BotFather, and secure input.

> I have no coding experience. Read the README and deploy this Telegram private-message relay bot with me. Handle files, commands, local configuration, and verification. I will handle sign-in, BotFather, permissions, and secure input. Give me one action at a time, check its result, and continue.
>
> Check my OS, Node.js 24 or newer, pnpm, PowerShell 7 on Windows, and Cloudflare/Telegram setup. Ask only for missing choices: new or existing deployment, fixed language `zh`/`ja`/`en`, and topic mode or admin private-chat mode. Offer optional welcome, blocked-user, rate-limit, and unsupported-message notices, a message interval, and a cleanup schedule; otherwise use safe defaults. Help me install any missing tools.
>
> Use my Worker, D1, and bot, and obtain my numeric admin/group IDs safely with `tools/`. Follow the steps below for dependencies, tests, `wrangler.jsonc`, `vars.BOT_LANGUAGE`, database migrations, Secrets/Variables, and Worker deployment. For a new deployment, confirm `/ready` before registering the webhook. For an existing deployment, identify its resources, back up D1, and reuse its settings and credentials.
>
> Follow the public-content rules below. Handle tokens only through secure local input or Secret fields, never chat, output, or Git; keep private data in Git-ignored locations. Without my request, do not overwrite existing settings, recreate resources, rotate credentials, delete recovery backups, change source code, push to GitHub, or create a Release/tag.
>
> Verify `/health`, `/ready`, webhook status, and the safe runtime probe, then guide me through a real send-and-reply test with a non-admin account. Have the admin send `/start` and `/status` privately to the bot; use only test accounts for erasure. If blocked, explain why and give my next action; do not report unverified work as complete. Finish with the bot link, Worker URL, mode, language, checks, and credential storage location, without secret values.

### Requirements

- Node.js 24 or newer, pnpm, a Cloudflare account, and a Telegram Bot Token; the Windows scripts also need PowerShell 7. Local tests use [--test-isolation](https://nodejs.org/api/cli.html#--test-isolationmode) and `node:sqlite`.
- Topic mode requires a supergroup with topics enabled and permission for the bot to send messages and manage topics.
- `tools/*.ps1` encrypt credentials with Windows DPAPI for the original Windows user environment; these files are not portable credentials for another machine. On other systems, use Wrangler directly and manage the token securely.

### Deploy

The following is for a **new deployment**, using PowerShell 7 in the project directory. To update an existing bot, back up D1, reuse its configuration and credentials, apply pending migrations, and deploy with `--keep-vars`. Do not recreate D1, re-register its webhook, or rotate secrets just to update documentation.

```powershell
pnpm install --frozen-lockfile
pnpm run check
if (-not (Test-Path -LiteralPath wrangler.jsonc)) {
    Copy-Item wrangler.jsonc.example wrangler.jsonc
}
```

Set your Worker and D1 names and `vars.BOT_LANGUAGE` (`zh`, `ja`, or `en`; default `zh`) in `wrangler.jsonc`. The language is fixed per deployment, not selected from a user's Telegram settings. Use separate Workers, D1 databases, Bots, and topic-mode admin groups for separate language instances; do not share one Bot's webhook across them.

For a new Bot, before registering its webhook, send `/id` in a private chat with it from your own Telegram account. Run `./tools/Get-TelegramUserId.ps1` and confirm your numeric `ADMIN_USER_ID`. The script hides the bot Token input and does not save it; if multiple IDs appear, identify your own account. For a deployment with an existing webhook, get the ID from its current configuration instead of using [getUpdates](https://core.telegram.org/bots/api#getupdates).

```powershell
if (-not (Test-Path -LiteralPath private-credentials/cloudflare-token.dpapi)) {
    ./tools/Save-CloudflareToken.ps1
}
./tools/Test-CloudflareToken.ps1
# Run the next line only for a new database:
./tools/Invoke-WithCloudflareToken.ps1 d1 create YOUR_D1_NAME
```

Put the returned `database_id` in `wrangler.jsonc`, then run:

```powershell
./tools/Invoke-WithCloudflareToken.ps1 d1 migrations apply BOT_DB --remote --config wrangler.jsonc
./tools/Invoke-WithCloudflareToken.ps1 deploy --keep-vars --config wrangler.jsonc
```

This first creates the Worker. `/ready` returning 503 is expected until its required settings are complete; do not register the webhook yet. Replace `YOUR_WORKER.YOUR_SUBDOMAIN` below with the HTTPS root URL returned by deployment. The scripts append `/webhook` themselves.

The Cloudflare API Token needs Workers Scripts Edit and D1 Edit for the target account. Its encrypted copy stays under `private-credentials/`; the save script refuses to overwrite it unless you explicitly use `-Force`. [keep_vars](https://developers.cloudflare.com/workers/wrangler/configuration/#source-of-truth) preserves dashboard variables not explicitly overridden by the config; it cannot protect existing values from an incorrect configuration.

Set these under the Worker's Variables and Secrets in Cloudflare:

| Name | Type | Purpose |
|---|---|---|
| `BOT_TOKEN` | Secret | From BotFather |
| `WEBHOOK_SECRET` | Secret | Generated below; use the same value when registering the webhook |
| `ADMIN_USER_ID` | Text | The admin's numeric Telegram User ID |
| `ADMIN_GROUP_ID` | Text, optional | Supergroup ID with topics enabled; omit for admin private-chat mode |
| `BOT_LANGUAGE` | Text, optional | `zh` / `ja` / `en`; default `zh`; keep it consistent with `vars.BOT_LANGUAGE` |
| `WELCOME_MESSAGE` | Text, optional | Overrides the `/start` reply for this deployment language |
| `BLOCKED_MESSAGE` | Text, optional | Overrides the notice sent to blocked users |
| `RATE_LIMIT_MESSAGE` | Text, optional | Overrides the rate-limit notice |
| `UNSUPPORTED_MESSAGE` | Text, optional | Overrides the unsupported-message notice |
| `MESSAGE_INTERVAL_SECONDS` | Text, optional | Minimum interval for ordinary messages; default 2 seconds, range 0–60 |

Unset notices use that language's defaults; custom text is limited to 4096 characters. Change the [cleanup schedule](https://developers.cloudflare.com/workers/configuration/cron-triggers/) under `triggers.crons`, using UTC: the example `17 3 * * *` means daily at 03:17 UTC, not the user's local time. Disabling the schedule also disables periodic cleanup.

```powershell
if (-not (Test-Path -LiteralPath private-credentials/telegram-webhook-secret.dpapi)) {
    ./tools/New-WebhookSecret.ps1
}
./tools/Copy-WebhookSecret.ps1
# After pasting into WEBHOOK_SECRET and saving all required settings above:
Set-Clipboard $null
./tools/Invoke-WithCloudflareToken.ps1 deploy --keep-vars --config wrangler.jsonc
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/ready'
# Register only after /ready succeeds:
./tools/Register-TelegramWebhook.ps1 -WorkerUrl 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev'
```

The last script prompts for the bot Token without displaying it and subscribes to `message` and `edited_message` only. `New-WebhookSecret.ps1` refuses to overwrite an existing secret. If you rotate it, update the Cloudflare Secret and Telegram webhook together.

If you do not know the group ID, omit `ADMIN_GROUP_ID` to complete deployment and webhook registration in admin private-chat mode. Have the admin send `/setup` in the target group with topics enabled, then set the returned ID as `ADMIN_GROUP_ID` and save/deploy. Before webhook registration, you can instead send `/setup` in the group and run `./tools/Get-TelegramChatIds.ps1`. Do not use `getUpdates` to discover IDs when a webhook is already registered.

### Usage and commands

Users message the bot privately. The admin replies in the matching topic or, in admin private-chat mode, as a reply to the relayed message. Text, ordinary copyable media, albums, and text/caption edit syncing are supported; media replacement is not.

| Where | Commands | Purpose |
|---|---|---|
| User's private chat with the bot | `/start`, `/id` | Welcome message, own User ID |
| User's private chat with the bot | `/forget`, `/forget confirm` | Erasure instructions, confirmed erasure |
| Admin's private chat with the bot | `/start`, `/help`, `/status` | Set command menu, show help, see 24-hour processing and webhook pending count |
| Admin's private chat with the bot | `/unblock USER_ID` | Unblock by ID, including blocked users who erased their data |
| User topic in the admin group | `/user`, `/block`, `/unblock`, `/close`, `/help`, `/status` | User details, block/unblock, close topic, help/status |
| Admin private-chat mode: reply to a relayed message | `/user`, `/block`, `/unblock` | Act on the user belonging to that message |

Only `ADMIN_USER_ID` grants admin access. Send `/start` in your private chat with the bot to set the admin command menu; repeat it after switching modes. `/close` only closes a topic and does not block the user; use `/block` to stop accepting that user's messages.

### Data and limits

D1 stores routing-related User IDs, display names/usernames, topic/message IDs, and processing state, not message text or media content. The admin sees basic user information; this is not an anonymous service. Topics are not separate read-access boundaries, so invite only trusted members to the admin group.

Sending `/forget` shows confirmation instructions; only `/forget confirm` erases personal data, album staging, and relay mappings stored in the bot's D1. Records without display names prevent old requests from restoring data; unblocked users' records are removed by scheduled cleanup after 7 days. Blocked IDs, blocked state, and their records remain; the admin can send `/unblock USER_ID` in their private chat with the bot. This **does not delete existing Telegram messages or backups**. Later new messages may create data again. `/status` also shows processing updates and timeouts, but is not a substitute for a real two-way delivery test.

Mappings older than 30 days are removed at the next scheduled cleanup. Once a mapping expires, old-message edits or replies in admin private-chat mode may no longer be routable. If Telegram copies a message but its response is lost, retrying can still deliver a duplicate; check both sides before resending. Mapping saves are retried, then the bot tries to remove the copy. If both fail, it stops automatic resending and notifies the sender.

### Verification and troubleshooting

```powershell
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/health'
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/ready'
./tools/Get-TelegramWebhookInfo.ps1
./tools/Test-WorkerRuntime.ps1 -WorkerUrl 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev'
```

`/ready` checks configuration and the D1 schema, not Telegram permissions. The runtime probe sends a safe update and removes its D1 row, but does not test actual Telegram delivery. Also test the full flow with a non-admin account: private message → admin receives it → admin replies → user receives the reply. If you use a custom config file, pass `-Config 'path/to/config'` to the probe so it cleans up the correct D1 database.

- `/ready` returns 503: check required settings, the `BOT_DB` binding, and migrations; do not delete D1 to repair it.
- Webhook returns 403: check that Cloudflare and Telegram use the same `WEBHOOK_SECRET`; do not simply regenerate it.
- Missing delivery or menu commands: check `/status`, webhook errors, admin/group IDs, Bot permissions, and reply location; have the admin send `/start` privately to refresh the menu.

### What belongs in the public repository

Publish only shared code, necessary documents, the license, and de-identified examples. Keep actual settings, IDs/URLs, credentials (including DPAPI files), user data, D1 exports, backups, and operational records private; redact screenshots and error output too. Check the diff and history before pushing: `.gitignore` does not remove committed content. Cleaning public files does not mean deleting private credentials or recovery backups.

### License

This project is licensed under [GPL-3.0-only](LICENSE). Topic routing was inspired by [Roddy-D/cloudflare-telegrambot](https://github.com/Roddy-D/cloudflare-telegrambot).

# Telegram 私訊轉送 Bot

[中文](#zh) · [日本語](#ja) · [English](#en)

Version: v1.3.1 · License: [GPL-3.0-only](LICENSE)

<a id="zh"></a>

## 中文

**免自管伺服器：** 部署在 Cloudflare Workers 與 D1，Webhook 收件和回覆由 Worker 處理；無需自架或維護常駐主機。仍需 Cloudflare 帳號、Telegram Bot Token 和管理者 ID；Topic 模式另需管理群組。

### AI 部署提示詞

把 repository 連結和這段提示詞交給能讀取檔案、執行終端指令的 AI coding agent；帳號登入、BotFather 和安全輸入仍由你完成。

> 我沒有程式經驗。請把這個 repository 當成部署說明，直接帶我完成一個可用的 Telegram 私聊轉送 Bot；你負責讀取檔案、執行指令、修改本機設定及驗證，我只完成必須由帳號持有人操作的登入、BotFather、權限授予和安全輸入。不要只給我一串指令，也不要擅自改寫 Bot 程式。
>
> 先檢查我的作業系統、終端、Node.js、pnpm、PowerShell 7（若使用 Windows 腳本）、Cloudflare／Telegram 的準備狀態，以及此工程是否已有正在運行的部署。只問我缺少的必要選項：新建或沿用部署、Bot 固定語言 `zh`／`ja`／`en`、Topic 群組或管理者私聊模式；再讓我選擇是否自訂歡迎訊息、封鎖／節流／無法轉送提示、訊息間隔與清理排程，未指定就沿用安全預設。所有 Worker 名稱、D1、管理者 ID、群組 ID、Bot 和 Webhook 都要使用我的資料，不沿用原作者的環境。若沿用現有部署，先辨識 Worker、D1 與 Webhook，避免覆寫或重建。缺少工具時引導我安裝，然後接續工作。
>
> 依 README 與現有 `tools/` 腳本完成依賴安裝、測試、建立受 Git 忽略的 `wrangler.jsonc`、安全取得我的數字 `ADMIN_USER_ID`（Topic 模式也取得 `ADMIN_GROUP_ID`）、設定 Worker／D1／`vars.BOT_LANGUAGE`、建立或沿用 D1、套用 migrations、設定 Cloudflare Secrets／Variables、部署 Worker、註冊 Telegram Webhook。不要用範例覆蓋既有設定；新部署須先完成必要設定並確認 `/ready` 成功，再註冊 Webhook。每一步請先說明我需做的唯一操作，完成後自行核對結果再進下一步；不要讓我手寫程式或自行猜設定值。Bot Token、Cloudflare Token、Webhook Secret 只能透過本機安全輸入或 Cloudflare Secret 欄位處理，不要請我貼進聊天、終端輸出、Git 或公開檔案；不要刪除或輪替既有憑證，除非我明確要求。部署不等於公開我的環境資料：設定、憑證、使用者資料、備份及操作紀錄留在受 Git 忽略的本機位置；未經我要求不要推送 GitHub 或建立 Release／tag。
>
> 最後實際檢查 `/health`、`/ready`、Webhook 狀態和專案提供的安全 runtime probe，並引導我用非管理者 Telegram 帳號完成「私聊 → 管理端收到 → 回覆 → 使用者收到」測試。由管理者私聊 Bot 傳 `/start` 設定指令選單，再用 `/status` 查看狀態；資料清除只用測試帳號驗證。若環境或權限阻止某一步，說清楚阻礙與我需要做的下一個動作；不要宣稱未驗證的步驟已完成。成功後用白話列出 Bot 連結、Worker 網址、選定語言、部署模式、檢查結果與需要我保管的憑證位置，不顯示秘密值。

這個 Bot 把 Telegram 私聊轉送到管理超級群組中每位使用者專屬的 Topic，管理者可直接回覆。未設定管理群組時，改用管理者私聊作為備用模式。以 Cloudflare Worker、D1 和 Telegram Webhook 運作；不儲存訊息文字或媒體內容。

### 準備

- Node.js 24 以上、pnpm、Cloudflare 帳號和 Telegram Bot Token；Windows 腳本另需 PowerShell 7。本機測試使用 [--test-isolation](https://nodejs.org/api/cli.html#--test-isolationmode) 與 `node:sqlite`。
- Topic 模式需要啟用話題的超級群組，Bot 須有傳送訊息及管理話題權限。
- `tools/*.ps1` 使用 Windows DPAPI 儲存本機加密憑證，只能由同一 Windows 使用者環境解密，不能當作跨機可攜的憑證。其他系統可直接使用 Wrangler 並自行安全管理 Token。

### 部署

以下是**新部署**流程，在工程目錄的 PowerShell 7 執行；不要直接套用到既有部署。更新既有 Bot 時，先備份 D1、沿用原設定與憑證、套用尚未執行的 migrations，再用 `--keep-vars` 部署。不要重新建立 D1，也不要為更新文件而重新註冊 Webhook 或輪替 Secret。

```powershell
pnpm install --frozen-lockfile
pnpm run check
if (-not (Test-Path -LiteralPath wrangler.jsonc)) {
    Copy-Item wrangler.jsonc.example wrangler.jsonc
}
```

先在 `wrangler.jsonc` 設定自己的 Worker 名稱、D1 名稱及 `vars.BOT_LANGUAGE`（`zh`、`ja` 或 `en`，預設 `zh`）。每個部署固定一種語言，不依使用者的 Telegram 語言切換；不同語言實例使用各自的 Worker、D1、Bot 和 Topic 管理群組，不共用同一 Bot 的 Webhook。

新 Bot 尚未註冊 Webhook 時，先用自己的 Telegram 帳號私聊該 Bot 傳送 `/id`，再執行 `./tools/Get-TelegramUserId.ps1` 取得並確認自己的數字 `ADMIN_USER_ID`。腳本隱藏輸入 Bot Token、不保存它；若顯示多個候選 ID，請確認哪個帳號是自己。已有 Webhook 的部署則從現有設定取得 ID，不要用 [getUpdates](https://core.telegram.org/bots/api#getupdates)。

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
| `ADMIN_GROUP_ID` | Text，可選 | 啟用話題的超級群組 ID；省略則使用管理者私聊模式 |
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

不知道群組 ID 時，先省略 `ADMIN_GROUP_ID` 以私聊模式完成部署及 Webhook 註冊，再由管理者在啟用話題的目標群組傳送 `/setup`，把回覆的 ID 填入 `ADMIN_GROUP_ID` 並儲存部署。Webhook 尚未註冊時，也可在群組傳 `/setup` 後執行 `./tools/Get-TelegramChatIds.ps1`。已有 Webhook 時不要用 `getUpdates` 查 ID。

### 使用與指令

使用者私聊 Bot；Topic 模式由管理者在對應 Topic 回覆，私聊模式須直接回覆 Bot 轉來的訊息。支援文字、可複製的一般媒體、相簿，以及文字／媒體說明的編輯同步，不支援替換媒體。

| 使用位置 | 指令 | 用途 |
|---|---|---|
| 使用者私聊 | `/start`、`/id` | 歡迎訊息、自己的 User ID |
| 使用者私聊 | `/forget`、`/forget confirm` | 查看清除說明、確認清除資料 |
| 管理者私聊 | `/start`、`/help`、`/status` | 設定選單、查指令、查近 24 小時處理狀態與 Webhook 待處理數 |
| 管理者私聊 | `/unblock USER_ID` | 依 ID 解封，包括已清除資料的封鎖者 |
| 管理群組的使用者 Topic | `/user`、`/block`、`/unblock`、`/close`、`/help`、`/status` | 查資料、封鎖／解封、關閉 Topic、查指令／狀態 |
| 私聊模式，管理者回覆轉來的訊息 | `/user`、`/block`、`/unblock` | 操作該訊息所屬的使用者 |

管理權限只認 `ADMIN_USER_ID`；管理者私聊 `/start` 設定本人可見的選單，切換模式後可再傳一次。`/close` 只關閉 Topic，不封鎖使用者；要停止接收該使用者的訊息，請用 `/block`。

### 資料與限制

D1 保存路由所需的 User ID、姓名／username、Topic／訊息 ID 與處理狀態，不保存訊息文字或媒體本體。管理端會看到使用者基本資料，這不是匿名服務；Topic 也不是獨立閱讀權限，管理群組只應加入可信任成員。

使用者傳 `/forget` 會先看到確認說明，只有傳 `/forget confirm` 才清除 Bot 的 D1 個人資料、相簿暫存及轉送對照。為防止舊請求重建資料，Bot 暫留不含姓名的控制紀錄；非封鎖者的紀錄會在 7 天後依排程清理。被封鎖者的 ID、封鎖狀態與控制紀錄仍保留，管理者可在 Bot 私聊傳 `/unblock 使用者ID` 解封。這**不會刪除 Telegram 兩端已有的聊天訊息或既有備份**；之後的新訊息可能重新建立資料。`/status` 也顯示處理中及逾期租約，但不能替代真人收發測試。

超過 30 天的轉送對照會在下一次排程清理刪除；對照過期後，舊訊息編輯及私聊模式的回覆可能無法路由。若 Telegram 已轉送卻沒有返回結果，重試仍可能重複送達；先核對兩端再決定重送。保存對照失敗時會重試保存，再嘗試撤回副本；兩者都失敗則停止自動重送並提示發送者。

### 驗證與排查

```powershell
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/health'
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/ready'
./tools/Get-TelegramWebhookInfo.ps1
./tools/Test-WorkerRuntime.ps1 -WorkerUrl 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev'
```

`/ready` 檢查設定與 D1 結構，不檢查 Telegram 權限。正式環境探針會送安全的測試更新並清除其 D1 紀錄，但不會驗證 Telegram 實際收發；仍須用非管理者帳號實測「私聊 → 管理端收到 → 管理者回覆 → 使用者收到」。若使用自訂設定檔，探針也須加上 `-Config '你的設定檔路徑'`，以清理正確的 D1。

- `/ready` 回傳 503：核對必填設定、`BOT_DB` 綁定及 migrations，不要刪除資料庫來修復。
- Webhook 回傳 403：核對 Cloudflare 與 Telegram 使用同一個 `WEBHOOK_SECRET`，不要直接重產 Secret。
- 收不到訊息或選單不完整：查看 `/status` 與 Webhook 錯誤，確認管理者／群組 ID、Bot 群組權限與回覆位置；管理者再私聊 `/start` 更新選單。

### 公開內容邊界

公開倉庫只保留共用程式、必要說明、授權與去識別範例。自己的設定、ID、部署網址、憑證（包括 DPAPI 加密檔）、使用者資料、D1 匯出、備份及運行紀錄不提交；截圖與錯誤輸出也須遮蔽非必要資料。`.gitignore` 不會清除已提交的內容，推送前仍須檢查差異及歷史。必要的私有憑證和還原備份應安全保留，不因整理公開倉庫而刪除。

### 授權

本專案採 [GPL-3.0-only](LICENSE)。Topic 分流概念參考 [Roddy-D/cloudflare-telegrambot](https://github.com/Roddy-D/cloudflare-telegrambot)。

<a id="ja"></a>

## 日本語

**自前サーバー不要：** Cloudflare Workers と D1 にデプロイし、Webhook の受信と返信を Worker が処理します。常時稼働するサーバーの構築・保守は不要です。Cloudflare アカウント、Telegram Bot Token、管理者 ID は必須で、トピックモードでは管理グループも必要です。

### AI デプロイ用プロンプト

repository のリンクとこのプロンプトを、ファイルを読みターミナルを実行できる AI coding agent に渡してください。ログイン、BotFather、認証情報の安全な入力は本人が行います。

> 私にはプログラミングの経験がありません。この repository をデプロイ手順として読み、実際に使える Telegram 私信転送 Bot の公開まで案内してください。ファイルの確認、コマンド実行、ローカル設定、検証はあなたが担当し、アカウントへのログイン、BotFather、権限の承認、安全な入力など本人にしかできない操作は私に一つずつ案内してください。コマンドの一覧を渡すだけにせず、依頼していない Bot のコード変更もしないでください。
>
> まず OS、ターミナル、Node.js、pnpm、PowerShell 7（Windows のスクリプトを使う場合）、Cloudflare／Telegram の準備状況、既存の稼働中デプロイを確認してください。新規か既存か、Bot の固定言語 `zh`／`ja`／`en`、トピック付き管理グループか管理者への私信モードかなど、足りない必須項目だけ質問してください。歓迎文、ブロック／送信頻度／転送不可の案内、メッセージ間隔、クリーンアップ時刻をカスタマイズするかも確認し、指定がなければ安全な既定値を使ってください。Worker 名、D1、管理者とグループの ID、Bot、Webhook には私自身の設定を使い、元の作者の環境を流用しないでください。既存の Worker、D1、Webhook を確認せずに上書き・再作成しないでください。必要なツールがなければ導入方法を案内し、その後作業を続けてください。
>
> README と既存の `tools/` スクリプトに従い、依存関係のインストール、テスト、Git の対象外である `wrangler.jsonc` の作成、私の数字の `ADMIN_USER_ID`（トピックモードでは `ADMIN_GROUP_ID` も）の安全な確認、Worker／D1／`vars.BOT_LANGUAGE` の設定、D1 の新規作成または再利用、migrations の適用、Cloudflare Secrets／Variables の設定、Worker のデプロイ、Telegram Webhook の登録まで進めてください。設定例で既存の設定を上書きしないでください。新規デプロイでは必須の設定と `/ready` の成功を確認してから Webhook を登録してください。各段階で私が行う必要のある操作を一つだけ説明し、結果を確認してから次に進んでください。私にコードを書かせたり設定値を推測させたりしないでください。Bot Token、Cloudflare Token、Webhook Secret はローカルの安全な入力または Cloudflare の Secret 欄だけで扱い、チャット、コマンド出力、Git、公開ファイルに貼るよう求めないでください。明示的な依頼なしに既存の認証情報を削除・更新しないでください。デプロイは私の環境情報の公開ではありません。設定、認証情報、ユーザーデータ、バックアップ、操作記録は Git の対象外に保存し、依頼なしに GitHub への push や Release／tag の作成をしないでください。
>
> 最後に `/health`、`/ready`、Webhook の状態、プロジェクトの安全な runtime probe を実際に確認し、管理者以外の Telegram アカウントで「私信 → 管理側への到着 → 返信 → ユーザーへの到着」を私が試せるよう案内してください。管理者が Bot との私信で `/start` を送ってコマンドメニューを設定し、`/status` で状態を確認してください。消去機能はテスト用アカウントだけで検証してください。環境や権限で止まったら理由と私が次に行う操作を明確にし、未確認の項目を完了と報告しないでください。成功時は Bot のリンク、Worker URL、選んだ言語、運用モード、検証結果、保管すべき認証情報の場所を平易にまとめ、秘密の値は表示しないでください。

Telegram の私信を、管理用スーパーグループ内のユーザー別トピックへ転送する Bot です。管理者はトピックから返信できます。管理グループを設定しない場合は管理者への私信を使います。Cloudflare Worker、D1、Telegram Webhook で動作し、メッセージ本文やメディア本体は保存しません。

### 必要なもの

- Node.js 24 以降、pnpm、Cloudflare アカウント、Telegram Bot Token。Windows のスクリプトには PowerShell 7 も必要です。ローカルテストは [--test-isolation](https://nodejs.org/api/cli.html#--test-isolationmode) と `node:sqlite` を使います。
- トピックを使う場合はトピックを有効にしたスーパーグループと、Bot の送信・トピック管理権限。
- `tools/*.ps1` は Windows DPAPI で認証情報を暗号化し、元の Windows ユーザー環境でのみ復号できます。他の PC にそのまま持ち運べる認証情報ではありません。他の OS では Wrangler を直接使い、Token を安全に管理してください。

### デプロイ

以下は**新規デプロイ**の手順で、プロジェクトのディレクトリで PowerShell 7 から実行します。既存の Bot を更新する場合は D1 をバックアップし、元の設定・認証情報を使い、未適用の migrations を適用して `--keep-vars` でデプロイしてください。D1 の再作成や、文書更新のための Webhook 再登録・Secret の変更は不要です。

```powershell
pnpm install --frozen-lockfile
pnpm run check
if (-not (Test-Path -LiteralPath wrangler.jsonc)) {
    Copy-Item wrangler.jsonc.example wrangler.jsonc
}
```

`wrangler.jsonc` に自分の Worker 名、D1 名、`vars.BOT_LANGUAGE`（`zh`、`ja`、`en`。既定は `zh`）を設定します。言語はデプロイごとに固定し、Telegram ユーザーの言語では切り替えません。言語別のインスタンスでは別々の Worker、D1、Bot、トピック管理グループを使用し、同じ Bot の Webhook を共有しません。

新しい Bot で Webhook を登録する前に、自分の Telegram アカウントから Bot に `/id` を私信し、`./tools/Get-TelegramUserId.ps1` を実行して自分の数字の `ADMIN_USER_ID` を確認します。Bot Token の入力は非表示で、保存されません。候補が複数ある場合は自分のアカウントを確認してください。すでに Webhook がある場合は既存の設定から ID を取得し、[getUpdates](https://core.telegram.org/bots/api#getupdates) は使用しません。

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
| `ADMIN_GROUP_ID` | Text、省略可 | トピックを有効にしたスーパーグループの ID。省略時は管理者への私信を使用 |
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

グループ ID が不明なら `ADMIN_GROUP_ID` を省略して私信モードでデプロイ・Webhook 登録を済ませ、管理者が対象のトピック付きグループで `/setup` を送ります。返された ID を `ADMIN_GROUP_ID` に設定し、保存・デプロイしてください。Webhook 登録前ならグループで `/setup` を送り、`./tools/Get-TelegramChatIds.ps1` を使う方法もあります。登録済みの場合は ID の確認に `getUpdates` を使わないでください。

### 使い方とコマンド

ユーザーは Bot に私信を送ります。管理者は該当トピックで、または私信モードで転送されたメッセージへの返信として返答します。テキスト、コピー可能な通常のメディア、アルバム、テキスト／キャプションの編集同期に対応し、メディアの置換には対応しません。

| 使用場所 | コマンド | 用途 |
|---|---|---|
| ユーザーの私信 | `/start`、`/id` | 歓迎文、自分の User ID |
| ユーザーの私信 | `/forget`、`/forget confirm` | 消去の説明、消去の確認 |
| 管理者の私信 | `/start`、`/help`、`/status` | メニュー設定、コマンド案内、過去24時間の処理状況と Webhook 保留件数 |
| 管理者の私信 | `/unblock USER_ID` | ID による解除。消去済みのブロックユーザーも対象 |
| 管理グループのユーザートピック | `/user`、`/block`、`/unblock`、`/close`、`/help`、`/status` | 情報表示、ブロック／解除、トピック終了、案内／状況確認 |
| 私信モードで転送メッセージへの管理者の返信 | `/user`、`/block`、`/unblock` | そのメッセージのユーザーを操作 |

管理権限は `ADMIN_USER_ID` だけで判定します。管理者が `/start` を私信すると本人用のメニューを設定でき、モード変更後は再実行できます。`/close` はトピックを閉じるだけで、ユーザーをブロックしません。受信を止めるには `/block` を使ってください。

### データと制限

D1 には転送に必要な User ID、氏名／username、トピック／メッセージ ID、処理状況を保存し、本文やメディア本体は保存しません。管理側にはユーザーの基本情報が表示され、匿名サービスではありません。トピックは独立した閲覧権限でもないため、管理グループには信頼できるメンバーだけを招待してください。

ユーザーが `/forget` を送ると確認方法が表示され、`/forget confirm` を送った場合にのみ Bot の D1 に保存された個人情報、アルバムの一時データ、転送対応が消去されます。氏名を含まない再作成防止の制御記録を一時保持し、ブロックされていないユーザーの記録は7日後の定期処理で削除します。ブロック中の ID、ブロック状態、制御記録は残り、管理者は Bot との私信で `/unblock ユーザーID` を送って解除できます。**Telegram の既存メッセージとバックアップは削除されません**。以後の新しいメッセージは情報を再作成する場合があります。`/status` は処理中の更新と期限切れリースも表示しますが、実際の送受信テストの代わりにはなりません。

30 日を超えた転送対応は次の定期クリーンアップで削除します。対応が失効すると古いメッセージの編集や私信モードの返信を転送できない場合があります。Telegram のコピー実行後に応答が失われると再試行で重複する可能性があるため、再送前に両側を確認してください。対応の保存は再試行し、失敗時はコピーの取り消しを試みます。両方失敗すると自動再送を止め、送信者に通知します。

### 確認とトラブル対応

```powershell
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/health'
Invoke-RestMethod 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev/ready'
./tools/Get-TelegramWebhookInfo.ps1
./tools/Test-WorkerRuntime.ps1 -WorkerUrl 'https://YOUR_WORKER.YOUR_SUBDOMAIN.workers.dev'
```

`/ready` は設定と D1 の構造を確認しますが、Telegram 側の権限は確認しません。運用テストは安全な更新を送信して D1 のテスト行を消去しますが、Telegram での実際の送受信は検証しません。最後に管理者以外のアカウントで「私信 → 管理側への到着 → 管理者の返信 → ユーザーへの到着」を確認してください。独自の設定ファイルを使う場合は、テストにも `-Config '設定ファイルのパス'` を指定し、正しい D1 のテスト行を消去してください。

- `/ready` が 503：必須設定、`BOT_DB`、migrations を確認し、修復目的で D1 を削除しないでください。
- Webhook が 403：Cloudflare と Telegram の `WEBHOOK_SECRET` が同じか確認し、安易に再生成しないでください。
- 届かない／メニュー不足：`/status` と Webhook エラー、管理者／グループ ID、Bot の権限、返信場所を確認し、管理者が `/start` を私信してメニューを更新します。

### 公開する内容

公開 repository は共通コード、必要な説明、ライセンス、個人情報を除いた設定例に限定します。自分の設定、ID、デプロイ URL、認証情報（DPAPI ファイルも含む）、ユーザーデータ、D1 エクスポート、バックアップ、運用記録はコミットせず、画像やエラー出力からも不要な情報を除いてください。`.gitignore` は既存のコミットを消さないため、push 前に差分と履歴を確認します。必要な私有認証情報と復旧用バックアップは安全に保持し、公開 repository の整理で削除しないでください。

### ライセンス

このプロジェクトは [GPL-3.0-only](LICENSE) で公開しています。トピックへの振り分けは [Roddy-D/cloudflare-telegrambot](https://github.com/Roddy-D/cloudflare-telegrambot) のアイデアを参考にしました。

<a id="en"></a>

## English

**No server to maintain:** Deploy on Cloudflare Workers and D1. The Worker receives webhooks and handles replies, so no always-on server is needed. You still need a Cloudflare account, a Telegram Bot Token, and an admin ID; topic mode also needs an admin group.

### AI deployment prompt

Give the repository link and this prompt to an AI coding agent that can read files and run terminal commands. You still handle account sign-in, BotFather, and secure credential entry.

> I have no coding experience. Read this repository as the deployment guide and take me through deploying a working Telegram private-message relay Bot. You handle file inspection, commands, local configuration, and verification; guide me one action at a time through only the account-holder steps such as sign-in, BotFather, permission grants, and secure input. Do not merely give me a list of commands or change the Bot's source code without my request.
>
> First check my OS, terminal, Node.js, pnpm, PowerShell 7 if using the Windows scripts, Cloudflare and Telegram readiness, and whether this project already has a live deployment. Ask only for missing essentials: new versus existing deployment, one fixed Bot language (`zh`, `ja`, or `en`), and topic-based admin group versus admin private-chat mode. Offer me optional customization of the welcome, blocked-user, rate-limit, and unsupported-message notices, the message interval, and the cleanup schedule; keep safe defaults when I do not choose. Use my own Worker name, D1, admin and group IDs, Bot, and webhook—never the original author's environment. For an existing installation, identify its Worker, D1, and webhook before changing anything; do not overwrite or recreate them blindly. If a tool is missing, guide me through installing it and then continue.
>
> Follow the README and existing `tools/` scripts to install dependencies, run checks, create the Git-ignored `wrangler.jsonc`, safely obtain my numeric `ADMIN_USER_ID` (and `ADMIN_GROUP_ID` for topic mode), set the Worker, D1, and `vars.BOT_LANGUAGE`, create or reuse D1, apply migrations, set Cloudflare Secrets and Variables, deploy the Worker, and register the Telegram webhook. Never overwrite existing settings with the example. For a new deployment, complete the required settings and confirm `/ready` succeeds before registering the webhook. At each stage, tell me the one action I must perform, verify the result yourself, and continue. Do not ask me to write code or guess configuration values. Handle Bot, Cloudflare, and webhook tokens only through secure local prompts or Cloudflare Secret fields; never ask me to paste them into chat, terminal output, Git, or public files. Do not delete or rotate existing credentials without my explicit request. Deployment does not authorize publishing my environment: keep configuration, credentials, user data, backups, and operational records in Git-ignored local locations. Do not push to GitHub or create a Release or tag unless I request it.
>
> Finally, actually check `/health`, `/ready`, the webhook status, and the project's safe runtime probe. Guide me through a real test with a non-admin Telegram account: private message → admin receives it → admin replies → user receives the reply. Have the admin send `/start` privately to set the command menu and use `/status` to check processing. Test data erasure only with a test account. If access or permissions block a step, state exactly what is blocked and the single next action I need to take; never report unverified work as complete. When finished, summarize the Bot link, Worker URL, chosen language, admin mode, verification results, and where I should retain credentials, without displaying secret values.

This bot relays Telegram private messages to a separate topic for each user in an admin supergroup. The admin replies from that topic. Without a configured group, it falls back to the admin's private chat. It runs on a Cloudflare Worker with D1 and a Telegram webhook, and does not store message text or media content.

### Requirements

- Node.js 24 or newer, pnpm, a Cloudflare account, and a Telegram Bot Token; the Windows scripts also need PowerShell 7. Local tests use [--test-isolation](https://nodejs.org/api/cli.html#--test-isolationmode) and `node:sqlite`.
- Topic mode requires a supergroup with topics enabled and permission for the bot to send messages and manage topics.
- `tools/*.ps1` encrypt credentials with Windows DPAPI for the original Windows user environment; these files are not portable credentials for another machine. On other systems, use Wrangler directly and manage the token securely.

### Deploy

The following is for a **new deployment**, using PowerShell 7 in the project directory. To update an existing Bot, back up D1, reuse its configuration and credentials, apply pending migrations, and deploy with `--keep-vars`. Do not recreate D1, re-register its webhook, or rotate secrets just to update documentation.

```powershell
pnpm install --frozen-lockfile
pnpm run check
if (-not (Test-Path -LiteralPath wrangler.jsonc)) {
    Copy-Item wrangler.jsonc.example wrangler.jsonc
}
```

Set your Worker and D1 names and `vars.BOT_LANGUAGE` (`zh`, `ja`, or `en`; default `zh`) in `wrangler.jsonc`. The language is fixed per deployment, not selected from a user's Telegram settings. Use separate Workers, D1 databases, Bots, and topic-mode admin groups for separate language instances; do not share one Bot's webhook across them.

For a new Bot, before registering its webhook, send `/id` in a private chat with it from your own Telegram account. Run `./tools/Get-TelegramUserId.ps1` and confirm your numeric `ADMIN_USER_ID`. The script hides the Bot Token input and does not save it; if multiple IDs appear, identify your own account. For a deployment with an existing webhook, get the ID from its current configuration instead of using [getUpdates](https://core.telegram.org/bots/api#getupdates).

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

The last script prompts for the Bot Token without displaying it and subscribes to `message` and `edited_message` only. `New-WebhookSecret.ps1` refuses to overwrite an existing secret. If you rotate it, update the Cloudflare Secret and Telegram webhook together.

If you do not know the group ID, omit `ADMIN_GROUP_ID` to complete deployment and webhook registration in private-chat mode. Have the admin send `/setup` in the target group with topics enabled, then set the returned ID as `ADMIN_GROUP_ID` and save/deploy. Before webhook registration, you can instead send `/setup` in the group and run `./tools/Get-TelegramChatIds.ps1`. Do not use `getUpdates` to discover IDs when a webhook is already registered.

### Usage and commands

Users message the Bot privately. The admin replies in the matching topic or, in private-chat mode, as a reply to the relayed message. Text, ordinary copyable media, albums, and text/caption edit syncing are supported; media replacement is not.

| Where | Commands | Purpose |
|---|---|---|
| User private chat | `/start`, `/id` | Welcome message, own User ID |
| User private chat | `/forget`, `/forget confirm` | Erasure instructions, confirmed erasure |
| Admin private chat | `/start`, `/help`, `/status` | Set command menu, show help, see 24-hour processing and webhook pending count |
| Admin private chat | `/unblock USER_ID` | Unblock by ID, including blocked users who erased their data |
| User topic in the admin group | `/user`, `/block`, `/unblock`, `/close`, `/help`, `/status` | User details, block/unblock, close topic, help/status |
| Private-chat mode: admin reply to a relayed message | `/user`, `/block`, `/unblock` | Act on the user belonging to that message |

Only `ADMIN_USER_ID` grants admin access. The admin's private `/start` sets their command menu; repeat it after switching modes. `/close` only closes a topic, not blocks the user; use `/block` to stop accepting that user's messages.

### Data and limits

D1 stores routing-related User IDs, names/usernames, topic/message IDs, and processing state, not message text or media content. The admin sees basic user information; this is not an anonymous service. Topics are not separate read-access boundaries, so invite only trusted members to the admin group.

Sending `/forget` shows confirmation instructions; only `/forget confirm` erases personal data, album staging, and relay mappings stored in the Bot's D1. Control records without names prevent old requests from restoring data; unblocked users' records are removed by scheduled cleanup after 7 days. Blocked IDs, blocked state, and their control records remain; the admin can send `/unblock USER_ID` privately. This **does not delete existing Telegram messages or backups**. Later new messages may create data again. `/status` also shows processing updates and expired leases, but is not a substitute for a real two-way delivery test.

Mappings older than 30 days are removed at the next scheduled cleanup. Once a mapping expires, old-message edits or private-chat-mode replies may no longer be routable. If Telegram copies a message but its response is lost, retrying can still deliver a duplicate; check both sides before resending. Mapping saves are retried, then the Bot tries to remove the copy. If both fail, it stops automatic resending and notifies the sender.

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

Keep only shared code, necessary instructions, the license, and de-identified examples public. Do not commit your settings, IDs, deployment URLs, credentials (including DPAPI files), user data, D1 exports, backups, or operational records; redact unnecessary details from screenshots and error output too. `.gitignore` does not remove previously committed content, so review the diff and history before pushing. Securely retain needed private credentials and recovery backups rather than deleting them while cleaning the public repository.

### License

This project is licensed under [GPL-3.0-only](LICENSE). Topic routing was inspired by [Roddy-D/cloudflare-telegrambot](https://github.com/Roddy-D/cloudflare-telegrambot).

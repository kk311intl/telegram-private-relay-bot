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
> 先檢查作業系統、Node.js 24 以上、pnpm、Windows 的 PowerShell 7，以及 Cloudflare／Telegram 準備狀態。只問缺少的選項：新建或沿用部署、管理端及預設語言 `zh`／`ja`／`en`、話題模式或管理者私訊模式。歡迎、封鎖、節流、無法轉送提示，以及訊息間隔和清理排程可自訂；未指定就用安全預設。缺少工具時先引導我安裝。
>
> 使用我的 Worker、D1 和 Bot，透過 `tools/` 安全取得管理者與群組 ID。依下方流程完成依賴、測試、`wrangler.jsonc`、`vars.BOT_LANGUAGE`、資料庫遷移、Secrets／Variables 和 Worker 部署。新部署確認 `/ready` 成功後才註冊 Webhook；既有部署先辨識資源、備份 D1，再沿用原設定和憑證。
>
> 遵守下方公開內容規則。Token 僅透過本機安全輸入或 Secret 欄位處理，不放入聊天、輸出或 Git；私有資料留在受 Git 忽略的位置。未經我要求，不覆寫既有設定、重建資源、輪替憑證、刪除還原備份、改寫程式、推送 GitHub 或建立 Release／tag。
>
> 首次聯絡的算術驗證預設開啟，除非我要求才關閉。升級時先套用所有待執行的資料庫遷移，並用測試帳號確認 `/start` 顯示歡迎與語言按鈕、歡迎訊息的按鈕可切換並保存三語偏好、首則內容才出題，通過後自動轉送。
>
> 最後檢查 `/health`、`/ready`、Webhook 和安全探針，指導我用非管理者帳號完成私訊往返測試。管理者私訊 `/start` 設定選單，再用 `/status` 確認。遇到阻礙時說明原因及下一個操作，不把未驗證項目當作完成。交付 Bot 連結、Worker 網址、模式、語言、驗證結果與憑證保管位置，不顯示秘密值。

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

先在 `wrangler.jsonc` 設定自己的 Worker 名稱、D1 名稱及 `vars.BOT_LANGUAGE`（`zh`、`ja` 或 `en`，預設 `zh`）。這是管理端及尚未選擇語言的使用者所用語言；使用者可在同一 Bot 內自行切換三語，不會改變管理端語言，也不會翻譯聊天內容。

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
| `CAPTCHA_ENABLED` | Text，可選 | 算術驗證的初始預設，`true`／`false`，預設 `true`；Bot 內管理者設定優先 |

未設定的提示訊息使用對應語言的預設翻譯；自訂文字只覆蓋部署語言，最多 4096 字元，其他語言仍使用內建翻譯。[清理排程](https://developers.cloudflare.com/workers/configuration/cron-triggers/)在 `triggers.crons` 調整，採 UTC；範例 `17 3 * * *` 是每日 03:17 UTC，不是使用者本機時間。關閉排程也會停用定期清理。

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
| 使用者私訊 Bot | `/start`、`/help`、`/id` | 歡迎訊息、使用說明、自己的 User ID |
| 管理者私訊 Bot | `/start`、`/help`、`/status` | 設定選單、查指令、查近 24 小時處理狀態與 Webhook 待處理數 |
| 管理者私訊 Bot | `/unblock USER_ID` | 依 ID 解封，包括已清除資料的封鎖者 |
| 管理者私訊 Bot | `/captcha`、`/captcha on`、`/captcha off` | 查看、開啟或關閉首次聯絡驗證 |
| 管理群組的使用者話題 | `/user`、`/block`、`/unblock`、`/close`、`/help`、`/status` | 查資料、封鎖／解封、關閉話題、查指令／狀態 |
| 管理者私訊模式，管理者回覆轉來的訊息 | `/user`、`/block`、`/unblock` | 操作該訊息所屬的使用者 |

管理權限只認 `ADMIN_USER_ID`。管理者私訊 `/start` 更新預設使用者選單及本人可見的管理選單，並為一般 HTTPS Webhook 補訂閱 `callback_query`；自訂憑證的 Webhook 須自行更新訂閱。選單不會在每則訊息重設。

一般用戶的指令選單只顯示 `/start`，歡迎訊息下的按鈕可選中文、English、日本語；偏好會保存。每次 `/start` 也更新本人選單，移除舊項目；`/help` 與 `/id` 仍可直接輸入。未選語言時沿用部署預設，不依 Telegram 語言自動切換。正常聊天重用既有使用者查詢，不多讀寫 D1；只在選語言時保存偏好。升級前套用 `0007_user_language.sql`。開啟歡迎訊息時會自動確認按鈕訂閱，每個暖 Worker 只檢查一次；管理者 `/start` 更新預設選單及管理選單。

`/close` 只關閉話題，不封鎖使用者；新訊息會優先重開原話題，找不到話題才另建。要停止接收訊息請用 `/block`。管理者回覆失效對照、舊話題或錯誤位置時會收到「未送出」提示；話題無法發送提示時改私訊管理者。

`/status` 排除查詢本身，並顯示最近成功轉送距今多久及近 24 小時最近異常的簡短原因。這些資訊只在手動查詢時從既有紀錄讀取，不新增輪詢、資料表或排程；轉送時間以仍保留的對照為準。

### 首次聯絡驗證

`/start` 顯示歡迎與語言按鈕，不出題也不免除驗證。新聯絡者傳第一則內容時，Bot 才說明為了攔截自動化廣告而要求算術驗證。5 分鐘內只回覆數字，除法都是整數；連錯 3 次暫停 15 分鐘。一般錯誤至少間隔 5 秒才計次及回覆；冷卻中的內容忽略。`/help`、`/id` 仍可直接輸入；切換語言不重置題目或錯誤次數。

通過前只暫存第一則訊息的 Telegram ID；若是相簿，暫存同組最多 10 個 ID，不保存文字或媒體本體，也不建立話題。通過後自動轉送第一則內容或首組相簿，不必重送；答案與其他未驗證訊息不補送。題目過期或錯誤過多時清除待送紀錄，之後須重新傳送聯絡內容。暫存參照沿用原有相簿紀錄的清理週期。

升級前套用所有待執行的資料庫遷移，包含 `0006_verification_pending_message.sql`。既有未清除的聯絡者免重驗，清除資料後返回則重新驗證。`CAPTCHA_ENABLED="false"` 可將初始狀態設為關閉；`WELCOME_MESSAGE` 仍用於使用者的 `/start`。

管理者私訊 `/captcha` 查看狀態，用 `/captcha on` 或 `/captcha off` 切換，無須重新部署。開關保存在 D1，優先於部署預設；只在新聯絡者或未驗證者需要判斷時多讀取一筆設定。重新開啟不追溯要求已獲准聯絡者補驗，關閉也不解除既有封鎖。

驗證只擋簡單自動廣告，能解題的程式或真人仍可通過。首則待送處理完成後，正常聊天不增加 D1 查詢或寫入；未通過者的控制紀錄在 7 天未活動後用原有排程清除。沒有新增依賴、服務或排程；每個 Webhook 的既有去重寫入仍會消耗額度，這不是抗流量攻擊服務。

### 資料與限制

D1 保存路由所需的 User ID、顯示名稱／使用者名稱、話題／訊息 ID、語言偏好與處理狀態，不保存訊息文字或媒體本體。管理端會看到使用者基本資料，這不是匿名服務；話題也不是獨立閱讀權限，管理群組只應加入可信任成員。

儲存資料由部署者管理；Bot 不提供使用者自行清除資料的指令。Telegram 兩端已有的聊天訊息與既有備份需另行管理。封鎖狀態保留至管理者解除；`/status` 不能替代真人收發測試。

超過 30 天的轉送對照會在下一次排程清理刪除；對照過期後，舊訊息編輯及管理者私訊模式的回覆可能無法路由。若 Telegram 已轉送卻沒有返回結果，重試仍可能重複送達；先核對兩端再決定重送。保存對照失敗時會重試保存，再嘗試撤回副本；兩者都失敗則停止自動重送並提示發送者。

處理重試耗盡時，Bot 會盡力通知原發送者停止重試；重複更新不會重複觸發通知。提示不代表確定未送達，請先向對方確認。Telegram 不可用時通知也可能失敗；提示失敗不會重啟原訊息的轉送。

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
> OS、Node.js 24 以降、pnpm、Windows なら PowerShell 7、Cloudflare／Telegram の準備状況を確認してください。未決定の項目だけ質問してください：新規か既存か、管理側と既定の言語 `zh`／`ja`／`en`、トピックモードか管理者個別チャットモードか。開始時・ブロック時・送信頻度制限時・転送不可の案内、送信間隔、クリーンアップ時刻は任意で変更し、指定がなければ安全な既定値を使ってください。不足するツールは導入を案内してください。
>
> 私の Worker、D1、Bot を使い、`tools/` で管理者／グループ ID を安全に取得してください。下の手順で依存関係、テスト、`wrangler.jsonc`、`vars.BOT_LANGUAGE`、データベース移行、Secrets／Variables、Worker のデプロイを進めてください。新規なら `/ready` の成功後に Webhook を登録してください。既存なら対象のリソースを確認して D1 をバックアップし、元の設定と認証情報を使ってください。
>
> 下の公開ルールを守り、Token はローカルの安全な入力か Secret 欄だけで扱い、チャット・出力・Git に含めないでください。私有データは Git の対象外に置きます。依頼なしに既存設定の上書き、リソースの再作成、認証情報の更新、復旧用バックアップの削除、コード変更、GitHub への push、Release／tag の作成をしないでください。
>
> 初回の計算確認は既定で有効にし、私が依頼した場合だけ無効にしてください。未適用のデータベース移行を先に適用し、テストアカウントで `/start` の案内と言語ボタン、歓迎メッセージのボタンによる3言語の選択と保存、最初の内容での問題表示、確認後の自動転送を試してください。
>
> 最後に `/health`、`/ready`、Webhook、安全なプローブを確認し、管理者以外のアカウントで送信と返信を試せるよう案内してください。管理者には Bot との個別チャットで `/start` と `/status` を使ってもらい。止まったら理由と次の操作を説明し、未確認の項目を完了扱いにしないでください。Bot のリンク、Worker URL、モード、言語、検証結果、認証情報の保管場所をまとめ、秘密の値は表示しないでください。

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

`wrangler.jsonc` に自分の Worker 名、D1 名、`vars.BOT_LANGUAGE`（`zh`、`ja`、`en`。既定は `zh`）を設定します。管理側と未選択ユーザーの言語です。ユーザーは同じ Bot 内で3言語を選べます。管理側の言語や会話の本文は変更しません。

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
| `CAPTCHA_ENABLED` | Text、省略可 | 計算確認の初期設定。`true`／`false`、既定は `true`。Bot 内の管理者設定が優先 |

未設定の案内は対応する言語の既定の翻訳を使います。カスタム文はデプロイ言語だけに適用し、最大 4096 文字です。他言語には組み込みの翻訳を使います。[クリーンアップのスケジュール](https://developers.cloudflare.com/workers/configuration/cron-triggers/)は `triggers.crons` で変更し、時刻は UTC です。例の `17 3 * * *` は毎日 03:17 UTC で、ユーザーの現地時刻ではありません。スケジュールを無効にすると定期クリーンアップも停止します。

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
| Bot との個別チャット（ユーザー） | `/start`、`/help`、`/id` | 開始時のメッセージ、使い方、自分の User ID |
| Bot との個別チャット（管理者） | `/start`、`/help`、`/status` | メニュー設定、コマンド案内、過去24時間の処理状況と Webhook 保留件数 |
| Bot との個別チャット（管理者） | `/unblock USER_ID` | ID による解除。消去済みのブロックユーザーも対象 |
| Bot との個別チャット（管理者） | `/captcha`、`/captcha on`、`/captcha off` | 初回の確認の状態表示、有効化、無効化 |
| 管理グループのユーザートピック | `/user`、`/block`、`/unblock`、`/close`、`/help`、`/status` | 情報表示、ブロック／解除、トピックを閉じる、案内／状況確認 |
| 管理者個別チャットモードで転送メッセージへの管理者の返信 | `/user`、`/block`、`/unblock` | そのメッセージのユーザーを操作 |

管理権限は `ADMIN_USER_ID` だけで判定します。管理者が `/start` を個別チャットすると、既定のユーザー用メニューと本人専用の管理メニューを更新し、通常の HTTPS Webhook に `callback_query` を追加します。独自の証明書を使う Webhook は手動で更新してください。メニューはメッセージごとに設定し直しません。

ユーザーのコマンドメニューは `/start` のみです。案内のボタンで中文・English・日本語を選び、設定を保存できます。`/start` は本人の古いメニューも更新します。`/help` と `/id` は直接入力できます。未選択時はデプロイの既定値を使い、Telegram の言語では自動切り替えしません。通常の会話は既存のユーザー照会を使い、D1 の追加読み書きはありません。更新前に `0007_user_language.sql` を適用してください。案内表示時にボタンの受信設定を自動確認し、稼働中の Worker ごとに一度だけ照会します。管理者の `/start` は既定メニューと管理メニューを更新します。

`/close` はトピックを閉じるだけで、ユーザーをブロックしません。新着時は元のトピックを再開し、見つからない場合にのみ新規作成します。受信を止めるには `/block` を使ってください。失効した対応情報、古いトピック、誤った場所への管理者の返信には未送信の案内を返します。トピックに案内を送れない場合は管理者へ個別送信します。

`/status` は自身のリクエストを集計から除き、最後の転送成功からの経過時間と過去24時間の直近のエラー概要を表示します。手動確認時に既存の記録を読むだけで、ポーリング・テーブル・定期処理は追加しません。転送時刻は保存中の対応情報に基づきます。

### 初回の確認

`/start` は案内と言語ボタンを表示し、問題は出さず確認も免除しません。新しい連絡者が最初の内容を送ると、自動広告を防ぐための計算確認を案内します。5分以内に数字だけで答え、割り算は割り切れます。3回間違えると15分間待ちます。誤答への応答と計数は最低5秒間隔で、待機中の内容は無視します。`/help` と `/id` は直接入力できます。言語変更で問題や誤答回数はリセットされません。

確認前は最初のメッセージの Telegram ID、アルバムなら同じ組の最大10件の ID のみ一時保存します。本文やメディア本体は保存せず、トピックも作りません。確認後に最初の内容またはアルバムを自動転送するため、再送は不要です。答えや他の未確認メッセージは転送しません。期限切れや誤答上限では待機記録を消し、連絡内容の再送が必要です。一時参照は既存のアルバム記録の定期処理で削除します。

更新前に `0006_verification_pending_message.sql` を含む未適用のデータベース移行を適用してください。既存の消去されていない連絡者は再確認不要で、データ消去後は再確認が必要です。`CAPTCHA_ENABLED="false"` は初期設定を無効にします。`WELCOME_MESSAGE` はユーザーの `/start` に使います。

管理者が個別チャットで `/captcha` を送ると状態を確認でき、`/captcha on` または `/captcha off` で切り替えます。再デプロイは不要で、設定は D1 に保持され、デプロイの初期設定より優先されます。新規または未確認ユーザーの判定時だけ、設定を1件追加で読みます。再有効化しても連絡を許可済みのユーザーに再確認は要求せず、無効化してもブロックは解除しません。

単純な自動広告を減らすための確認で、計算できるプログラムや人は通過できます。最初の待機内容の処理後は、通常転送に D1 の読み書きは追加しません。未確認者の制御記録は7日間活動がなければ既存の定期処理で削除します。依存関係・サービス・定期処理の追加はありませんが、Webhook の既存の重複防止処理は引き続き枠を消費します。大量アクセスを防ぐ仕組みではありません。

### データと制限

D1 には転送に必要な User ID、表示名／ユーザー名、トピック／メッセージ ID、言語設定、処理状況を保存し、本文やメディア本体は保存しません。管理側にはユーザーの基本情報が表示され、匿名サービスではありません。トピックは独立した閲覧権限でもないため、管理グループには信頼できるメンバーだけを招待してください。

保存データはデプロイした管理者が管理し、ユーザー自身による消去コマンドはありません。Telegram の既存メッセージやバックアップは別途管理してください。ブロックは管理者が解除するまで保持します。`/status` は実際の送受信テストの代わりにはなりません。

30 日を超えたメッセージの対応情報は次の定期クリーンアップで削除します。対応が失効すると古いメッセージの編集や管理者個別チャットモードの返信を転送できない場合があります。Telegram のコピー実行後に応答が失われると再試行で重複する可能性があるため、再送前に両側を確認してください。対応の保存は再試行し、失敗時はコピーの取り消しを試みます。両方失敗すると自動再送を止め、送信者に通知します。

再試行の上限に達すると、元の送信者への停止通知を試みます。同じ更新の再配信で通知を繰り返しません。未着が確定したわけではないため、再送前に相手へ確認してください。Telegram が利用できない場合は通知も失敗し得ますが、元のメッセージの転送は再開しません。

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
> Check my OS, Node.js 24 or newer, pnpm, PowerShell 7 on Windows, and Cloudflare/Telegram setup. Ask only for missing choices: new or existing deployment, admin and default language `zh`/`ja`/`en`, and topic mode or admin private-chat mode. Offer optional welcome, blocked-user, rate-limit, and unsupported-message notices, a message interval, and a cleanup schedule; otherwise use safe defaults. Help me install any missing tools.
>
> Use my Worker, D1, and bot, and obtain my numeric admin/group IDs safely with `tools/`. Follow the steps below for dependencies, tests, `wrangler.jsonc`, `vars.BOT_LANGUAGE`, database migrations, Secrets/Variables, and Worker deployment. For a new deployment, confirm `/ready` before registering the webhook. For an existing deployment, identify its resources, back up D1, and reuse its settings and credentials.
>
> Follow the public-content rules below. Handle tokens only through secure local input or Secret fields, never chat, output, or Git; keep private data in Git-ignored locations. Without my request, do not overwrite existing settings, recreate resources, rotate credentials, delete recovery backups, change source code, push to GitHub, or create a Release/tag.
>
> Keep the first-contact arithmetic check enabled unless I request otherwise. Apply all pending database migrations before upgrading. With a test account, verify the welcome and language buttons on `/start`, all three saved language choices on `/start`, the check on the first contact message, and automatic relay after passing.
>
> Verify `/health`, `/ready`, webhook status, and the safe runtime probe, then guide me through a real send-and-reply test with a non-admin account. Have the admin send `/start` and `/status` privately to the bot. If blocked, explain why and give my next action; do not report unverified work as complete. Finish with the bot link, Worker URL, mode, language, checks, and credential storage location, without secret values.

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

Set your Worker and D1 names and `vars.BOT_LANGUAGE` (`zh`, `ja`, or `en`; default `zh`) in `wrangler.jsonc`. This sets the admin language and the default for users who have not chosen one. Users can choose any of the three languages in the same bot; the admin language and conversation content remain unchanged.

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
| `CAPTCHA_ENABLED` | Text, optional | Initial arithmetic-check default: `true` / `false`, default `true`; the admin's in-bot setting takes precedence |

Unset notices use the matching language's defaults. Custom text applies only to the deployment language and is limited to 4096 characters; other languages use built-in translations. Change the [cleanup schedule](https://developers.cloudflare.com/workers/configuration/cron-triggers/) under `triggers.crons`, using UTC: the example `17 3 * * *` means daily at 03:17 UTC, not the user's local time. Disabling the schedule also disables periodic cleanup.

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
| User's private chat with the bot | `/start`, `/help`, `/id` | Welcome message, instructions, own User ID |
| Admin's private chat with the bot | `/start`, `/help`, `/status` | Set command menu, show help, see 24-hour processing and webhook pending count |
| Admin's private chat with the bot | `/unblock USER_ID` | Unblock by ID, including blocked users who erased their data |
| Admin's private chat with the bot | `/captcha`, `/captcha on`, `/captcha off` | Show, enable, or disable the first-contact check |
| User topic in the admin group | `/user`, `/block`, `/unblock`, `/close`, `/help`, `/status` | User details, block/unblock, close topic, help/status |
| Admin private-chat mode: reply to a relayed message | `/user`, `/block`, `/unblock` | Act on the user belonging to that message |

Only `ADMIN_USER_ID` grants admin access. The admin sends `/start` privately to refresh the default user menu and their private admin menus, and subscribe standard HTTPS webhooks to `callback_query`. Webhooks with a custom certificate need a manual subscription update. Menus are not reset on every message.

The user command menu contains only `/start`. Buttons below the welcome message select 中文, English, or 日本語 and save the choice. Each `/start` also replaces that user's old menu. `/help` and `/id` remain available by typing them. Users without a choice use the deployment default, regardless of Telegram language. Normal chat reuses existing user queries with no extra D1 reads or writes. Apply `0007_user_language.sql` before upgrading. Opening the welcome message checks button subscriptions once per warm Worker; the admin's `/start` refreshes default and admin menus.

`/close` closes a topic without blocking the user. New messages reopen the original topic; a new topic is created only if the old one cannot be found. Use `/block` to stop accepting messages. Admin replies with expired mappings, in old topics, or in the wrong place receive a not-sent notice. If the topic cannot receive that notice, it is sent privately to the admin.

`/status` excludes its own request and shows the time since the latest successful relay and a brief summary of the latest issue in the past 24 hours. It reads existing records only when requested, with no added polling, tables, or schedules. Relay times reflect retained mappings.

### First-contact check

`/start` shows the welcome and language buttons, without a question or a verification exemption. A new contact's first content message triggers an arithmetic check explaining that it reduces automated ads. Reply with digits only within 5 minutes; division always has an integer answer. Three wrong answers require a 15-minute wait. Wrong attempts and responses are spaced at least 5 seconds apart, and content during the cooldown is ignored. `/help` and `/id` remain available by typing them; changing language does not reset the question or wrong attempts.

Before passing, only the first message's Telegram ID is staged, or up to 10 IDs belonging to the first album. No text or media content is stored and no topic is created. Passing automatically relays that first message or album, without resending. Answers and other unverified messages are not replayed. Expiry or too many wrong answers clears the pending references, requiring a new contact message. Temporary references use the existing album cleanup cycle.

Apply all pending migrations, including `0006_verification_pending_message.sql`, before upgrading. Existing contacts whose data was not erased keep access; returning users who erased their data verify again. `CAPTCHA_ENABLED="false"` sets the initial default to off. `WELCOME_MESSAGE` applies to users' `/start`.

The admin sends `/captcha` privately to view the state, or `/captcha on` / `/captcha off` to change it without redeploying. The setting persists in D1 and takes precedence over the deployment default. Only new or unverified contacts add one settings-row read when needed. Re-enabling does not require previously admitted contacts to verify again, and disabling does not remove existing blocks.

This reduces simple automated ads; programs that solve arithmetic and people can still pass. After the first pending message is handled, normal traffic adds no D1 queries or writes. Unverified contacts' control records are removed after 7 inactive days by the existing cleanup. No dependencies, services, or schedules are added. Existing webhook deduplication still consumes quota on each update; this is not flood protection.

### Data and limits

D1 stores routing-related User IDs, display names/usernames, topic/message IDs, language preferences, and processing state, not message text or media content. The admin sees basic user information; this is not an anonymous service. Topics are not separate read-access boundaries, so invite only trusted members to the admin group.

Stored data is managed by the deployment owner; there is no user self-service erasure command. Existing Telegram messages and backups are managed separately. Blocks remain until the admin removes them. `/status` does not replace a real send-and-reply test.

Mappings older than 30 days are removed at the next scheduled cleanup. Once a mapping expires, old-message edits or replies in admin private-chat mode may no longer be routable. If Telegram copies a message but its response is lost, retrying can still deliver a duplicate; check both sides before resending. Mapping saves are retried, then the bot tries to remove the copy. If both fail, it stops automatic resending and notifies the sender.

When processing retries are exhausted, the bot attempts to notify the original sender that retries have stopped. Duplicate updates do not trigger the notice again. This does not confirm non-delivery: check with the recipient before resending. The notice can also fail if Telegram is unavailable; that failure does not restart relay attempts.

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

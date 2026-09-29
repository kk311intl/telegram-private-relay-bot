# Telegram 私訊轉送 Bot

[中文](#zh) · [日本語](#ja) · [English](#en)

Version: v1.2.2 · License: [GPL-3.0-only](LICENSE)

<a id="zh"></a>

## 中文

**免自管伺服器：** 部署在 Cloudflare Workers 與 D1，Webhook 收件和回覆由 Worker 處理；無需自架或維護常駐主機。仍需 Cloudflare 帳號、Telegram Bot Token 和管理者 ID；Topic 模式另需管理群組。

### AI 部署提示詞

把 repository 連結和這段提示詞交給能讀取檔案、執行終端指令的 AI coding agent；帳號登入、BotFather 和安全輸入仍由你完成。

> 我沒有程式經驗。請把這個 repository 當成部署說明，直接帶我完成一個可用的 Telegram 私聊轉送 Bot；你負責讀取檔案、執行指令、修改本機設定及驗證，我只完成必須由帳號持有人操作的登入、BotFather、權限授予和安全輸入。不要只給我一串指令，也不要擅自改寫 Bot 程式。
>
> 先檢查我的作業系統、終端、Node.js、pnpm、PowerShell 7（若使用 Windows 腳本）、Cloudflare／Telegram 的準備狀態，以及此工程是否已有正在運行的部署。只問我缺少的必要選項：新建或沿用部署、Bot 固定語言 `zh`／`ja`／`en`、Topic 群組或管理者私聊模式；再讓我選擇是否自訂歡迎訊息、封鎖／節流／無法轉送提示、訊息間隔與清理排程，未指定就沿用安全預設。所有 Worker 名稱、D1、管理者 ID、群組 ID、Bot 和 Webhook 都要使用我的資料，不沿用原作者的環境。若沿用現有部署，先辨識 Worker、D1 與 Webhook，避免覆寫或重建。缺少工具時引導我安裝，然後接續工作。
>
> 依 README 與現有 `tools/` 腳本完成依賴安裝、測試、複製受 Git 忽略的 `wrangler.jsonc`、安全取得我的數字 `ADMIN_USER_ID`（Topic 模式也取得 `ADMIN_GROUP_ID`）、設定 Worker／D1／`vars.BOT_LANGUAGE`、建立或沿用 D1、套用 migrations、設定 Cloudflare Secrets／Variables、部署 Worker、註冊 Telegram Webhook。每一步請先說明我需做的唯一操作，完成後自行核對結果再進下一步；不要讓我手寫程式或自行猜設定值。Bot Token、Cloudflare Token、Webhook Secret 只能透過本機安全輸入或 Cloudflare Secret 欄位處理，不要請我貼進聊天、終端輸出、Git 或公開檔案；不要刪除或輪替既有憑證，除非我明確要求。
>
> 最後實際檢查 `/health`、`/ready`、Webhook 狀態和專案提供的安全 runtime probe，並引導我用非管理者 Telegram 帳號完成「私聊 → 管理端收到 → 回覆 → 使用者收到」測試。若環境或權限阻止某一步，說清楚阻礙與我需要做的下一個動作；不要宣稱未驗證的步驟已完成。成功後用白話列出 Bot 連結、Worker 網址、選定語言、部署模式、檢查結果與需要我保管的憑證位置，不顯示秘密值。

這個 Bot 把 Telegram 私聊轉送到管理超級群組中每位使用者專屬的 Topic，管理者可直接回覆。未設定管理群組時，改用管理者私聊作為備用模式。以 Cloudflare Worker、D1 和 Telegram Webhook 運作；不儲存訊息文字或媒體內容。

### 準備

- Node.js 22 以上、pnpm、Cloudflare 帳號和 Telegram Bot Token；Windows 腳本另需 PowerShell 7。
- Topic 模式需要啟用話題的超級群組，Bot 須有傳送訊息及管理話題權限。
- `tools/*.ps1` 使用 Windows DPAPI 儲存本機加密憑證；在其他系統上可直接使用 Wrangler 並自行安全管理 Token。

### 部署

以下命令在工程目錄的 PowerShell 7 執行；若已在 `pwsh` 中，可直接執行 `./tools/` 下的腳本。

```powershell
pnpm install --frozen-lockfile
pnpm run check
Copy-Item wrangler.jsonc.example wrangler.jsonc
```

先在 `wrangler.jsonc` 設定自己的 Worker 名稱、D1 名稱及 `vars.BOT_LANGUAGE`（`zh`、`ja` 或 `en`，預設 `zh`）。每個部署實例固定一種語言，不依使用者的 Telegram 語言切換；不同語言的實例應使用各自的 Worker、D1、Telegram Bot Token、Webhook，以及 Topic 模式的管理群組。建立新資料庫後，把傳回的 `database_id` 填入該檔；不要把真正的 ID 提交到 Git。既有資料庫請直接填入原 ID，勿重新建立。

新 Bot 尚未註冊 Webhook 時，先用自己的 Telegram 帳號私聊該 Bot 傳送 `/id`，再執行 `./tools/Get-TelegramUserId.ps1` 取得並確認自己的數字 `ADMIN_USER_ID`。腳本隱藏輸入 Bot Token、不保存它；若顯示多個候選 ID，請確認哪個帳號是自己。已有 Webhook 的部署則從現有設定取得 ID，不要用 `getUpdates`。

```powershell
./tools/Save-CloudflareToken.ps1
./tools/Test-CloudflareToken.ps1
./tools/Invoke-WithCloudflareToken.ps1 d1 create YOUR_D1_NAME
./tools/Invoke-WithCloudflareToken.ps1 d1 migrations apply BOT_DB --remote --config wrangler.jsonc
./tools/Invoke-WithCloudflareToken.ps1 deploy --keep-vars --config wrangler.jsonc
```

Cloudflare API Token 需要 Workers Scripts Edit 和 D1 Edit 權限。加密副本只留在本機 `private-credentials/`；已有副本時，保存腳本預設不覆寫，明確更新才加 `-Force`。`wrangler.jsonc` 已被忽略；`keep_vars` 讓後續部署保留 Cloudflare 控制台中的設定。

在 Cloudflare Worker 的 Variables and Secrets 設定：

| 名稱 | 類型 | 說明 |
|---|---|---|
| `BOT_TOKEN` | Secret | 從 BotFather 取得 |
| `WEBHOOK_SECRET` | Secret | 使用下方腳本產生，與註冊 Webhook 使用同一值 |
| `ADMIN_USER_ID` | Text | 管理者的數字 Telegram User ID |
| `ADMIN_GROUP_ID` | Text，可選 | 啟用話題的超級群組 ID；省略則使用管理者私聊模式 |
| `WELCOME_MESSAGE` | Text，可選 | 覆蓋該部署語言的 `/start` 歡迎訊息 |
| `BLOCKED_MESSAGE` | Text，可選 | 覆蓋封鎖使用者收到的提示 |
| `RATE_LIMIT_MESSAGE` | Text，可選 | 覆蓋傳送過快提示 |
| `UNSUPPORTED_MESSAGE` | Text，可選 | 覆蓋訊息無法轉送提示 |
| `MESSAGE_INTERVAL_SECONDS` | Text，可選 | 一般訊息間隔，預設 2 秒，範圍 0–60 |

這些訊息未設定時使用 `BOT_LANGUAGE` 的預設翻譯；自訂文字最多 4096 字元，只影響該 Worker 部署。清理排程可在 `wrangler.jsonc` 的 `triggers.crons` 調整，其餘重試、保留期限等安全邊界屬程式行為，並非原作者的私人設定。

```powershell
./tools/New-WebhookSecret.ps1
./tools/Copy-WebhookSecret.ps1
# 貼入 Cloudflare Secret 並儲存後：
Set-Clipboard $null
./tools/Register-TelegramWebhook.ps1 -WorkerUrl 'https://YOUR_WORKER.workers.dev'
```

最後一個腳本會隱藏輸入 Bot Token，並只訂閱 `message` 和 `edited_message`。已有 Secret 時，`New-WebhookSecret.ps1` 會拒絕覆寫；若要輪替，須同步更新 Cloudflare Secret 和 Telegram Webhook。

不知道群組 ID 時，可先註冊 Webhook，再由管理者在目標群組傳送 `/setup`，把 Bot 回覆的 ID 填入 `ADMIN_GROUP_ID` 並儲存部署。Webhook 尚未註冊時，可先在群組傳送訊息，再執行 `./tools/Get-TelegramChatIds.ps1`。

### 使用與檢查

使用者私聊 Bot；Topic 模式由管理者在對應 Topic 回覆，私聊模式則須直接回覆 Bot 轉來的訊息。支援文字、一般媒體、相簿和編輯同步；Telegram 不允許複製的訊息類型無法轉送。使用者可用 `/start`、`/id`。Topic 模式的管理者可在 Topic 使用 `/user`、`/block`、`/unblock`、`/close`、`/help`；私聊模式須回覆對應訊息才能使用 `/user`、`/block`、`/unblock`。管理者可直接私聊 Bot 傳 `/status` 查看近 24 小時的處理狀態與 Webhook 待處理數；Topic 模式也可在管理群組的 Topic 使用。管理者私聊 Bot 傳 `/start` 會設定只有本人可見、依部署模式區分的 Telegram 指令選單；`/close` 僅適用於 Topic。

使用者傳 `/forget` 會先看到確認說明，只有傳 `/forget confirm` 才清除 Bot 的 D1 個人資料、相簿暫存及轉送對照。若使用者被封鎖，仍保留 ID 與封鎖狀態，避免清除指令繞過封鎖；管理者可在 Bot 私聊傳 `/unblock 使用者ID` 解封。這**不會刪除 Telegram 兩端已有的聊天訊息或既有備份**；之後再傳訊可能重新建立資料。`/status` 是運行狀態摘要，不能替代真人收發測試。

```powershell
Invoke-RestMethod 'https://YOUR_WORKER.workers.dev/health'
Invoke-RestMethod 'https://YOUR_WORKER.workers.dev/ready'
./tools/Get-TelegramWebhookInfo.ps1
./tools/Test-WorkerRuntime.ps1 -WorkerUrl 'https://YOUR_WORKER.workers.dev'
```

`/ready` 檢查設定與 D1，不檢查 Telegram 權限。正式環境探針會送安全的測試更新並清除其 D1 紀錄，但不會驗證 Telegram 實際收發；仍須用非管理者帳號實測「私聊 → 管理端收到 → 管理者回覆 → 使用者收到」。若使用自訂設定檔，探針也須加上 `-Config '你的設定檔路徑'`，以清理正確的 D1。

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
> README と既存の `tools/` スクリプトに従い、依存関係のインストール、テスト、Git の対象外である `wrangler.jsonc` の作成、私の数字の `ADMIN_USER_ID`（トピックモードでは `ADMIN_GROUP_ID` も）の安全な確認、Worker／D1／`vars.BOT_LANGUAGE` の設定、D1 の新規作成または再利用、migrations の適用、Cloudflare Secrets／Variables の設定、Worker のデプロイ、Telegram Webhook の登録まで進めてください。各段階で私が行う必要のある操作を一つだけ説明し、結果を確認してから次に進んでください。私にコードを書かせたり設定値を推測させたりしないでください。Bot Token、Cloudflare Token、Webhook Secret はローカルの安全な入力または Cloudflare の Secret 欄だけで扱い、チャット、コマンド出力、Git、公開ファイルに貼るよう求めないでください。明示的な依頼なしに既存の認証情報を削除・更新しないでください。
>
> 最後に `/health`、`/ready`、Webhook の状態、プロジェクトの安全な runtime probe を実際に確認し、管理者以外の Telegram アカウントで「私信 → 管理側への到着 → 返信 → ユーザーへの到着」を私が試せるよう案内してください。環境や権限で止まったら理由と私が次に行う操作を明確にし、未確認の項目を完了と報告しないでください。成功時は Bot のリンク、Worker URL、選んだ言語、運用モード、検証結果、保管すべき認証情報の場所を平易にまとめ、秘密の値は表示しないでください。

Telegram の私信を、管理用スーパーグループ内のユーザー別トピックへ転送する Bot です。管理者はトピックから返信できます。管理グループを設定しない場合は管理者への私信を使います。Cloudflare Worker、D1、Telegram Webhook で動作し、メッセージ本文やメディア本体は保存しません。

### 必要なもの

- Node.js 22 以降、pnpm、Cloudflare アカウント、Telegram Bot Token。Windows のスクリプトには PowerShell 7 も必要です。
- トピックを使う場合はトピックを有効にしたスーパーグループと、Bot の送信・トピック管理権限。
- `tools/*.ps1` は Windows DPAPI でローカルの認証情報を暗号化します。他の OS では Wrangler を直接使い、Token を安全に管理してください。

### デプロイ

以下はプロジェクトのディレクトリで PowerShell 7 から実行します。`pwsh` を使用中なら `./tools/` のスクリプトを直接実行できます。

```powershell
pnpm install --frozen-lockfile
pnpm run check
Copy-Item wrangler.jsonc.example wrangler.jsonc
```

`wrangler.jsonc` に自分の Worker 名、D1 名、`vars.BOT_LANGUAGE`（`zh`、`ja`、`en` のいずれか。既定は `zh`）を設定します。各デプロイは一つの言語を使用し、Telegram ユーザーの言語によって切り替えません。言語別のデプロイには、それぞれ別の Worker、D1、Telegram Bot Token、Webhook、トピックモードの管理グループを用意してください。新しいデータベースを作成したら、返された `database_id` を同ファイルに記入します。実際の ID は Git にコミットしないでください。既存の D1 を使う場合はその ID を記入し、再作成しません。

新しい Bot で Webhook を登録する前に、自分の Telegram アカウントから Bot に `/id` を私信し、`./tools/Get-TelegramUserId.ps1` を実行して自分の数字の `ADMIN_USER_ID` を確認します。Bot Token の入力は非表示で、保存されません。候補が複数ある場合は自分のアカウントを確認してください。すでに Webhook がある場合は既存の設定から ID を取得し、`getUpdates` は使用しません。

```powershell
./tools/Save-CloudflareToken.ps1
./tools/Test-CloudflareToken.ps1
./tools/Invoke-WithCloudflareToken.ps1 d1 create YOUR_D1_NAME
./tools/Invoke-WithCloudflareToken.ps1 d1 migrations apply BOT_DB --remote --config wrangler.jsonc
./tools/Invoke-WithCloudflareToken.ps1 deploy --keep-vars --config wrangler.jsonc
```

Cloudflare API Token には Workers Scripts Edit と D1 Edit が必要です。暗号化されたローカルコピーは `private-credentials/` に保存します。既存のコピーは保存スクリプトで上書きされません。明示的に更新する場合のみ `-Force` を指定してください。`wrangler.jsonc` は Git の対象外で、`keep_vars` により次回のデプロイでも Cloudflare 側の設定が保持されます。

Cloudflare Worker の Variables and Secrets に次を設定します。

| 名前 | 種類 | 内容 |
|---|---|---|
| `BOT_TOKEN` | Secret | BotFather で取得 |
| `WEBHOOK_SECRET` | Secret | 下記スクリプトで生成し、Webhook 登録にも同じ値を使用 |
| `ADMIN_USER_ID` | Text | 管理者の数字の Telegram User ID |
| `ADMIN_GROUP_ID` | Text、省略可 | トピックを有効にしたスーパーグループの ID。省略時は管理者への私信を使用 |
| `WELCOME_MESSAGE` | Text、省略可 | デプロイ言語の `/start` 応答文を上書き |
| `BLOCKED_MESSAGE` | Text、省略可 | ブロックされたユーザーへの案内を上書き |
| `RATE_LIMIT_MESSAGE` | Text、省略可 | 送信頻度の案内を上書き |
| `UNSUPPORTED_MESSAGE` | Text、省略可 | 転送できないメッセージの案内を上書き |
| `MESSAGE_INTERVAL_SECONDS` | Text、省略可 | 通常メッセージの間隔。既定は 2 秒、範囲は 0–60 |

メッセージを設定しなければ `BOT_LANGUAGE` の既定の翻訳を使用します。カスタマイズできる文は最大 4096 文字で、その Worker デプロイだけに適用されます。クリーンアップ時刻は `wrangler.jsonc` の `triggers.crons` で変更できます。再試行や保存期間などの安全上の制限はプログラムの動作であり、元の作者の個人設定ではありません。

```powershell
./tools/New-WebhookSecret.ps1
./tools/Copy-WebhookSecret.ps1
# Cloudflare の Secret に貼り付けて保存した後：
Set-Clipboard $null
./tools/Register-TelegramWebhook.ps1 -WorkerUrl 'https://YOUR_WORKER.workers.dev'
```

最後のスクリプトは Bot Token を非表示で入力し、`message` と `edited_message` のみを購読します。既存の Secret は `New-WebhookSecret.ps1` で上書きされません。変更時は Cloudflare Secret と Telegram Webhook を同時に更新してください。

グループ ID が不明な場合は、Webhook 登録後に管理者が対象グループで `/setup` を送り、Bot が返した ID を `ADMIN_GROUP_ID` に設定して保存・デプロイします。登録前ならグループでメッセージを送ってから `./tools/Get-TelegramChatIds.ps1` を実行できます。

### 使い方と確認

ユーザーは Bot に私信を送ります。トピックモードでは管理者が該当トピックで返信し、私信モードでは Bot から転送されたメッセージに返信します。テキスト、通常のメディア、アルバム、編集の同期に対応します。Telegram がコピーを許可しない種類のメッセージは転送できません。ユーザー用コマンドは `/start`、`/id` です。トピックモードでは管理者がトピック内で `/user`、`/block`、`/unblock`、`/close`、`/help` を使えます。私信モードでは対象メッセージへの返信で `/user`、`/block`、`/unblock` を使います。管理者は Bot との私信で `/status` を送ると過去24時間の処理状況と Webhook の保留件数を確認できます。トピックモードでは管理グループのトピック内でも使えます。管理者が Bot との私信で `/start` を送ると、本人だけに表示されるモード別の Telegram コマンドメニューが設定されます。`/close` はトピック専用です。

ユーザーが `/forget` を送ると確認方法が表示され、`/forget confirm` を送った場合にのみ Bot の D1 に保存された個人情報、アルバムの一時データ、転送対応が消去されます。ブロック中の場合は、ブロックを回避できないよう ID とブロック状態だけが残り、管理者は Bot との私信で `/unblock ユーザーID` を送って解除できます。**Telegram の両側に既にあるチャットメッセージと既存のバックアップは削除されません**。再送信すると情報が作成される場合があります。`/status` は稼働状況の要約であり、実際の送受信テストの代わりにはなりません。

```powershell
Invoke-RestMethod 'https://YOUR_WORKER.workers.dev/health'
Invoke-RestMethod 'https://YOUR_WORKER.workers.dev/ready'
./tools/Get-TelegramWebhookInfo.ps1
./tools/Test-WorkerRuntime.ps1 -WorkerUrl 'https://YOUR_WORKER.workers.dev'
```

`/ready` は設定と D1 を確認しますが、Telegram 側の権限は確認しません。運用テストは安全な更新を送信して D1 のテスト行を消去しますが、Telegram での実際の送受信は検証しません。最後に管理者以外のアカウントで「私信 → 管理側への到着 → 管理者の返信 → ユーザーへの到着」を確認してください。独自の設定ファイルを使う場合は、テストにも `-Config '設定ファイルのパス'` を指定し、正しい D1 のテスト行を消去してください。

### ライセンス

このプロジェクトは [GPL-3.0-only](LICENSE) で公開しています。トピックへの振り分けは [Roddy-D/cloudflare-telegrambot](https://github.com/Roddy-D/cloudflare-telegrambot) のアイデアを参考にしました。

<a id="en"></a>

## English

**No server to maintain:** Deploy on Cloudflare Workers and D1. The Worker receives webhooks and handles replies, so no always-on server is needed. You still need a Cloudflare account, a Telegram Bot Token, and an admin ID; topic mode also needs an admin group.

### AI deployment prompt

Give the repository link and this prompt to an AI coding agent that can read files and run terminal commands. You still handle account sign-in, BotFather, and secure credential entry.

> I have no coding experience. Read this repository as the deployment guide and take me through publishing a working Telegram private-message relay Bot. You handle file inspection, commands, local configuration, and verification; guide me one action at a time through only the account-holder steps such as sign-in, BotFather, permission grants, and secure input. Do not merely give me a list of commands, and do not change the Bot's source code unless a real deployment blocker requires it and you explain why.
>
> First check my OS, terminal, Node.js, pnpm, PowerShell 7 if using the Windows scripts, Cloudflare and Telegram readiness, and whether this project already has a live deployment. Ask only for missing essentials: new versus existing deployment, one fixed Bot language (`zh`, `ja`, or `en`), and topic-based admin group versus admin private-chat mode. Offer me optional customization of the welcome, blocked-user, rate-limit, and unsupported-message notices, the message interval, and the cleanup schedule; keep safe defaults when I do not choose. Use my own Worker name, D1, admin and group IDs, Bot, and webhook—never the original author's environment. For an existing installation, identify its Worker, D1, and webhook before changing anything; do not overwrite or recreate them blindly. If a tool is missing, guide me through installing it and then continue.
>
> Follow the README and existing `tools/` scripts to install dependencies, run checks, create the Git-ignored `wrangler.jsonc`, safely obtain my numeric `ADMIN_USER_ID` (and `ADMIN_GROUP_ID` for topic mode), set the Worker, D1, and `vars.BOT_LANGUAGE`, create or reuse D1, apply migrations, set Cloudflare Secrets and Variables, deploy the Worker, and register the Telegram webhook. At each stage, tell me the one action I must perform, verify the result yourself, and continue. Do not ask me to write code or guess configuration values. Handle Bot, Cloudflare, and webhook tokens only through secure local prompts or Cloudflare Secret fields; never ask me to paste them into chat, terminal output, Git, or public files. Do not delete or rotate existing credentials without my explicit request.
>
> Finally, actually check `/health`, `/ready`, the webhook status, and the project's safe runtime probe. Guide me through a real test with a non-admin Telegram account: private message → admin receives it → admin replies → user receives the reply. If access or permissions block a step, state exactly what is blocked and the single next action I need to take; never report unverified work as complete. When finished, summarize the Bot link, Worker URL, chosen language, admin mode, verification results, and where I should retain credentials, without displaying secret values.

This bot relays Telegram private messages to a separate topic for each user in an admin supergroup. The admin replies from that topic. Without a configured group, it falls back to the admin's private chat. It runs on a Cloudflare Worker with D1 and a Telegram webhook, and does not store message text or media content.

### Requirements

- Node.js 22 or newer, pnpm, a Cloudflare account, and a Telegram Bot Token; the Windows scripts also need PowerShell 7.
- Topic mode requires a supergroup with topics enabled and permission for the bot to send messages and manage topics.
- `tools/*.ps1` store local encrypted credentials with Windows DPAPI. On other systems, use Wrangler directly and manage the token securely.

### Deploy

Run these commands from the project directory in PowerShell 7. If you are already in `pwsh`, you can run scripts under `./tools/` directly.

```powershell
pnpm install --frozen-lockfile
pnpm run check
Copy-Item wrangler.jsonc.example wrangler.jsonc
```

Set your Worker and D1 names and `vars.BOT_LANGUAGE` (`zh`, `ja`, or `en`; default `zh`) in `wrangler.jsonc`. Each deployment uses one fixed language, regardless of Telegram users' language settings. Use a separate Worker, D1, Telegram Bot Token, webhook, and topic-mode admin group for each language-specific deployment. For a new database, put the returned `database_id` in that file; never commit the real ID. For an existing database, enter its ID and skip creation.

For a new Bot, before registering its webhook, send `/id` in a private chat with it from your own Telegram account. Run `./tools/Get-TelegramUserId.ps1` and confirm your numeric `ADMIN_USER_ID`. The script hides the Bot Token input and does not save it; if multiple IDs appear, identify your own account. For a deployment with an existing webhook, get the ID from its current configuration instead of using `getUpdates`.

```powershell
./tools/Save-CloudflareToken.ps1
./tools/Test-CloudflareToken.ps1
./tools/Invoke-WithCloudflareToken.ps1 d1 create YOUR_D1_NAME
./tools/Invoke-WithCloudflareToken.ps1 d1 migrations apply BOT_DB --remote --config wrangler.jsonc
./tools/Invoke-WithCloudflareToken.ps1 deploy --keep-vars --config wrangler.jsonc
```

The Cloudflare API Token needs Workers Scripts Edit and D1 Edit. Its encrypted local copy stays under `private-credentials/`. The save script will not overwrite an existing copy unless you explicitly use `-Force`. Git ignores `wrangler.jsonc`; `keep_vars` preserves settings made in the Cloudflare dashboard on later deployments.

Set these under the Worker's Variables and Secrets in Cloudflare:

| Name | Type | Purpose |
|---|---|---|
| `BOT_TOKEN` | Secret | From BotFather |
| `WEBHOOK_SECRET` | Secret | Generated below; use the same value when registering the webhook |
| `ADMIN_USER_ID` | Text | The admin's numeric Telegram User ID |
| `ADMIN_GROUP_ID` | Text, optional | Supergroup ID with topics enabled; omit for admin private-chat mode |
| `WELCOME_MESSAGE` | Text, optional | Overrides the `/start` reply for this deployment language |
| `BLOCKED_MESSAGE` | Text, optional | Overrides the notice sent to blocked users |
| `RATE_LIMIT_MESSAGE` | Text, optional | Overrides the rate-limit notice |
| `UNSUPPORTED_MESSAGE` | Text, optional | Overrides the unsupported-message notice |
| `MESSAGE_INTERVAL_SECONDS` | Text, optional | Minimum interval for ordinary messages; default 2 seconds, range 0–60 |

Unset messages use the default translation for `BOT_LANGUAGE`; overrides are limited to 4096 characters and affect only that Worker deployment. The cleanup schedule can be changed in `wrangler.jsonc` under `triggers.crons`. Retry and retention limits are program behavior, not the original author's private settings.

```powershell
./tools/New-WebhookSecret.ps1
./tools/Copy-WebhookSecret.ps1
# After pasting into the Cloudflare Secret field and saving:
Set-Clipboard $null
./tools/Register-TelegramWebhook.ps1 -WorkerUrl 'https://YOUR_WORKER.workers.dev'
```

The last script prompts for the Bot Token without displaying it and subscribes to `message` and `edited_message` only. `New-WebhookSecret.ps1` refuses to overwrite an existing secret. If you rotate it, update the Cloudflare Secret and Telegram webhook together.

If you do not know the group ID, register the webhook, have the admin send `/setup` in the target group, then set the returned ID as `ADMIN_GROUP_ID` and save/deploy. Before webhook registration, you can send a group message and run `./tools/Get-TelegramChatIds.ps1` instead.

### Use and verify

Users message the bot privately. In topic mode, the admin replies in the matching topic; in private-chat mode, the admin must reply to the relayed message. Text, ordinary media, albums, and edit syncing are supported. Telegram message types that cannot be copied cannot be relayed. Users can run `/start` and `/id`. In topic mode, the admin can run `/user`, `/block`, `/unblock`, `/close`, and `/help` inside a topic. In private-chat mode, `/user`, `/block`, and `/unblock` must be replies to a relayed message. The admin can send `/status` in the Bot's private chat to see the past 24 hours of processing and the webhook pending count; it also works in a management-group topic. Sending `/start` in the Bot's private chat sets a mode-specific Telegram command menu visible only to that admin. `/close` is topic-only.

Sending `/forget` shows confirmation instructions; only `/forget confirm` erases personal data, album staging, and relay mappings stored in the Bot's D1. For blocked users, the ID and blocked state remain so this command cannot bypass a block; the admin can later send `/unblock USER_ID` in the Bot's private chat. This **does not delete existing Telegram messages on either side or existing backups**. Sending another message may create new data. `/status` is an operational summary, not a substitute for a real two-way delivery test.

```powershell
Invoke-RestMethod 'https://YOUR_WORKER.workers.dev/health'
Invoke-RestMethod 'https://YOUR_WORKER.workers.dev/ready'
./tools/Get-TelegramWebhookInfo.ps1
./tools/Test-WorkerRuntime.ps1 -WorkerUrl 'https://YOUR_WORKER.workers.dev'
```

`/ready` checks configuration and D1, not Telegram permissions. The runtime probe sends a safe update and removes its D1 row, but does not test actual Telegram delivery. Also test the full flow with a non-admin account: private message → admin receives it → admin replies → user receives the reply. If you use a custom config file, pass `-Config 'path/to/config'` to the probe so it cleans up the correct D1 database.

### License

This project is licensed under [GPL-3.0-only](LICENSE). Topic routing was inspired by [Roddy-D/cloudflare-telegrambot](https://github.com/Roddy-D/cloudflare-telegrambot).

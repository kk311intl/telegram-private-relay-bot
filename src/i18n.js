const messages = {
  zh: {
    adminReadyTopic: "話題模式。\n請在對應使用者的話題內回覆；傳送 /help 查看指令。",
    adminReadyDirect: "管理者私訊模式。\n請回覆 Bot 轉來的使用者訊息；傳送 /help 查看指令。",
    blockedNotice: "目前無法接收你的訊息。",
    welcome: "請在此傳送訊息。管理者可透過 Bot 回覆。\n傳送 /help 查看使用說明。",
    languageSaved: "已切換為中文。傳送 /start 可再次切換。",
    userHelp: `直接傳送文字或一般媒體，管理者可透過 Bot 回覆。

/start — 查看歡迎訊息
/help — 查看使用說明
/id — 查看自己的 User ID`,
    userCommand_start: "歡迎訊息與語言選擇",
    keywordsList: "關鍵字黑名單（{count} 個）：",
    keywordsEmpty: "關鍵字黑名單目前是空的。",
    keywordsLimit: "未變更：最多 {max} 個關鍵字，每個最多 {length} 字。",
    keywordsControls: "/keywords add 詞1,詞2 — 加入\n/keywords del 詞1,詞2 — 移除\n/keywords clear — 清空\n多個用英文逗號分隔；不分大小寫與全半形，英文與數字須整個單字相符，中日文出現即算。比對文字、說明、隱藏連結、按鈕、顯示名稱與轉貼來源，命中時不轉送並自動封鎖；可用 /unblock USER_ID 解除。僅管理者私訊可修改。",
    autoBlocked: "已依關鍵字自動封鎖",
    matchedKeyword: "觸發關鍵字",
    blockedAt: "時間",
    unblockHint: "解除封鎖",
    blockNoticeOn: "自動封鎖通知：已開啟",
    blockNoticeOff: "自動封鎖通知：已關閉",
    blockNoticeTopic: "通知會發到管理群組的 General。",
    blockNoticeDirect: "通知會發到管理者私訊。",
    blockNoticeControls: "/blocknotice on — 開啟\n/blocknotice off — 關閉",
    blockedList: "封鎖中的使用者",
    blockedListLatest: "（顯示最近 {count} 位）",
    blockedListEmpty: "目前沒有封鎖中的使用者。",
    blockedListHint: "用 /unblock USER_ID 解除封鎖。",
    command_blocked: "查看封鎖清單",
    command_blocknotice: "開關自動封鎖通知",
    groupUnavailable: "管理群組目前無法使用，使用者訊息已改轉到這裡。直接回覆轉來的訊息即可送回；群組恢復後，新訊息會自動回到話題。此提示每小時最多一則。",
    failureReason: "原因",
    replyRequired: "這則訊息未送出。請使用「回覆」選擇 Bot 轉來的使用者訊息。",
    topicRequired: "這則訊息未送出。請在對應使用者的話題內回覆。",
    replyUnavailable: "這則訊息未送出：轉送對照已失效或不存在。請使用對方的新訊息或最新話題回覆。",
    retryStopped: "這則訊息未能確認處理完成，已停止自動重試。\n請先確認對方是否收到，再決定是否重送。",
    userId: "你的 Telegram User ID",
    rateLimit: "訊息傳送過快，請稍後再試。",
    blocked: "已封鎖此使用者。",
    unblocked: "已解除封鎖。",
    unknownCommand: "未知指令。請使用 /help 查看可用指令。",
    adminHelpTopic: `話題模式

在使用者的話題內：
/user — 查看使用者資料
/block — 封鎖使用者
/unblock — 解除封鎖
/close — 關閉話題，不封鎖使用者；新訊息會重開
/status — 查看近 24 小時處理狀態

私訊 Bot：
/unblock USER_ID — 依 ID 解除封鎖
/keywords — 查看關鍵字黑名單；用 add／del／clear 修改
/blocked — 查看封鎖清單
/blocknotice — 查看自動封鎖通知；用 on／off 開關
群組無法使用時，訊息改轉到私訊，直接回覆即可送回。

話題內的一般訊息會送給該使用者。`,
    adminHelpDirect: `管理者私訊模式

回覆 Bot 轉來的訊息：
/user — 查看使用者資料
/block — 封鎖使用者
/unblock — 解除封鎖

私訊 Bot：
/status — 查看近 24 小時處理狀態
/unblock USER_ID — 依 ID 解除封鎖
/keywords — 查看關鍵字黑名單；用 add／del／clear 修改
/blocked — 查看封鎖清單
/blocknotice — 查看自動封鎖通知；用 on／off 開關

一般回覆會送給該使用者。`,
    adminStatus: "近 24 小時處理狀態",
    statusDone: "已完成",
    statusProcessing: "處理中",
    statusStalled: "處理逾時（計入處理中）",
    statusFailed: "等待重試",
    statusDiscarded: "停止重試",
    statusPending: "Webhook 待處理",
    statusLastRelay: "最近成功轉送",
    statusNoRelay: "暫無保留的轉送紀錄",
    statusLastError: "近 24 小時最近異常",
    statusNoError: "無",
    failureRateLimit: "Telegram 暫時限流",
    failureUnavailable: "Telegram 連線或服務暫時異常",
    failurePermission: "對方拒收或 Bot 權限不足",
    failureUnsupported: "訊息或操作未被 Telegram 接受",
    failureProcessing: "資料處理失敗",
    unknown: "暫時無法取得",
    notBlocked: "找不到已封鎖的使用者。",
    command_start: "更新指令選單",
    command_help: "查看管理指令",
    command_status: "查看近 24 小時狀態",
    command_user: "查看使用者資料",
    command_block: "封鎖使用者",
    command_unblock: "解除封鎖",
    command_close: "關閉使用者話題",
    command_keywords: "管理關鍵字黑名單",
    unsupportedMessage: "這類訊息目前無法轉送，請改用文字或一般媒體後再試。",
    deliveryFailed: "訊息無法送達；對方可能已封鎖 Bot，或該訊息類型不支援轉送。",
    albumFailed: "相簿無法完整送達；對方可能已封鎖 Bot，或其中包含不支援的內容。",
    untrackedDelivery: "訊息可能已送達，但轉送對照保存失敗。\nBot 已停止自動重送；請先與對方確認，再決定是否重送。",
    groupId: "此群組的 ADMIN_GROUP_ID",
    newChat: "新私訊",
    receivedChat: "收到私訊",
    userDetails: "使用者資料",
    name: "顯示名稱",
    username: "使用者名稱",
    status: "封鎖狀態",
    blockedStatus: "已封鎖",
    normalStatus: "未封鎖",
    notSet: "未設定",
    notProvided: "未提供",
    user: "使用者",
    fieldSeparator: "："
  },
  ja: {
    adminReadyTopic: "トピックモードです。\nユーザーのトピックで返信してください。/help でコマンドを確認できます。",
    adminReadyDirect: "管理者個別チャットモードです。\n転送されたメッセージに返信してください。/help でコマンドを確認できます。",
    blockedNotice: "現在、メッセージを受け付けられません。",
    welcome: "ここにメッセージを送ってください。管理者はこのチャットに返信できます。\n/help で使い方を確認できます。",
    languageSaved: "日本語に変更しました。/start で再び変更できます。",
    userHelp: `テキストや一般的なメディアを送信すると、管理者が Bot を通して返信できます。

/start — 開始時のメッセージを表示
/help — 使い方を表示
/id — 自分の User ID を表示`,
    userCommand_start: "案内と言語選択",
    keywordsList: "キーワードのブロックリスト（{count} 件）：",
    keywordsEmpty: "キーワードのブロックリストは空です。",
    keywordsLimit: "変更していません：最大 {max} 件、各 {length} 文字までです。",
    keywordsControls: "/keywords add 語1,語2 — 追加\n/keywords del 語1,語2 — 削除\n/keywords clear — すべて削除\n複数は半角カンマで区切ります。大文字小文字・全角半角は区別しません。英字と数字は単語全体が一致した場合のみ、中国語・日本語は含まれていれば一致とします。テキスト、キャプション、隠しリンク、ボタン、表示名、転送元を照合し、一致すると転送せず自動でブロックします。/unblock USER_ID で解除できます。管理者の個別チャットでのみ変更できます。",
    autoBlocked: "キーワードにより自動ブロックしました",
    matchedKeyword: "一致したキーワード",
    blockedAt: "日時",
    unblockHint: "解除",
    blockNoticeOn: "自動ブロック通知：有効",
    blockNoticeOff: "自動ブロック通知：無効",
    blockNoticeTopic: "通知は管理グループの General に送ります。",
    blockNoticeDirect: "通知は管理者の個別チャットに送ります。",
    blockNoticeControls: "/blocknotice on — 有効にする\n/blocknotice off — 無効にする",
    blockedList: "ブロック中のユーザー",
    blockedListLatest: "（最新 {count} 件を表示）",
    blockedListEmpty: "ブロック中のユーザーはいません。",
    blockedListHint: "/unblock USER_ID で解除できます。",
    command_blocked: "ブロック一覧を表示",
    command_blocknotice: "自動ブロック通知を設定",
    groupUnavailable: "管理グループが現在使えないため、ユーザーのメッセージをこちらに転送しています。転送されたメッセージに返信すると相手に届きます。グループが復旧すると、新しいメッセージは自動でトピックに戻ります。この通知は1時間に最大1回です。",
    failureReason: "原因",
    replyRequired: "このメッセージは送信されていません。Bot が転送したユーザーのメッセージを選んで返信してください。",
    topicRequired: "このメッセージは送信されていません。該当ユーザーのトピックで返信してください。",
    replyUnavailable: "このメッセージは送信されていません。転送の対応情報が失効したか、存在しません。ユーザーの新しいメッセージか最新のトピックから返信してください。",
    retryStopped: "このメッセージの処理完了を確認できず、自動再試行を停止しました。\n再送する前に、相手に届いているか確認してください。",
    userId: "あなたの Telegram User ID",
    rateLimit: "メッセージの送信が速すぎます。しばらくしてからお試しください。",
    blocked: "このユーザーをブロックしました。",
    unblocked: "このユーザーのブロックを解除しました。",
    unknownCommand: "不明なコマンドです。/help で利用可能なコマンドを確認してください。",
    adminHelpTopic: `トピックモード

ユーザーのトピック内：
/user — ユーザー情報を表示
/block — ユーザーをブロック
/unblock — ブロックを解除
/close — トピックを閉じる（新着時に再開し、ブロックはしません）
/status — 過去24時間の処理状況を表示

Bot との個別チャット：
/unblock USER_ID — ID でブロックを解除
/keywords — キーワードのブロックリストを表示・編集（add／del／clear）
/blocked — ブロック一覧を表示
/blocknotice — 自動ブロック通知を表示・設定（on／off）
グループが使えない間はメッセージをこの個別チャットに転送し、返信すると相手に届きます。

トピック内の通常のメッセージは、そのユーザーに送られます。`,
    adminHelpDirect: `管理者個別チャットモード

転送されたメッセージへの返信：
/user — ユーザー情報を表示
/block — ユーザーをブロック
/unblock — ブロックを解除

Bot との個別チャット：
/status — 過去24時間の処理状況を表示
/unblock USER_ID — ID でブロックを解除
/keywords — キーワードのブロックリストを表示・編集（add／del／clear）
/blocked — ブロック一覧を表示
/blocknotice — 自動ブロック通知を表示・設定（on／off）

通常の返信は、そのユーザーに送られます。`,
    adminStatus: "過去24時間の処理状況",
    statusDone: "完了",
    statusProcessing: "処理中",
    statusStalled: "処理期限切れ（処理中の内訳）",
    statusFailed: "再試行待ち",
    statusDiscarded: "再試行なし",
    statusPending: "Webhook の保留件数",
    statusLastRelay: "最後に転送に成功した時刻",
    statusNoRelay: "保存中の転送記録はありません",
    statusLastError: "過去24時間の直近のエラー",
    statusNoError: "なし",
    failureRateLimit: "Telegram の一時的な送信制限",
    failureUnavailable: "Telegram の接続またはサービスの一時的な問題",
    failurePermission: "相手の受信拒否または Bot の権限不足",
    failureUnsupported: "Telegram がメッセージまたは操作を受け付けませんでした",
    failureProcessing: "データ処理の失敗",
    unknown: "取得できません",
    notBlocked: "ブロック中のユーザーが見つかりません。",
    command_start: "コマンドメニューを更新",
    command_help: "管理コマンドを表示",
    command_status: "過去24時間の状況を表示",
    command_user: "ユーザー情報を表示",
    command_block: "ユーザーをブロック",
    command_unblock: "ブロックを解除",
    command_close: "ユーザートピックを閉じる",
    command_keywords: "キーワードのブロックリストを管理",
    unsupportedMessage: "この種類のメッセージは転送できません。テキストまたは一般的なメディアで再度お試しください。",
    deliveryFailed: "メッセージを届けられませんでした。相手が Bot をブロックしているか、この種類のメッセージを転送できない可能性があります。",
    albumFailed: "アルバムを完全には届けられませんでした。相手が Bot をブロックしているか、対応していない内容が含まれている可能性があります。",
    untrackedDelivery: "メッセージは届いた可能性がありますが、メッセージの対応情報を保存できませんでした。\n自動再送を停止しました。相手に確認してから再送を判断してください。",
    groupId: "このグループの ADMIN_GROUP_ID",
    newChat: "新しい個別チャット",
    receivedChat: "個別チャットを受信",
    userDetails: "ユーザー情報",
    name: "表示名",
    username: "ユーザー名",
    status: "ブロック状態",
    blockedStatus: "ブロック中",
    normalStatus: "ブロックなし",
    notSet: "未設定",
    notProvided: "未入力",
    user: "ユーザー",
    fieldSeparator: "："
  },
  en: {
    adminReadyTopic: "Topic mode.\nReply in the user's topic. Send /help for commands.",
    adminReadyDirect: "Admin private-chat mode.\nReply to a message relayed by the bot. Send /help for commands.",
    blockedNotice: "This bot is not accepting your messages right now.",
    welcome: "Send a message here. The admin can reply in this chat.\nSend /help for instructions.",
    languageSaved: "Language set to English. Use /start to change it again.",
    userHelp: `Send text or standard media here. The admin can reply through the bot.

/start — Show the welcome message
/help — Show instructions
/id — Show your User ID`,
    userCommand_start: "Welcome and language",
    keywordsList: "Keyword blocklist ({count}):",
    keywordsEmpty: "The keyword blocklist is empty.",
    keywordsLimit: "Not changed: up to {max} keywords, {length} characters each.",
    keywordsControls: "/keywords add word1,word2 — Add\n/keywords del word1,word2 — Remove\n/keywords clear — Remove all\nSeparate multiple keywords with commas. Matching ignores case and full/half width. Latin words and numbers must match as whole words; Chinese and Japanese match anywhere. Text, captions, hidden links, buttons, display names, and forward sources are checked; a match is not relayed and the sender is blocked automatically. Use /unblock USER_ID to undo. Only the admin can change this in their private chat.",
    autoBlocked: "Blocked automatically by keyword",
    matchedKeyword: "Matched keyword",
    blockedAt: "Time",
    unblockHint: "Unblock",
    blockNoticeOn: "Auto-block notices: on",
    blockNoticeOff: "Auto-block notices: off",
    blockNoticeTopic: "Notices go to the admin group's General topic.",
    blockNoticeDirect: "Notices go to the admin's private chat.",
    blockNoticeControls: "/blocknotice on — Turn on\n/blocknotice off — Turn off",
    blockedList: "Blocked users",
    blockedListLatest: " (latest {count} shown)",
    blockedListEmpty: "No users are blocked.",
    blockedListHint: "Use /unblock USER_ID to unblock.",
    command_blocked: "Show blocked users",
    command_blocknotice: "Manage auto-block notices",
    groupUnavailable: "The admin group is currently unavailable, so user messages are being relayed here. Reply to a relayed message to send it back. Once the group works again, new messages return to topics automatically. This alert is sent at most once an hour.",
    failureReason: "Reason",
    replyRequired: "This message was not sent. Use Reply on a user message relayed by the bot.",
    topicRequired: "This message was not sent. Reply in the matching user's topic.",
    replyUnavailable: "This message was not sent: the relay mapping has expired or does not exist. Reply to a new message from the user or use their latest topic.",
    retryStopped: "Processing could not be confirmed for this message. Automatic retries have stopped.\nCheck whether the recipient received it before deciding to resend.",
    userId: "Your Telegram User ID",
    rateLimit: "You're sending messages too quickly. Please try again shortly.",
    blocked: "User blocked.",
    unblocked: "User unblocked.",
    unknownCommand: "Unknown command. Use /help to see available commands.",
    adminHelpTopic: `Topic mode

In a user's topic:
/user — Show user details
/block — Block this user
/unblock — Unblock this user
/close — Close the topic; new messages reopen it, without blocking the user
/status — Show processing status for the past 24 hours

In your private chat with the bot:
/unblock USER_ID — Unblock by ID
/keywords — Show the keyword blocklist; use add/del/clear to edit it
/blocked — Show blocked users
/blocknotice — Show auto-block notices; use on/off to change them
If the group is unavailable, messages are relayed to this private chat instead; reply to send them back.

Regular messages in the topic go to that user.`,
    adminHelpDirect: `Admin private-chat mode

Reply to a relayed message:
/user — Show user details
/block — Block this user
/unblock — Unblock this user

In your private chat with the bot:
/status — Show processing status for the past 24 hours
/unblock USER_ID — Unblock by ID
/keywords — Show the keyword blocklist; use add/del/clear to edit it
/blocked — Show blocked users
/blocknotice — Show auto-block notices; use on/off to change them

Regular replies go to that user.`,
    adminStatus: "Processing status — past 24 hours",
    statusDone: "Completed",
    statusProcessing: "Processing",
    statusStalled: "Timed out (included in processing)",
    statusFailed: "Awaiting retry",
    statusDiscarded: "Not retrying",
    statusPending: "Telegram webhook pending",
    statusLastRelay: "Last successful relay",
    statusNoRelay: "No retained relay records",
    statusLastError: "Latest issue in the past 24 hours",
    statusNoError: "None",
    failureRateLimit: "Temporary Telegram rate limit",
    failureUnavailable: "Temporary Telegram connection or service issue",
    failurePermission: "Recipient rejected delivery or the bot lacks permission",
    failureUnsupported: "Telegram rejected the message or operation",
    failureProcessing: "Data processing failed",
    unknown: "Unavailable",
    notBlocked: "No blocked user was found.",
    command_start: "Refresh command menus",
    command_help: "Show admin commands",
    command_status: "Show past 24-hour status",
    command_user: "Show user details",
    command_block: "Block user",
    command_unblock: "Unblock user",
    command_close: "Close user topic",
    command_keywords: "Manage keyword blocklist",
    unsupportedMessage: "This type of message cannot be forwarded. Please try text or a standard media message.",
    deliveryFailed: "Message could not be delivered. The recipient may have blocked the bot, or this message type may not be supported.",
    albumFailed: "The album could not be delivered in full. The recipient may have blocked the bot, or it may contain unsupported content.",
    untrackedDelivery: "The message may have arrived, but its relay mapping could not be saved.\nAutomatic resending has stopped. Confirm with the recipient before deciding to resend.",
    groupId: "ADMIN_GROUP_ID for this group",
    newChat: "New private chat",
    receivedChat: "Private chat received",
    userDetails: "User details",
    name: "Display name",
    username: "Username",
    status: "Block status",
    blockedStatus: "Blocked",
    normalStatus: "Not blocked",
    notSet: "Not set",
    notProvided: "Not provided",
    user: "User",
    fieldSeparator: ": "
  }
};

export function t(language, key) {
  return (messages[language] || messages.zh)[key];
}

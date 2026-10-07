const messages = {
  zh: {
    adminReadyTopic: "話題模式。\n請在對應使用者的話題內回覆；傳送 /help 查看指令。",
    adminReadyDirect: "管理者私訊模式。\n請回覆 Bot 轉來的使用者訊息；傳送 /help 查看指令。",
    blockedNotice: "目前無法接收你的訊息。",
    welcome: "請在此傳送訊息。管理者可透過 Bot 回覆。",
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
/close — 關閉話題，不封鎖使用者
/status — 查看近 24 小時處理狀態

私訊 Bot：
/unblock USER_ID — 依 ID 解除封鎖

話題內的一般訊息會送給該使用者。`,
    adminHelpDirect: `管理者私訊模式

回覆 Bot 轉來的訊息：
/user — 查看使用者資料
/block — 封鎖使用者
/unblock — 解除封鎖

私訊 Bot：
/status — 查看近 24 小時處理狀態
/unblock USER_ID — 依 ID 解除封鎖

一般回覆會送給該使用者。`,
    adminStatus: "近 24 小時處理狀態",
    statusDone: "已完成",
    statusProcessing: "處理中",
    statusStalled: "處理逾時（計入處理中）",
    statusFailed: "等待重試",
    statusDiscarded: "停止重試",
    statusPending: "Webhook 待處理",
    unknown: "暫時無法取得",
    notBlocked: "找不到已封鎖的使用者。",
    forgetConfirm: `若要清除 Bot 保存的你的個人資料、相簿暫存及轉送對照，請傳送 /forget confirm。

清除範圍：
• 不會刪除 Telegram 已有的聊天訊息或既有備份。
• 清除資料不會解除封鎖。
• 為防止舊請求重建資料，會保留含 User ID 的必要紀錄；非封鎖者的紀錄在 7 天後依排程清理。
• 之後的新訊息可能重新建立資料。`,
    forgetDone: `這次資料清除已完成。

• Telegram 已有的聊天訊息和既有備份不會刪除。
• 清除資料不會解除封鎖。
• 為防止舊請求重建資料，會保留含 User ID 的必要紀錄；非封鎖者的紀錄在 7 天後依排程清理。
• 之後的新訊息可能重新建立資料。`,
    command_start: "設定管理選單",
    command_help: "查看管理指令",
    command_status: "查看近 24 小時狀態",
    command_user: "查看使用者資料",
    command_block: "封鎖使用者",
    command_unblock: "解除封鎖",
    command_close: "關閉使用者話題",
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
    welcome: "ここにメッセージを送ってください。管理者はこのチャットに返信できます。",
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
/close — トピックを閉じる（ブロックはしません）
/status — 過去24時間の処理状況を表示

Bot との個別チャット：
/unblock USER_ID — ID でブロックを解除

トピック内の通常のメッセージは、そのユーザーに送られます。`,
    adminHelpDirect: `管理者個別チャットモード

転送されたメッセージへの返信：
/user — ユーザー情報を表示
/block — ユーザーをブロック
/unblock — ブロックを解除

Bot との個別チャット：
/status — 過去24時間の処理状況を表示
/unblock USER_ID — ID でブロックを解除

通常の返信は、そのユーザーに送られます。`,
    adminStatus: "過去24時間の処理状況",
    statusDone: "完了",
    statusProcessing: "処理中",
    statusStalled: "処理期限切れ（処理中の内訳）",
    statusFailed: "再試行待ち",
    statusDiscarded: "再試行なし",
    statusPending: "Webhook の保留件数",
    unknown: "取得できません",
    notBlocked: "ブロック中のユーザーが見つかりません。",
    forgetConfirm: `Bot が保存しているあなたの個人情報、アルバムの一時データ、メッセージの対応情報を消去するには、/forget confirm と送信してください。

消去の範囲：
• Telegram の既存メッセージや既存のバックアップは削除しません。
• 消去してもブロックは解除されません。
• 古いリクエストによる再作成を防ぐため、User ID を含む必要な記録を保持します。ブロックされていないユーザーの記録は7日後の定期処理で削除します。
• その後の新しいメッセージで情報が再作成される場合があります。`,
    forgetDone: `今回のデータ消去が完了しました。

• Telegram の既存メッセージや既存のバックアップは削除しません。
• 消去してもブロックは解除されません。
• 古いリクエストによる再作成を防ぐため、User ID を含む必要な記録を保持します。ブロックされていないユーザーの記録は7日後の定期処理で削除します。
• その後の新しいメッセージで情報が再作成される場合があります。`,
    command_start: "管理メニューを設定",
    command_help: "管理コマンドを表示",
    command_status: "過去24時間の状況を表示",
    command_user: "ユーザー情報を表示",
    command_block: "ユーザーをブロック",
    command_unblock: "ブロックを解除",
    command_close: "ユーザートピックを閉じる",
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
    welcome: "Send a message here. The admin can reply in this chat.",
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
/close — Close the topic, without blocking the user
/status — Show processing status for the past 24 hours

In your private chat with the bot:
/unblock USER_ID — Unblock by ID

Regular messages in the topic go to that user.`,
    adminHelpDirect: `Admin private-chat mode

Reply to a relayed message:
/user — Show user details
/block — Block this user
/unblock — Unblock this user

In your private chat with the bot:
/status — Show processing status for the past 24 hours
/unblock USER_ID — Unblock by ID

Regular replies go to that user.`,
    adminStatus: "Processing status — past 24 hours",
    statusDone: "Completed",
    statusProcessing: "Processing",
    statusStalled: "Timed out (included in processing)",
    statusFailed: "Awaiting retry",
    statusDiscarded: "Not retrying",
    statusPending: "Telegram webhook pending",
    unknown: "Unavailable",
    notBlocked: "No blocked user was found.",
    forgetConfirm: `To erase the personal data, staged albums, and relay mappings this bot stores about you, send /forget confirm.

Erasure scope:
• Existing Telegram messages and existing backups are not deleted.
• Any block remains in effect.
• Necessary records including your User ID prevent old requests from restoring data. For unblocked users, scheduled cleanup removes these records after 7 days.
• Later new messages may create data again.`,
    forgetDone: `This data erasure request is complete.

• Existing Telegram messages and existing backups are not deleted.
• Any block remains in effect.
• Necessary records including your User ID prevent old requests from restoring data. For unblocked users, scheduled cleanup removes these records after 7 days.
• Later new messages may create data again.`,
    command_start: "Set admin command menu",
    command_help: "Show admin commands",
    command_status: "Show past 24-hour status",
    command_user: "Show user details",
    command_block: "Block user",
    command_unblock: "Unblock user",
    command_close: "Close user topic",
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

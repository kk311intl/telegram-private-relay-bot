import { t } from "./i18n.js";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_BODY_BYTES = 1_048_576;
const MAX_TOPIC_LENGTH = 128;
const UPDATE_LEASE_SECONDS = 60;
const MAX_UPDATE_ATTEMPTS = 5;
const TOPIC_LEASE_SECONDS = 30;
const MEDIA_GROUP_QUIET_MS = 900;
const CONVERSATION_WINDOW_SECONDS = 6 * 60 * 60;
const TELEGRAM_TIMEOUT_MS = 15_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "telegram-private-relay" });
    }

    if (request.method === "GET" && url.pathname === "/ready") {
      return readiness(env);
    }

    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    if (configurationIssue(env)) {
      return new Response("Service configuration error", { status: 503 });
    }

    const suppliedSecret = request.headers.get("X-Telegram-Bot-Api-Secret-Token") || "";
    if (!(await secureEqual(suppliedSecret, env.WEBHOOK_SECRET))) {
      return new Response("Forbidden", { status: 403 });
    }

    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }

    let update;
    try {
      const body = await request.text();
      if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
        return new Response("Payload too large", { status: 413 });
      }
      update = JSON.parse(body);
    } catch {
      return new Response("Bad request", { status: 400 });
    }

    if (!update || typeof update !== "object" || Array.isArray(update)
      || !Number.isSafeInteger(update.update_id)) {
      return new Response("Bad request", { status: 400 });
    }

    try {
      const claim = await claimUpdate(env.BOT_DB, update.update_id);
      if (claim === "duplicate") return json({ ok: true, duplicate: true });
      if (claim === "exhausted") return json({ ok: true, discarded: true });
      if (claim === "busy") return json({ ok: false, busy: true }, { status: 500 });
      await processUpdate(update, env);
      await finishUpdate(env.BOT_DB, update.update_id, "done");
      return json({ ok: true });
    } catch (error) {
      const retryable = isRetryableError(error);
      const storedStatus = await recordUpdateFailure(
        env.BOT_DB,
        update.update_id,
        retryable,
        error
      ).catch(() => null);
      const willRetry = retryable && storedStatus !== "discarded";
      console.log(JSON.stringify({
        event: willRetry
          ? "update_retryable_failure"
          : retryable ? "update_retry_exhausted" : "update_discarded",
        update_id: update.update_id,
        error: sanitizeError(error)
      }));
      return willRetry
        ? json(
            { ok: false },
            {
              status: 500,
              headers: error instanceof TelegramApiError && error.retryAfter > 0
                ? { "retry-after": String(Math.min(error.retryAfter, 3600)) }
                : undefined
            }
          )
        : json({ ok: true, discarded: true });
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanDatabase(env.BOT_DB));
  }
};

export async function processUpdate(update, env) {
  if (update.message) return processMessage(update.message, env);
  if (update.edited_message) return processEditedMessage(update.edited_message, env);
}

async function processMessage(message, env) {
  if (!message?.chat || message.from?.is_bot) return;

  const chatId = String(message.chat.id);
  if (message.chat.type === "private") {
    if (String(message.from.id) === String(env.ADMIN_USER_ID)) {
      return processAdminPrivateMessage(message, env);
    }
    return processUserMessage(message, env);
  }

  if (
    message.chat.type === "supergroup"
    && message.chat.is_forum
    && String(message.from.id) === String(env.ADMIN_USER_ID)
    && parseCommand(message.text) === "setup"
  ) {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id,
      text: `${t(env.BOT_LANGUAGE, "groupId")}：<code>${escapeHtml(String(message.chat.id))}</code>`,
      parse_mode: "HTML"
    });
    return;
  }

  if (chatId === String(env.ADMIN_GROUP_ID) && message.chat.is_forum) {
    return processAdminTopicMessage(message, env);
  }
}

async function processAdminPrivateMessage(message, env) {
  const command = parseCommand(message.text);
  if (command === "start" || command === "help") {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: t(env.BOT_LANGUAGE, env.ADMIN_GROUP_ID ? "adminReadyTopic" : "adminReadyDirect")
    });
    return;
  }

  if (!env.ADMIN_GROUP_ID) return processDirectAdminReply(message, env);
}

async function processUserMessage(message, env) {
  const now = Math.floor(Date.now() / 1000);
  const userId = String(message.from.id);
  let user = await getUser(env.BOT_DB, userId);

  if (await getMessageMap(env.BOT_DB, String(message.chat.id), message.message_id)) return;

  if (user?.blocked) {
    if (await claimBlockedNotice(env.BOT_DB, userId, now)) {
      try {
        await telegram(env, "sendMessage", {
          chat_id: message.chat.id,
          text: env.BLOCKED_MESSAGE || t(env.BOT_LANGUAGE, "blockedNotice")
        });
      } catch (error) {
        await releaseBlockedNotice(env.BOT_DB, userId, now).catch(() => {});
        throw error;
      }
    }
    return;
  }

  const interval = clampInteger(
    env.MESSAGE_INTERVAL_SECONDS,
    0,
    60,
    2
  );
  user = await upsertUser(env.BOT_DB, message.from, now);

  const command = parseCommand(message.text);
  if (command === "start") {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: env.WELCOME_MESSAGE || t(env.BOT_LANGUAGE, "welcome")
    });
    return;
  }
  if (command === "id") {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: `${t(env.BOT_LANGUAGE, "userId")}：${userId}`
    });
    return;
  }

  if (message.media_group_id) {
    const queued = await enqueueMediaMessage(message, userId, "user_to_admin", env, now, interval);
    if (queued.rejected) {
      if (queued.created) await sendRateLimitNotice(message.chat.id, env);
      return;
    }
    if (queued.handled) return;
    if (!queued.late) {
      await flushMediaGroup(String(message.chat.id), String(message.media_group_id), env);
      return;
    }
  }

  const rateKey = message.media_group_id
    ? `album:${message.media_group_id}`
    : `message:${message.message_id}`;
  if (!(await claimRateSlot(env.BOT_DB, userId, now, interval, rateKey))) {
    await sendRateLimitNotice(message.chat.id, env);
    return;
  }

  if (!env.ADMIN_GROUP_ID) {
    return relayUserMessageToAdmin(message, user, env, now);
  }

  user = await ensureUserTopic(user, message.from, env);

  const replyParameters = await targetReplyParameters(
    env.BOT_DB,
    String(message.chat.id),
    message.reply_to_message?.message_id,
    String(env.ADMIN_GROUP_ID)
  );

  let copied;
  try {
    copied = await telegram(env, "copyMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
      message_thread_id: user.topic_id,
      reply_parameters: replyParameters
    });
  } catch (error) {
    if (!isTopicMissing(error)) {
      await notifyUserCopyFailure(message.chat.id, error, env);
      throw error;
    }
    await clearUserTopic(env.BOT_DB, user.user_id, user.topic_id);
    user = await ensureUserTopic({ ...user, topic_id: null }, message.from, env);
    copied = await telegram(env, "copyMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
      message_thread_id: user.topic_id,
      reply_parameters: replyParameters
    });
  }

  await saveMessageMap(env.BOT_DB, {
    sourceChatId: String(message.chat.id),
    sourceMessageId: message.message_id,
    targetChatId: String(env.ADMIN_GROUP_ID),
    targetMessageId: copied.message_id,
    userId,
    now
  });
}

export async function relayUserMessageToAdmin(message, user, env, now) {
  if (await getMessageMap(env.BOT_DB, String(message.chat.id), message.message_id)) return;

  const mappedReply = await targetReplyParameters(
    env.BOT_DB,
    String(message.chat.id),
    message.reply_to_message?.message_id,
    String(env.ADMIN_USER_ID)
  );
  const recentReply = mappedReply || await getRecentAdminConversationReply(
    env.BOT_DB,
    user.user_id,
    now,
    env
  );
  const replyParameters = recentReply || await sendDirectUserHeader(user, env);
  let copied;
  try {
    copied = await telegram(env, "copyMessage", {
      chat_id: env.ADMIN_USER_ID,
      from_chat_id: message.chat.id,
      message_id: message.message_id,
      reply_parameters: replyParameters
    });
  } catch (error) {
    await notifyUserCopyFailure(message.chat.id, error, env);
    throw error;
  }

  await saveMessageMap(env.BOT_DB, {
    sourceChatId: String(message.chat.id),
    sourceMessageId: message.message_id,
    targetChatId: String(env.ADMIN_USER_ID),
    targetMessageId: copied.message_id,
    userId: user.user_id,
    now
  });
}

export async function processDirectAdminReply(message, env) {
  if (await getMessageMap(env.BOT_DB, String(message.chat.id), message.message_id)) return;
  const repliedMessageId = message.reply_to_message?.message_id;
  if (!repliedMessageId) {
    if (parseCommand(message.text)) await sendUnknownCommand(message.chat.id, undefined, env);
    return;
  }

  const mapping = await env.BOT_DB.prepare(`
    SELECT source_message_id, user_id
    FROM message_map
    WHERE target_chat_id = ? AND target_message_id = ?
  `).bind(String(env.ADMIN_USER_ID), repliedMessageId).first();
  if (!mapping) {
    if (parseCommand(message.text)) await sendUnknownCommand(message.chat.id, undefined, env);
    return;
  }

  const user = await getUser(env.BOT_DB, mapping.user_id);
  if (!user) return;

  const command = parseCommand(message.text);
  if (command === "block" || command === "unblock") {
    const blocked = command === "block" ? 1 : 0;
    await env.BOT_DB.prepare(
      "UPDATE users SET blocked = ?, blocked_notice_at = 0, updated_at = ? WHERE user_id = ?"
    ).bind(blocked, Math.floor(Date.now() / 1000), user.user_id).run();
    await telegram(env, "sendMessage", {
      chat_id: env.ADMIN_USER_ID,
      text: t(env.BOT_LANGUAGE, blocked ? "blocked" : "unblocked")
    });
    return;
  }

  if (command === "user") {
    await telegram(env, "sendMessage", {
      chat_id: env.ADMIN_USER_ID,
      text: buildDirectUserStatus(user, env.BOT_LANGUAGE),
      parse_mode: "HTML"
    });
    return;
  }

  if (command) {
    await sendUnknownCommand(message.chat.id, undefined, env);
    return;
  }

  if (message.media_group_id) {
    const queued = await enqueueMediaMessage(
      message,
      user.user_id,
      "admin_to_user",
      env,
      Math.floor(Date.now() / 1000),
      0
    );
    if (queued.handled) return;
    if (!queued.late) {
      await flushMediaGroup(String(message.chat.id), String(message.media_group_id), env);
      return;
    }
  }

  let copied;
  try {
    copied = await telegram(env, "copyMessage", {
      chat_id: user.user_id,
      from_chat_id: env.ADMIN_USER_ID,
      message_id: message.message_id,
      reply_parameters: {
        message_id: mapping.source_message_id,
        allow_sending_without_reply: true
      }
    });
  } catch (error) {
    await notifyAdminDeliveryFailure(message, error, env);
    throw error;
  }
  await saveMessageMap(env.BOT_DB, {
    sourceChatId: String(env.ADMIN_USER_ID),
    sourceMessageId: message.message_id,
    targetChatId: user.user_id,
    targetMessageId: copied.message_id,
    userId: user.user_id,
    now: Math.floor(Date.now() / 1000)
  });
}

function buildDirectUserStatus(user, language) {
  const username = user.username ? `@${escapeHtml(safeIdentityText(user.username))}` : t(language, "notSet");
  return [
    `<b>${t(language, "userDetails")}</b>`,
    `User ID：<code>${escapeHtml(user.user_id)}</code>`,
    `${t(language, "name")}：${escapeHtml(safeIdentityText([user.first_name, user.last_name].filter(Boolean).join(" ")) || t(language, "notProvided"))}`,
    `${t(language, "username")}：${username}`,
    `${t(language, "status")}：${t(language, user.blocked ? "blockedStatus" : "normalStatus")}`
  ].join("\n");
}

async function processAdminTopicMessage(message, env) {
  if (String(message.from?.id) !== String(env.ADMIN_USER_ID)) return;
  if (!message.message_thread_id || message.is_topic_message === false) return;
  if (await getMessageMap(env.BOT_DB, String(message.chat.id), message.message_id)) return;

  const user = await getUserByTopic(env.BOT_DB, message.message_thread_id);
  if (!user) return;

  const command = parseCommand(message.text);
  if (command) {
    const handled = await handleAdminCommand(command, message, user, env);
    if (handled) return;
    await sendUnknownCommand(env.ADMIN_GROUP_ID, message.message_thread_id, env);
    return;
  }

  if (message.media_group_id) {
    const queued = await enqueueMediaMessage(
      message,
      user.user_id,
      "admin_to_user",
      env,
      Math.floor(Date.now() / 1000),
      0
    );
    if (queued.handled) return;
    if (!queued.late) {
      await flushMediaGroup(String(message.chat.id), String(message.media_group_id), env);
      return;
    }
  }

  const replyParameters = await targetReplyParameters(
    env.BOT_DB,
    String(env.ADMIN_GROUP_ID),
    message.reply_to_message?.message_id,
    user.user_id
  );
  let copied;
  try {
    copied = await telegram(env, "copyMessage", {
      chat_id: user.user_id,
      from_chat_id: env.ADMIN_GROUP_ID,
      message_id: message.message_id,
      reply_parameters: replyParameters
    });
  } catch (error) {
    await notifyAdminDeliveryFailure(message, error, env);
    throw error;
  }

  await saveMessageMap(env.BOT_DB, {
    sourceChatId: String(env.ADMIN_GROUP_ID),
    sourceMessageId: message.message_id,
    targetChatId: user.user_id,
    targetMessageId: copied.message_id,
    userId: user.user_id,
    now: Math.floor(Date.now() / 1000)
  });
}

async function handleAdminCommand(command, message, user, env) {
  if (command === "user") {
    await sendTopicStatus(message, user, env);
    return true;
  }
  if (command === "block" || command === "unblock") {
    const blocked = command === "block" ? 1 : 0;
    await env.BOT_DB.prepare(
      "UPDATE users SET blocked = ?, blocked_notice_at = 0, updated_at = ? WHERE user_id = ?"
    ).bind(blocked, Math.floor(Date.now() / 1000), user.user_id).run();
    await telegram(env, "sendMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: message.message_thread_id,
      text: t(env.BOT_LANGUAGE, blocked ? "blocked" : "unblocked")
    });
    return true;
  }
  if (command === "close") {
    await telegram(env, "closeForumTopic", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: message.message_thread_id
    });
    return true;
  }
  if (command === "help") {
    await telegram(env, "sendMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: message.message_thread_id,
      text: t(env.BOT_LANGUAGE, "adminHelp")
    });
    return true;
  }
  return false;
}

async function processEditedMessage(message, env) {
  if (!message?.chat || (!message.text && !message.caption)) return;
  const chatId = String(message.chat.id);
  const isUserEdit = message.chat.type === "private" && String(message.from?.id) !== String(env.ADMIN_USER_ID);
  const isAdminTopicEdit = chatId === String(env.ADMIN_GROUP_ID) && String(message.from?.id) === String(env.ADMIN_USER_ID);
  const isAdminPrivateEdit = !env.ADMIN_GROUP_ID
    && message.chat.type === "private"
    && String(message.from?.id) === String(env.ADMIN_USER_ID);
  if (!isUserEdit && !isAdminTopicEdit && !isAdminPrivateEdit) return;

  const mapping = await env.BOT_DB.prepare(
    "SELECT target_chat_id, target_message_id, user_id FROM message_map WHERE source_chat_id = ? AND source_message_id = ?"
  ).bind(chatId, message.message_id).first();
  if (!mapping) {
    if (parseCommand(message.text)) return;
    if (isAdminPrivateEdit && !message.reply_to_message?.message_id) return;
    throw new RetryableError("編輯訊息尚未建立轉送映射");
  }

  if (isUserEdit) {
    const user = await getUser(env.BOT_DB, mapping.user_id);
    if (!user || user.blocked) return;
  }

  const method = message.text ? "editMessageText" : "editMessageCaption";
  const payload = {
    chat_id: mapping.target_chat_id,
    message_id: mapping.target_message_id,
    ...(message.text
      ? { text: message.text, entities: message.entities }
      : { caption: message.caption, caption_entities: message.caption_entities })
  };
  try {
    await telegram(env, method, payload);
  } catch (error) {
    if (!String(error.message).includes("message is not modified")) throw error;
  }
}

async function ensureUserTopic(user, from, env) {
  if (user.topic_id && user.topic_card_message_id != null) return user;
  if (user.topic_id) {
    try {
      const card = await sendTopicUserCard(user.topic_id, from, env);
      await saveTopicCardMessage(env.BOT_DB, user.user_id, user.topic_id, card.message_id);
      return { ...user, topic_card_message_id: card.message_id };
    } catch (error) {
      if (!isTopicMissing(error)) throw error;
      await clearUserTopic(env.BOT_DB, user.user_id, user.topic_id);
      user = { ...user, topic_id: null, topic_card_message_id: null };
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const claimed = await env.BOT_DB.prepare(`
    UPDATE users SET topic_lease_until = ?, updated_at = ?
    WHERE user_id = ? AND topic_id IS NULL AND topic_lease_until <= ?
  `).bind(now + TOPIC_LEASE_SECONDS, now, user.user_id, now).run();

  if (Number(claimed.meta?.changes || 0) === 1) {
    try {
      const topic = await telegram(env, "createForumTopic", {
        chat_id: env.ADMIN_GROUP_ID,
        name: buildTopicName(from, env.BOT_LANGUAGE)
      });
      await env.BOT_DB.prepare(`
        UPDATE users SET topic_id = ?, topic_card_message_id = NULL,
          topic_lease_until = 0, updated_at = ?
        WHERE user_id = ?
      `).bind(topic.message_thread_id, now, user.user_id).run();
      const card = await sendTopicUserCard(topic.message_thread_id, from, env);
      await saveTopicCardMessage(env.BOT_DB, user.user_id, topic.message_thread_id, card.message_id);
      return {
        ...user,
        topic_id: topic.message_thread_id,
        topic_card_message_id: card.message_id
      };
    } catch (error) {
      await env.BOT_DB.prepare(
        "UPDATE users SET topic_lease_until = 0 WHERE user_id = ? AND topic_id IS NULL"
      ).bind(user.user_id).run().catch(() => {});
      throw error;
    }
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await delay(150);
    const current = await getUser(env.BOT_DB, user.user_id);
    if (current?.topic_id) return current;
  }
  throw new RetryableError("等待 Topic 建立逾時");
}

async function clearUserTopic(db, userId, topicId) {
  await db.prepare(`
    UPDATE users SET topic_id = NULL, topic_card_message_id = NULL, topic_lease_until = 0
    WHERE user_id = ? AND topic_id = ?
  `).bind(userId, topicId).run();
}

async function sendTopicUserCard(topicId, from, env) {
  return telegram(env, "sendMessage", {
    chat_id: env.ADMIN_GROUP_ID,
    message_thread_id: topicId,
    text: buildUserCard(from, env.BOT_LANGUAGE),
    parse_mode: "HTML"
  });
}

async function saveTopicCardMessage(db, userId, topicId, messageId) {
  await db.prepare(`
    UPDATE users SET topic_card_message_id = ?, updated_at = ?
    WHERE user_id = ? AND topic_id = ?
  `).bind(messageId, Math.floor(Date.now() / 1000), userId, topicId).run();
}

async function sendTopicStatus(message, user, env) {
  await telegram(env, "sendMessage", {
    chat_id: env.ADMIN_GROUP_ID,
    message_thread_id: message.message_thread_id,
    text: buildDirectUserStatus(user, env.BOT_LANGUAGE),
    parse_mode: "HTML"
  });
}

async function enqueueMediaMessage(message, userId, direction, env, now, interval) {
  const sourceChatId = String(message.chat.id);
  const mediaGroupId = String(message.media_group_id);
  const nowMs = Date.now();
  const inserted = await env.BOT_DB.prepare(`
    INSERT OR IGNORE INTO media_groups(
      source_chat_id, media_group_id, user_id, direction, state,
      updated_at_ms, lease_until_ms, created_at
    ) VALUES (?, ?, ?, ?, 'initializing', ?, 0, ?)
  `).bind(sourceChatId, mediaGroupId, userId, direction, nowMs, now).run();
  const created = Number(inserted.meta?.changes || 0) === 1;

  await env.BOT_DB.prepare(`
    INSERT OR IGNORE INTO media_group_messages(
      source_chat_id, media_group_id, message_id, created_at
    ) VALUES (?, ?, ?, ?)
  `).bind(sourceChatId, mediaGroupId, message.message_id, now).run();
  await env.BOT_DB.prepare(`
    UPDATE media_groups SET updated_at_ms = ?
    WHERE source_chat_id = ? AND media_group_id = ? AND state IN ('initializing', 'collecting')
  `).bind(nowMs, sourceChatId, mediaGroupId).run();

  if (created) {
    const accepted = direction !== "user_to_admin"
      || await claimRateSlot(env.BOT_DB, userId, now, interval, `album:${mediaGroupId}`);
    await env.BOT_DB.prepare(`
      UPDATE media_groups SET state = ?
      WHERE source_chat_id = ? AND media_group_id = ? AND state = 'initializing'
    `).bind(accepted ? "collecting" : "rejected", sourceChatId, mediaGroupId).run();
    return { created: true, rejected: !accepted };
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const group = await getMediaGroup(env.BOT_DB, sourceChatId, mediaGroupId);
    if (group?.state === "processing") {
      // Expired work is reclaimed by flushMediaGroup below.
      if (Number(group.lease_until_ms) <= Date.now()) return { created: false };
      await delay(100);
      continue;
    }
    if (group?.state !== "initializing") {
      const mapped = group?.state === "done"
        ? await getMessageMap(env.BOT_DB, sourceChatId, message.message_id)
        : null;
      return {
        created: false,
        rejected: group?.state === "rejected",
        handled: Boolean(mapped),
        late: group?.state === "done" && !mapped
      };
    }
    await delay(50);
  }
  throw new RetryableError("相簿初始化或處理逾時");
}

async function flushMediaGroup(sourceChatId, mediaGroupId, env) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const group = await getMediaGroup(env.BOT_DB, sourceChatId, mediaGroupId);
    if (!group || group.state === "done" || group.state === "rejected") return;
    if (group.state === "processing" && Number(group.lease_until_ms) > Date.now()) return;
    if (group.state === "processing") {
      await env.BOT_DB.prepare(`
        UPDATE media_groups SET state = 'collecting', lease_until_ms = 0
        WHERE source_chat_id = ? AND media_group_id = ?
          AND state = 'processing' AND lease_until_ms <= ?
      `).bind(sourceChatId, mediaGroupId, Date.now()).run();
      continue;
    }

    const remaining = Number(group.updated_at_ms) + MEDIA_GROUP_QUIET_MS - Date.now();
    if (remaining > 0) await delay(remaining);
    const claimTime = Date.now();
    const claimed = await env.BOT_DB.prepare(`
      UPDATE media_groups SET state = 'processing', lease_until_ms = ?
      WHERE source_chat_id = ? AND media_group_id = ?
        AND state = 'collecting' AND updated_at_ms <= ?
    `).bind(
      claimTime + UPDATE_LEASE_SECONDS * 1000,
      sourceChatId,
      mediaGroupId,
      claimTime - MEDIA_GROUP_QUIET_MS
    ).run();
    if (Number(claimed.meta?.changes || 0) !== 1) continue;

    try {
      await deliverMediaGroup(group, env);
      await env.BOT_DB.prepare(`
        UPDATE media_groups SET state = 'done', lease_until_ms = 0, last_error = NULL
        WHERE source_chat_id = ? AND media_group_id = ?
      `).bind(sourceChatId, mediaGroupId).run();
      return;
    } catch (error) {
      await notifyMediaFailure(group, error, env);
      await env.BOT_DB.prepare(`
        UPDATE media_groups SET state = ?, lease_until_ms = 0, last_error = ?
        WHERE source_chat_id = ? AND media_group_id = ?
      `).bind(
        isRetryableError(error) ? "collecting" : "rejected",
        sanitizeError(error),
        sourceChatId,
        mediaGroupId
      ).run().catch(() => {});
      throw error;
    }
  }
}

async function deliverMediaGroup(group, env) {
  const rows = await env.BOT_DB.prepare(`
    SELECT message_id FROM media_group_messages
    WHERE source_chat_id = ? AND media_group_id = ? ORDER BY message_id ASC
  `).bind(group.source_chat_id, group.media_group_id).all();
  const messageIds = (rows.results || []).map((row) => Number(row.message_id));
  if (!messageIds.length) return;

  const user = await getUser(env.BOT_DB, group.user_id);
  if (!user) throw new NonRetryableError("找不到相簿對應使用者");
  let targetChatId = user.user_id;
  let topicId;
  if (group.direction === "user_to_admin") {
    if (env.ADMIN_GROUP_ID) {
      const topicUser = await ensureUserTopic(user, user, env);
      targetChatId = String(env.ADMIN_GROUP_ID);
      topicId = topicUser.topic_id;
    } else {
      targetChatId = String(env.ADMIN_USER_ID);
      const recent = await getRecentAdminConversationReply(
        env.BOT_DB,
        user.user_id,
        Math.floor(Date.now() / 1000),
        env
      );
      if (!recent) await sendDirectUserHeader(user, env);
    }
  }

  let copied;
  try {
    copied = await telegram(env, "copyMessages", {
      chat_id: targetChatId,
      from_chat_id: group.source_chat_id,
      message_ids: messageIds,
      message_thread_id: topicId
    });
  } catch (error) {
    if (group.direction !== "user_to_admin" || !topicId || !isTopicMissing(error)) throw error;
    await clearUserTopic(env.BOT_DB, user.user_id, topicId);
    const topicUser = await ensureUserTopic({ ...user, topic_id: null }, user, env);
    copied = await telegram(env, "copyMessages", {
      chat_id: env.ADMIN_GROUP_ID,
      from_chat_id: group.source_chat_id,
      message_ids: messageIds,
      message_thread_id: topicUser.topic_id
    });
    targetChatId = String(env.ADMIN_GROUP_ID);
  }

  if (!Array.isArray(copied) || copied.length !== messageIds.length) {
    await rollbackCopiedMessages(targetChatId, copied, env);
    throw new NonRetryableError("Telegram 未完整複製相簿");
  }
  const now = Math.floor(Date.now() / 1000);
  await env.BOT_DB.batch(messageIds.map((sourceMessageId, index) => env.BOT_DB.prepare(`
    INSERT OR REPLACE INTO message_map(
      source_chat_id, source_message_id, target_chat_id, target_message_id, user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    group.source_chat_id,
    sourceMessageId,
    targetChatId,
    copied[index].message_id,
    user.user_id,
    now
  )));
}

async function rollbackCopiedMessages(targetChatId, copied, env) {
  const copiedIds = Array.isArray(copied)
    ? copied.map((item) => Number(item?.message_id)).filter(Number.isSafeInteger)
    : [];
  if (!copiedIds.length) return;
  try {
    await telegram(env, "deleteMessages", {
      chat_id: targetChatId,
      message_ids: copiedIds
    });
  } catch (error) {
    console.log(JSON.stringify({
      event: "partial_album_rollback_failed",
      target_chat_id: String(targetChatId),
      count: copiedIds.length,
      error: sanitizeError(error)
    }));
  }
}

async function sendDirectUserHeader(user, env) {
  const language = env.BOT_LANGUAGE;
  const name = safeIdentityText([user.first_name, user.last_name].filter(Boolean).join(" ")) || t(language, "notProvided");
  const username = user.username ? `@${escapeHtml(safeIdentityText(user.username))}` : t(language, "notSet");
  const header = await telegram(env, "sendMessage", {
    chat_id: env.ADMIN_USER_ID,
    text: [
      `<b>${t(language, "receivedChat")}</b>`,
      `User ID：<code>${escapeHtml(user.user_id)}</code>`,
      `${t(language, "name")}：${escapeHtml(name)}`,
      `${t(language, "username")}：${username}`
    ].join("\n"),
    parse_mode: "HTML"
  });
  return { message_id: header.message_id, allow_sending_without_reply: true };
}

async function getRecentAdminConversationReply(db, userId, now, env) {
  const recent = await db.prepare(`
    SELECT target_message_id FROM message_map
    WHERE user_id = ? AND source_chat_id = ? AND target_chat_id = ? AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1
  `).bind(userId, userId, String(env.ADMIN_USER_ID), now - CONVERSATION_WINDOW_SECONDS).first();
  return recent
    ? { message_id: recent.target_message_id, allow_sending_without_reply: true }
    : undefined;
}

async function sendUnknownCommand(chatId, topicId, env) {
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    message_thread_id: topicId,
    text: t(env.BOT_LANGUAGE, "unknownCommand")
  });
}

async function sendRateLimitNotice(chatId, env) {
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: env.RATE_LIMIT_MESSAGE || t(env.BOT_LANGUAGE, "rateLimit")
  });
}

async function notifyUserCopyFailure(chatId, error, env) {
  if (isRetryableError(error) || isTopicMissing(error)) return;
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: env.UNSUPPORTED_MESSAGE || t(env.BOT_LANGUAGE, "unsupportedMessage")
  }).catch(() => {});
}

async function notifyAdminDeliveryFailure(message, error, env) {
  if (isRetryableError(error)) return;
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    message_thread_id: message.message_thread_id,
    text: t(env.BOT_LANGUAGE, "deliveryFailed")
  }).catch(() => {});
}

async function notifyMediaFailure(group, error, env) {
  if (isRetryableError(error)) return;
  const user = await getUser(env.BOT_DB, group.user_id).catch(() => null);
  if (group.direction === "user_to_admin") {
    await notifyUserCopyFailure(group.source_chat_id, error, env);
    return;
  }
  await telegram(env, "sendMessage", {
    chat_id: group.source_chat_id,
    message_thread_id: String(group.source_chat_id) === String(env.ADMIN_GROUP_ID)
      ? user?.topic_id
      : undefined,
    text: t(env.BOT_LANGUAGE, "albumFailed")
  }).catch(() => {});
}

class TelegramApiError extends Error {
  constructor(method, errorCode, description, parameters = {}) {
    super(`Telegram ${method} 失敗：${String(description).slice(0, 300)}`);
    this.name = "TelegramApiError";
    this.errorCode = Number(errorCode || 0);
    this.retryAfter = Number(parameters.retry_after || 0);
    this.retryable = this.errorCode === 429 || this.errorCode >= 500;
  }
}

class RetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetryableError";
    this.retryable = true;
  }
}

class NonRetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = "NonRetryableError";
    this.retryable = false;
  }
}

async function telegram(env, method, payload) {
  let response;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    throw new RetryableError(`Telegram ${method} 網路錯誤：${sanitizeError(error)}`);
  } finally {
    clearTimeout(timeoutId);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new RetryableError(`Telegram ${method} 回應格式無效（HTTP ${response.status}）`);
  }
  if (!response.ok || !data.ok) {
    throw new TelegramApiError(
      method,
      data.error_code || response.status,
      data.description || `HTTP ${response.status}`,
      data.parameters
    );
  }
  return data.result;
}

async function claimUpdate(db, updateId) {
  const now = Math.floor(Date.now() / 1000);
  const inserted = await db.prepare(`
    INSERT OR IGNORE INTO processed_updates(
      update_id, processed_at, status, attempts, updated_at
    ) VALUES (?, ?, 'processing', 1, ?)
  `).bind(updateId, now, now).run();
  if (Number(inserted.meta?.changes || 0) === 1) return "accepted";
  const reclaimed = await db.prepare(`
    UPDATE processed_updates
    SET status = 'processing', attempts = attempts + 1, updated_at = ?, last_error = NULL
    WHERE update_id = ? AND (
      (status = 'failed' AND attempts < ?)
      OR (status = 'processing' AND updated_at <= ? AND attempts < ?)
    )
  `).bind(
    now,
    updateId,
    MAX_UPDATE_ATTEMPTS,
    now - UPDATE_LEASE_SECONDS,
    MAX_UPDATE_ATTEMPTS
  ).run();
  if (Number(reclaimed.meta?.changes || 0) === 1) return "accepted";
  const current = await db.prepare(
    "SELECT status, attempts FROM processed_updates WHERE update_id = ?"
  ).bind(updateId).first();
  if (
    current
    && Number(current.attempts) >= MAX_UPDATE_ATTEMPTS
    && (current.status === "failed" || current.status === "processing")
  ) {
    await db.prepare(`
      UPDATE processed_updates SET status = 'discarded', updated_at = ?
      WHERE update_id = ? AND attempts >= ?
    `).bind(now, updateId, MAX_UPDATE_ATTEMPTS).run();
    console.log(JSON.stringify({ event: "update_retry_exhausted", update_id: updateId }));
    return "exhausted";
  }
  return current?.status === "processing" ? "busy" : "duplicate";
}

async function finishUpdate(db, updateId, status) {
  await db.prepare(`
    UPDATE processed_updates SET status = ?, updated_at = ?, last_error = NULL
    WHERE update_id = ?
  `).bind(status, Math.floor(Date.now() / 1000), updateId).run();
}

async function recordUpdateFailure(db, updateId, retryable, error) {
  await db.prepare(`
    UPDATE processed_updates SET
      status = CASE
        WHEN ? = 1 AND attempts >= ? THEN 'discarded'
        ELSE ?
      END,
      updated_at = ?,
      last_error = ?
    WHERE update_id = ?
  `).bind(
    retryable ? 1 : 0,
    MAX_UPDATE_ATTEMPTS,
    retryable ? "failed" : "discarded",
    Math.floor(Date.now() / 1000),
    sanitizeError(error),
    updateId
  ).run();
  const stored = await db.prepare(
    "SELECT status FROM processed_updates WHERE update_id = ?"
  ).bind(updateId).first();
  return stored?.status || null;
}

async function getUser(db, userId) {
  return db.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
}

async function getUserByTopic(db, topicId) {
  return db.prepare("SELECT * FROM users WHERE topic_id = ?").bind(topicId).first();
}

async function upsertUser(db, from, now) {
  const userId = String(from.id);
  await db.prepare(`
    INSERT INTO users(user_id, username, first_name, last_name, created_at, updated_at, last_message_at)
    VALUES (?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    from.username || null,
    from.first_name || "",
    from.last_name || "",
    now,
    now
  ).run();
  return getUser(db, userId);
}

async function claimRateSlot(db, userId, now, interval, rateKey) {
  const result = await db.prepare(`
    UPDATE users SET last_message_at = ?, last_rate_key = ?, updated_at = ?
    WHERE user_id = ? AND (last_rate_key = ? OR last_message_at <= ?)
  `).bind(now, rateKey, now, userId, rateKey, now - interval).run();
  return Number(result.meta?.changes || 0) === 1;
}

async function claimBlockedNotice(db, userId, now) {
  const result = await db.prepare(`
    UPDATE users SET blocked_notice_at = ?
    WHERE user_id = ? AND blocked = 1 AND blocked_notice_at <= ?
  `).bind(now, userId, now - 3600).run();
  return Number(result.meta?.changes || 0) === 1;
}

async function releaseBlockedNotice(db, userId, claimedAt) {
  await db.prepare(`
    UPDATE users SET blocked_notice_at = 0
    WHERE user_id = ? AND blocked = 1 AND blocked_notice_at = ?
  `).bind(userId, claimedAt).run();
}

async function getMessageMap(db, sourceChatId, sourceMessageId) {
  return db.prepare(`
    SELECT target_chat_id, target_message_id, user_id FROM message_map
    WHERE source_chat_id = ? AND source_message_id = ?
  `).bind(sourceChatId, sourceMessageId).first();
}

async function saveMessageMap(db, values) {
  await db.prepare(`
    INSERT OR REPLACE INTO message_map(
      source_chat_id, source_message_id, target_chat_id, target_message_id, user_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    values.sourceChatId,
    values.sourceMessageId,
    values.targetChatId,
    values.targetMessageId,
    values.userId,
    values.now
  ).run();
}

async function targetReplyParameters(db, sourceChatId, sourceMessageId, expectedTargetChatId) {
  if (!sourceMessageId) return undefined;
  const forward = await db.prepare(
    "SELECT target_chat_id, target_message_id FROM message_map WHERE source_chat_id = ? AND source_message_id = ?"
  ).bind(sourceChatId, sourceMessageId).first();
  if (forward && String(forward.target_chat_id) === String(expectedTargetChatId)) {
    return { message_id: forward.target_message_id, allow_sending_without_reply: true };
  }

  const reverse = await db.prepare(
    "SELECT source_chat_id, source_message_id FROM message_map WHERE target_chat_id = ? AND target_message_id = ?"
  ).bind(sourceChatId, sourceMessageId).first();
  if (reverse && String(reverse.source_chat_id) === String(expectedTargetChatId)) {
    return { message_id: reverse.source_message_id, allow_sending_without_reply: true };
  }
  return undefined;
}

async function getMediaGroup(db, sourceChatId, mediaGroupId) {
  return db.prepare(`
    SELECT * FROM media_groups WHERE source_chat_id = ? AND media_group_id = ?
  `).bind(sourceChatId, mediaGroupId).first();
}

async function cleanDatabase(db) {
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    db.prepare(`
      DELETE FROM processed_updates
      WHERE COALESCE(updated_at, processed_at) < ?
    `).bind(now - 7 * 86400),
    db.prepare("DELETE FROM message_map WHERE created_at < ?").bind(now - 30 * 86400),
    db.prepare("DELETE FROM media_group_messages WHERE created_at < ?").bind(now - 2 * 86400),
    db.prepare("DELETE FROM media_groups WHERE created_at < ?").bind(now - 2 * 86400)
  ]);
}

async function readiness(env) {
  if (configurationIssue(env)) {
    return json({ ok: false, service: "telegram-private-relay" }, { status: 503 });
  }
  try {
    await env.BOT_DB.prepare("SELECT 1 AS ok").first();
    return json({ ok: true, service: "telegram-private-relay" });
  } catch {
    return json({ ok: false, service: "telegram-private-relay" }, { status: 503 });
  }
}

export function configurationIssue(env) {
  if (!env?.BOT_DB || typeof env.BOT_DB.prepare !== "function") return "BOT_DB";
  if (typeof env.BOT_TOKEN !== "string" || !env.BOT_TOKEN.trim()) return "BOT_TOKEN";
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(String(env.WEBHOOK_SECRET || ""))) return "WEBHOOK_SECRET";
  if (!/^\d+$/.test(String(env.ADMIN_USER_ID || "").trim())) return "ADMIN_USER_ID";
  if (env.ADMIN_GROUP_ID != null && String(env.ADMIN_GROUP_ID) !== "") {
    if (!/^-100\d+$/.test(String(env.ADMIN_GROUP_ID).trim())) return "ADMIN_GROUP_ID";
  }
  if (env.BOT_LANGUAGE != null && !["zh", "ja", "en"].includes(env.BOT_LANGUAGE)) return "BOT_LANGUAGE";
  for (const name of ["WELCOME_MESSAGE", "BLOCKED_MESSAGE", "RATE_LIMIT_MESSAGE", "UNSUPPORTED_MESSAGE"]) {
    if (env[name] != null && (typeof env[name] !== "string" || env[name].length > 4096)) return name;
  }
  return null;
}

function isRetryableError(error) {
  if (error instanceof TelegramApiError) return error.retryable;
  return error?.retryable !== false;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

export function parseCommand(text) {
  if (typeof text !== "string" || !text.startsWith("/")) return null;
  const token = text.trim().split(/\s+/, 1)[0].slice(1).split("@", 1)[0];
  return token.toLowerCase() || null;
}

export function buildTopicName(from, language) {
  const displayName = safeIdentityText([from.first_name, from.last_name].filter(Boolean).join(" "));
  const identity = from.username ? `@${safeIdentityText(from.username)}` : String(from.id);
  return truncate(`${displayName || t(language, "user")} · ${identity}`, MAX_TOPIC_LENGTH);
}

export function buildUserCard(from, language) {
  const fullName = safeIdentityText([from.first_name, from.last_name].filter(Boolean).join(" ")) || t(language, "notProvided");
  const username = from.username ? `@${escapeHtml(safeIdentityText(from.username))}` : t(language, "notSet");
  return [
    `<b>${t(language, "newChat")}</b>`,
    `User ID：<code>${escapeHtml(String(from.id))}</code>`,
    `${t(language, "name")}：${escapeHtml(fullName)}`,
    `${t(language, "username")}：${username}`
  ].join("\n");
}

function safeIdentityText(value) {
  return String(value || "")
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function truncate(value, maxLength) {
  const chars = Array.from(String(value));
  return chars.length <= maxLength ? value : `${chars.slice(0, maxLength - 1).join("")}…`;
}

export function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

async function secureEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right))
  ]);
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

function isTopicMissing(error) {
  const message = String(error?.message || "").toLowerCase();
  return message.includes("message thread not found") || message.includes("topic_closed");
}

function sanitizeError(error) {
  return String(error?.message || error || "unknown error")
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[REDACTED]")
    .slice(0, 500);
}

function json(value, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(value), { ...init, headers });
}

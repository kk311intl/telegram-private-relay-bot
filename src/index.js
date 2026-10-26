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
const CAPTCHA_TTL_SECONDS = 300;
const CAPTCHA_COOLDOWN_SECONDS = 900;
const USER_LANGUAGES = { zh: "中文", en: "English", ja: "日本語" };
let botIdentity;

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

    let leaseToken;
    try {
      const claim = await claimUpdate(env.BOT_DB, update.update_id);
      if (claim.status === "duplicate") return json({ ok: true, duplicate: true });
      if (claim.status === "exhausted") {
        await notifyStoppedUpdate(update, env);
        return json({ ok: true, discarded: true });
      }
      if (claim.status === "busy") return json({ ok: false, busy: true }, { status: 500 });
      leaseToken = claim.token;
      await processUpdate(update, { ...env, _updateLease: { id: update.update_id, token: leaseToken } });
      const finished = await finishUpdate(env.BOT_DB, update.update_id, leaseToken);
      if (Number(finished.meta?.changes || 0) !== 1) {
        const current = await env.BOT_DB.prepare("SELECT status FROM processed_updates WHERE update_id = ?")
          .bind(update.update_id).first();
        if (!["done", "discarded"].includes(current?.status)) return json({ ok: false, busy: true }, { status: 500 });
      }
      return json({ ok: true });
    } catch (error) {
      const retryable = isRetryableError(error);
      const failure = await recordUpdateFailure(
        env.BOT_DB,
        update.update_id,
        retryable,
        error,
        leaseToken
      ).catch(() => ({ status: null, terminal: false }));
      if (failure.status === "done") return json({ ok: true, duplicate: true });
      const willRetry = retryable && failure.status !== "discarded";
      if (retryable && failure.terminal) await notifyStoppedUpdate(update, env);
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
  const message = update.message || update.edited_message;
  if (message && !(await commandIsForBot(message.text, env))) return;
  try {
    if (update.callback_query) return await processLanguageCallback(update.callback_query, env);
    if (update.message) return await processMessage(update.message, env);
    if (update.edited_message) return await processEditedMessage(update.edited_message, env);
  } catch (error) {
    if (!(error instanceof ObsoleteWorkError)) throw error;
  }
}

async function processMessage(message, env) {
  if (!message?.chat || !message.from || message.from.is_bot) return;

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
      text: `${t(env.BOT_LANGUAGE, "groupId")}${t(env.BOT_LANGUAGE, "fieldSeparator")}<code>${escapeHtml(String(message.chat.id))}</code>`,
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
    if (command === "start") await configureAdminMenu(env);
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: command === "help"
        ? t(env.BOT_LANGUAGE, env.ADMIN_GROUP_ID ? "adminHelpTopic" : "adminHelpDirect")
        : t(env.BOT_LANGUAGE, env.ADMIN_GROUP_ID ? "adminReadyTopic" : "adminReadyDirect")
    });
    return;
  }
  if (command === "status") return sendAdminStatus(message.chat.id, undefined, env);
  if (command === "captcha") {
    const mode = /^\/captcha(?:@[A-Za-z0-9_]+)?\s+(on|off)\s*$/i.exec(message.text.trim())?.[1].toLowerCase();
    if (mode) {
      await env.BOT_DB.prepare(`
        UPDATE bot_settings SET captcha_enabled = ?, captcha_message_id = ?
        WHERE id = 1 AND captcha_message_id < ?
      `).bind(mode === "on" ? 1 : 0, message.message_id, message.message_id).run();
    }
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: t(env.BOT_LANGUAGE, await captchaEnabled(env) ? "captchaEnabled" : "captchaDisabled")
        + "\n\n" + t(env.BOT_LANGUAGE, "captchaControls")
    });
    return;
  }
  if (command === "unblock") {
    const targetId = /^\/unblock(?:@[A-Za-z0-9_]+)?\s+(\d+)\s*$/i.exec(message.text.trim())?.[1];
    if (targetId) {
      const result = await env.BOT_DB.prepare(`
        UPDATE users SET blocked = 0, blocked_notice_at = 0, updated_at = ?
        WHERE user_id = ? AND blocked = 1
      `).bind(Math.floor(Date.now() / 1000), targetId).run();
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: t(env.BOT_LANGUAGE, Number(result.meta?.changes || 0) === 1 ? "unblocked" : "notBlocked")
      });
      return;
    }
    if (env.ADMIN_GROUP_ID) {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: t(env.BOT_LANGUAGE, "adminHelpTopic")
      });
      return;
    }
  }

  if (!env.ADMIN_GROUP_ID) return processDirectAdminReply(message, env);
  return sendAdminReplyHint(message, env, "topicRequired");
}

async function configureAdminMenu(env) {
  const language = env.BOT_LANGUAGE;
  const commands = (names, prefix = "command_") => names.map((command) => ({
    command,
    description: t(language, `${prefix}${command}`)
  }));
  try {
    await telegram(env, "setMyCommands", {
      scope: { type: "chat", chat_id: env.ADMIN_USER_ID },
      commands: commands(env.ADMIN_GROUP_ID
        ? ["start", "help", "status", "captcha", "unblock"]
        : ["start", "help", "status", "captcha", "user", "block", "unblock"])
    });
    if (env.ADMIN_GROUP_ID) {
      await telegram(env, "setMyCommands", {
        scope: { type: "chat_member", chat_id: env.ADMIN_GROUP_ID, user_id: Number(env.ADMIN_USER_ID) },
        commands: commands(["help", "status", "user", "block", "unblock", "close"])
      });
    }
    await telegram(env, "setMyCommands", {
      scope: { type: "all_private_chats" },
      commands: userCommands(language)
    });
    // Existing webhooks may subscribe only to messages. Keep their URL and pending updates.
    const webhook = await telegram(env, "getWebhookInfo", {});
    if (webhook.url && !webhook.has_custom_certificate && webhook.allowed_updates?.length
      && !webhook.allowed_updates.includes("callback_query")) {
      await telegram(env, "setWebhook", {
        url: webhook.url,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: [...webhook.allowed_updates, "callback_query"],
        max_connections: webhook.max_connections,
        drop_pending_updates: false
      });
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "admin_menu_setup_failed", error: sanitizeError(error) }));
  }
}

async function sendAdminStatus(chatId, topicId, env) {
  const now = Math.floor(Date.now() / 1000);
  const counts = await env.BOT_DB.prepare(`
    SELECT status, COUNT(*) AS total,
      SUM(CASE WHEN status = 'processing' AND updated_at <= ? THEN 1 ELSE 0 END) AS stalled,
      MAX(updated_at) AS latest_at
    FROM processed_updates
    WHERE status IN ('done', 'processing', 'failed', 'discarded')
      AND updated_at >= ? AND update_id IS NOT ? GROUP BY status
  `).bind(now - UPDATE_LEASE_SECONDS, now - 86400, env._updateLease?.id ?? null).all();
  const byStatus = Object.fromEntries((counts.results || []).map((row) => [row.status, row.total]));
  const stalled = (counts.results || []).find((row) => row.status === "processing")?.stalled || 0;
  const lastRelay = await env.BOT_DB.prepare("SELECT MAX(created_at) AS latest_at FROM message_map").first();
  const lastFailure = (counts.results || []).filter((row) => ["failed", "discarded"].includes(row.status))
    .sort((left, right) => right.latest_at - left.latest_at)[0];
  const issue = lastFailure ? await env.BOT_DB.prepare(`
    SELECT last_error FROM processed_updates
    WHERE status = ? AND updated_at = ? AND update_id IS NOT ? LIMIT 1
  `).bind(lastFailure.status, lastFailure.latest_at, env._updateLease?.id ?? null).first() : null;
  let pending = t(env.BOT_LANGUAGE, "unknown");
  try {
    const webhook = await telegram(env, "getWebhookInfo", {});
    pending = String(webhook.pending_update_count ?? pending);
  } catch (error) {
    console.log(JSON.stringify({ event: "admin_status_webhook_unavailable", error: sanitizeError(error) }));
  }
  const language = env.BOT_LANGUAGE;
  const separator = t(language, "fieldSeparator");
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    message_thread_id: topicId,
    text: [
      t(language, "adminStatus"),
      "",
      ...[
        ["statusDone", byStatus.done || 0],
        ["statusProcessing", byStatus.processing || 0],
        ["statusStalled", stalled],
        ["statusFailed", byStatus.failed || 0],
        ["statusDiscarded", byStatus.discarded || 0],
        ["statusPending", pending]
      ].map(([key, value]) => `${t(language, key)}${separator}${value}`),
      "",
      `${t(language, "statusLastRelay")}${separator}${lastRelay?.latest_at
        ? formatAge(lastRelay.latest_at, now, language) : t(language, "statusNoRelay")}`,
      `${t(language, "statusLastError")}${separator}${lastFailure
        ? `${summarizeFailure(issue?.last_error, language)} (${formatAge(lastFailure.latest_at, now, language)})`
        : t(language, "statusNoError")}`
    ].join("\n")
  });
}

function formatAge(timestamp, now, language) {
  const seconds = Math.max(0, now - Number(timestamp));
  const [unit, size] = seconds < 60 ? ["second", 1] : seconds < 3600
    ? ["minute", 60] : seconds < 86400 ? ["hour", 3600] : ["day", 86400];
  return new Intl.RelativeTimeFormat(language || "zh", { numeric: "auto" })
    .format(-Math.floor(seconds / size), unit);
}

function summarizeFailure(error, language) {
  const text = String(error || "");
  const key = /\b429\b|too many requests/i.test(text) ? "failureRateLimit"
    : /\b403\b|forbidden|blocked/i.test(text) ? "failurePermission"
    : /\b400\b/.test(text) ? "failureUnsupported"
    : /\b5\d\d\b|網路|逾時|timeout|fetch failed|回應讀取/i.test(text) ? "failureUnavailable"
    : "failureProcessing";
  return t(language, key);
}

async function processUserMessage(message, env) {
  const command = parseCommand(message.text);
  const now = Math.floor(Date.now() / 1000);
  const userId = String(message.from.id);
  let user = await getUser(env.BOT_DB, userId);
  env = { ...env, _userLanguage: user?.language || env.BOT_LANGUAGE || "zh" };
  if (command === "help" || command === "id") {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: command === "help" ? userText(env, "userHelp")
        : `${userText(env, "userId")}${userText(env, "fieldSeparator")}${message.from.id}`
    });
    return;
  }
  if (command === "forget") {
    const confirmed = /^\/forget(?:@[A-Za-z0-9_]+)?\s+confirm\s*$/i.test(message.text.trim());
    if (confirmed) {
      await forgetUser(env.BOT_DB, userId, message.message_id, now);
      const current = await getUser(env.BOT_DB, userId);
      if (!current?.language && current?.forgotten_message_id === message.message_id) {
        await telegram(env, "deleteMyCommands", { scope: { type: "chat", chat_id: message.chat.id } });
      }
    }
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: userText(env, confirmed ? "forgetDone" : "forgetConfirm")
    });
    return;
  }

  if (message.message_id <= (user?.forgotten_message_id || 0)) return;
  if (command === "language") {
    const selected = /^\/language(?:@[A-Za-z0-9_]+)?\s+(zh|en|ja)\s*$/i.exec(message.text.trim())?.[1].toLowerCase();
    if (selected) {
      return saveUserLanguage(message.chat.id, selected, message.message_id, message.message_id,
        user?.generation || 0, env);
    }
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: "選擇語言 / Choose a language / 言語を選択",
      reply_markup: languageKeyboard(message, user)
    });
    return;
  }

  if (user?.blocked) {
    if (await claimBlockedNotice(env.BOT_DB, userId, now)) {
      try {
        await telegram(env, "sendMessage", {
          chat_id: message.chat.id,
          text: userText(env, "blockedNotice", "BLOCKED_MESSAGE")
        });
      } catch (error) {
        await releaseBlockedNotice(env.BOT_DB, userId, now).catch(() => {});
        throw error;
      }
    }
    return;
  }

  if (message.message_id <= (user?.forgotten_message_id || 0)) return;
  if (command === "start") {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      text: userText(env, "welcome", "WELCOME_MESSAGE"),
      reply_markup: languageKeyboard(message, user)
    });
    return;
  }
  if (user?.captcha_verified && user.captcha_pending_group) {
    await resumeCaptchaMessage(message, user, env, now);
    user = await getUser(env.BOT_DB, userId);
  }
  const needsCaptcha = !user?.captcha_verified && await captchaEnabled(env);
  // Late members of the first album can arrive after the answer's update.
  const firstAlbum = user?.captcha_verified && message.media_group_id && message.message_id <= user.captcha_message_id
    ? await getMediaGroup(env.BOT_DB, userId, captchaGroupId(message)) : null;
  if (user?.captcha_message_id >= message.message_id && !(firstAlbum
    && firstAlbum.user_generation === user.generation && firstAlbum.state !== "rejected")) {
    if (user.captcha_verified && user.captcha_message_id === message.message_id) {
      await telegram(env, "sendMessage", { chat_id: message.chat.id, text: userText(env, "captchaPassed") });
    } else if (needsCaptcha) await processCaptcha(message, user, env, now);
    return;
  }
  if (needsCaptcha) {
    return processCaptcha(message, user, env, now);
  }
  if (await getMessageMap(env.BOT_DB, String(message.chat.id), message.message_id)) return;

  const interval = clampInteger(
    env.MESSAGE_INTERVAL_SECONDS,
    0,
    60,
    2
  );
  user = await upsertUser(env.BOT_DB, message.from, now, message.message_id);
  if (!user || user.blocked || user.erased || message.message_id <= user.forgotten_message_id) return;
  if (user.captcha_pending_group) await resumeCaptchaMessage(message, user, env, now);
  if (message.media_group_id) {
    const queued = await enqueueMediaMessage(message, user, "user_to_admin", env, now, interval);
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
  if (!(await claimRateSlot(env.BOT_DB, user, now, interval, rateKey))) {
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

  const copyParameters = {
    chat_id: env.ADMIN_GROUP_ID,
    from_chat_id: message.chat.id,
    message_id: message.message_id,
    message_thread_id: user.topic_id,
    reply_parameters: replyParameters
  };
  let copied;
  try {
    copied = await telegramToTopic(env, "copyMessage", copyParameters, user);
  } catch (error) {
    if (!isTopicMissing(error)) {
      await notifyUserCopyFailure(message.chat.id, error, env);
      throw error;
    }
    await clearUserTopic(env.BOT_DB, user.user_id, user.topic_id);
    user = await ensureUserTopic({ ...user, topic_id: null }, message.from, env);
    copyParameters.message_thread_id = user.topic_id;
    copied = await telegramToTopic(env, "copyMessage", copyParameters, user);
  }

  await saveCopiedMessage(env, user, message, copied, env.ADMIN_GROUP_ID, now);
}

function userText(env, key, override) {
  const language = env._userLanguage || env.BOT_LANGUAGE || "zh";
  return (override && language === (env.BOT_LANGUAGE || "zh") && env[override]) || t(language, key);
}

function userCommands(language) {
  return ["start", "help", "language", "id", "forget"].map((command) => ({
    command,
    description: command === "language" ? "中文 / English / 日本語" : t(language, `userCommand_${command}`)
  }));
}

function languageKeyboard(message, user) {
  return { inline_keyboard: [Object.entries(USER_LANGUAGES).map(([language, text]) => ({
    text, callback_data: `lang:${language}:${user?.generation || 0}:${message.message_id}`
  }))] };
}

async function saveUserLanguage(chatId, language, messageId, originId, generation, env) {
  const now = Math.floor(Date.now() / 1000);
  const result = await env.BOT_DB.prepare(`
    INSERT INTO users(user_id, created_at, updated_at, language, language_message_id)
    SELECT ?, ?, ?, ?, ? WHERE ? = 0 OR EXISTS (
      SELECT 1 FROM users WHERE user_id = ? AND generation = ? AND forgotten_message_id < ?)
    ON CONFLICT(user_id) DO UPDATE SET language = excluded.language,
      language_message_id = excluded.language_message_id, updated_at = excluded.updated_at, erased = 0
    WHERE users.generation = ? AND users.forgotten_message_id < ? AND users.language_message_id < ?
  `).bind(String(chatId), now, now, language, messageId, generation,
    String(chatId), generation, originId, generation, originId, messageId).run();
  const current = await getUser(env.BOT_DB, String(chatId));
  if (!current || current.generation !== generation || current.forgotten_message_id >= originId) return;
  // One selection per keyboard. Old/retried updates cannot replace a newer preference.
  if (Number(result.meta?.changes || 0) !== 1
    && (current.language_message_id !== messageId || current.language !== language)) return;
  await telegram(env, "setMyCommands", {
    scope: { type: "chat", chat_id: chatId }, commands: userCommands(language)
  });
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: t(language, "languageSaved") + "\n\n" + userText({ ...env, _userLanguage: language }, "welcome", "WELCOME_MESSAGE")
  });
}

async function processLanguageCallback(query, env) {
  const message = query.message;
  const choice = /^lang:(zh|en|ja):(\d+):(\d+)$/.exec(query.data || "");
  if (!choice || !query.from || query.from.is_bot || message?.chat?.type !== "private"
    || String(message.chat.id) !== String(query.from.id)
    || String(query.from.id) === String(env.ADMIN_USER_ID) || !Number.isSafeInteger(message.message_id)
    || !Number.isSafeInteger(Number(choice[2])) || !Number.isSafeInteger(Number(choice[3]))
    || Number(choice[3]) <= 0 || message.message_id <= Number(choice[3])) return;
  await saveUserLanguage(message.chat.id, choice[1], message.message_id, Number(choice[3]), Number(choice[2]), env);
  await telegram(env, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
  await telegram(env, "editMessageReplyMarkup", {
    chat_id: message.chat.id, message_id: message.message_id, reply_markup: { inline_keyboard: [] }
  }).catch(() => {});
}

export function captchaQuestion(code) {
  const a = Math.floor(code / 4) % 9 + 1;
  const b = Math.floor(code / 36) + 1;
  switch (code % 4) {
    case 0: return { question: `${a} + ${b}`, answer: a + b };
    case 1: return { question: `${Math.max(a, b)} − ${Math.min(a, b)}`, answer: Math.abs(a - b) };
    case 2: return { question: `${a} × ${b}`, answer: a * b };
    default: return { question: `${a * b} ÷ ${b}`, answer: a };
  }
}

async function captchaEnabled(env) {
  const settings = await env.BOT_DB.prepare("SELECT captcha_enabled FROM bot_settings WHERE id = 1").first();
  if (!settings) throw new RetryableError("驗證開關設定遺失，暫停處理");
  return settings.captcha_enabled == null ? env.CAPTCHA_ENABLED !== "false" : settings.captcha_enabled === 1;
}

function captchaGroupId(message) {
  return message.media_group_id ? `captcha:album:${message.media_group_id}` : `captcha:message:${message.message_id}`;
}

async function clearCaptchaPending(db, user, resetCode = false) {
  if (!user.captcha_pending_group && (!resetCode || user.captcha_code == null)) return;
  const group = user.captcha_pending_group ?? null;
  await db.batch([
    ...(group ? ["media_group_messages", "media_groups"] : []).map((table) => db.prepare(`
      DELETE FROM ${table} WHERE source_chat_id = ? AND media_group_id = ?
        AND EXISTS (SELECT 1 FROM users WHERE user_id = ? AND generation = ? AND captcha_pending_group = ?
          AND captcha_message_id = ? AND captcha_verified = 0)
    `).bind(user.user_id, group, user.user_id, user.generation, group, user.captcha_message_id)),
    db.prepare(`UPDATE users SET captcha_pending_group = NULL,
      captcha_code = CASE WHEN ? = 1 THEN NULL ELSE captcha_code END,
      captcha_until = CASE WHEN ? = 1 THEN 0 ELSE captcha_until END
      WHERE user_id = ? AND generation = ? AND captcha_pending_group IS ? AND captcha_message_id = ? AND captcha_verified = 0
    `).bind(resetCode ? 1 : 0, resetCode ? 1 : 0, user.user_id, user.generation, group, user.captcha_message_id)
  ]);
}

async function resumeCaptchaMessage(message, user, env, now) {
  const groupId = user.captcha_pending_group;
  await requireCurrentUser(env.BOT_DB, user, true);
  const current = await upsertUser(env.BOT_DB, message.from, now, message.message_id);
  if (!current || current.erased || current.blocked || current.generation !== user.generation) throw new ObsoleteWorkError();
  const clear = () => env.BOT_DB.prepare(`UPDATE users SET captcha_pending_group = NULL
    WHERE user_id = ? AND generation = ? AND captcha_pending_group = ?
  `).bind(user.user_id, user.generation, groupId).run();
  await env.BOT_DB.prepare(`UPDATE media_groups SET state = 'collecting', lease_until_ms = 0, lease_token = NULL
    WHERE source_chat_id = ? AND media_group_id = ? AND user_generation = ? AND state = 'initializing'
      AND EXISTS (SELECT 1 FROM users WHERE user_id = ? AND generation = ? AND captcha_verified = 1
        AND blocked = 0 AND erased = 0 AND captcha_pending_group = ?)
  `).bind(user.user_id, groupId, user.generation, user.user_id, user.generation, groupId).run();
  try {
    await flushMediaGroup(user.user_id, groupId, env);
  } catch (error) {
    if (!isRetryableError(error) && !(error instanceof ObsoleteWorkError)) await clear();
    throw error;
  }
  const group = await getMediaGroup(env.BOT_DB, user.user_id, groupId);
  if (group && !["done", "rejected"].includes(group.state)) throw new RetryableError("首次訊息仍在轉送中");
  await clear();
  if (!group) await telegram(env, "sendMessage", { chat_id: user.user_id, text: userText(env, "captchaPendingLost") });
}

async function processCaptcha(message, user, env, now) {
  const db = env.BOT_DB;
  if (!user) {
    await db.prepare("INSERT OR IGNORE INTO users(user_id, created_at, updated_at) VALUES (?, ?, ?)")
      .bind(String(message.from.id), now, now).run();
    user = await getUser(db, String(message.from.id));
  }
  if (!user || user.blocked || user.captcha_verified || message.message_id <= user.forgotten_message_id) return;
  const send = (key, code = user.captcha_code) => telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    text: userText(env, key).replace("{question}", code == null ? "" : captchaQuestion(code).question)
  });
  if (message.media_group_id && user.captcha_pending_group === captchaGroupId(message)
    && user.captcha_until > now && user.captcha_attempts < 3) {
    await db.batch([
      db.prepare(`INSERT OR IGNORE INTO media_group_messages(source_chat_id, media_group_id, message_id, created_at)
        SELECT ?, ?, ?, ? FROM users WHERE user_id = ? AND generation = ? AND erased = 0 AND blocked = 0
          AND captcha_verified = 0 AND captcha_pending_group = ? AND captcha_until > ?
          AND (SELECT COUNT(*) FROM media_group_messages WHERE source_chat_id = ? AND media_group_id = ?) < 10
      `).bind(user.user_id, user.captcha_pending_group, message.message_id, now, user.user_id, user.generation,
        user.captcha_pending_group, now, user.user_id, user.captcha_pending_group),
      db.prepare(`UPDATE media_groups SET updated_at_ms = ? WHERE source_chat_id = ? AND media_group_id = ?
        AND state = 'initializing' AND user_generation = ? AND EXISTS
          (SELECT 1 FROM users WHERE user_id = ? AND generation = ? AND captcha_verified = 0 AND captcha_until > ?)
      `).bind(Date.now(), user.user_id, user.captcha_pending_group, user.generation, user.user_id, user.generation, now)
    ]);
    const current = await getUser(db, user.user_id);
    if (current?.captcha_verified && current.generation === user.generation) return processUserMessage(message, env);
    if (message.message_id === user.captcha_message_id) await send("captchaPrompt");
    return;
  }
  if (message.message_id <= user.captcha_message_id) {
    if (message.message_id === user.captcha_message_id) {
      await send(user.captcha_until <= now ? "captchaExpired" : user.captcha_attempts >= 3
        ? "captchaLocked" : user.captcha_attempts > 0 ? "captchaWrong" : "captchaPrompt");
    }
    return;
  }
  if (user.captcha_attempts >= 3 && user.captcha_until > now) return;
  const answer = typeof message.text === "string" && message.text.length <= 16
    ? message.text.normalize("NFKC").trim() : "";
  if (user.captcha_code != null && (user.captcha_until <= now || !user.captcha_pending_group)
    && /^\d{1,3}$/.test(answer)) {
    await clearCaptchaPending(db, user, true);
    const expired = await db.prepare(`UPDATE users SET captcha_code = NULL, captcha_until = 0,
      captcha_attempts = 0, captcha_last_at = ?, captcha_message_id = ?
      WHERE user_id = ? AND generation = ? AND captcha_verified = 0 AND captcha_code IS NULL
        AND captcha_message_id = ? AND captcha_until = 0
    `).bind(now, message.message_id, user.user_id, user.generation, user.captcha_message_id).run();
    if (Number(expired.meta?.changes || 0) === 1) await send("captchaExpired");
    return;
  }
  if (user.captcha_code == null || user.captcha_until <= now || !user.captcha_pending_group) {
    await clearCaptchaPending(db, user, true);
    const code = crypto.getRandomValues(new Uint32Array(1))[0] % 324;
    const groupId = captchaGroupId(message);
    const result = await db.batch([db.prepare(`
      UPDATE users SET captcha_code = ?, captcha_until = ?, captcha_attempts = 0,
        captcha_last_at = ?, captcha_message_id = ?, captcha_pending_group = ?, erased = 0, updated_at = ?
      WHERE user_id = ? AND generation = ? AND blocked = 0 AND captcha_verified = 0
        AND forgotten_message_id < ? AND captcha_message_id < ?
        AND (captcha_code IS NULL OR captcha_until <= ?)
    `).bind(code, now + CAPTCHA_TTL_SECONDS, now, message.message_id, groupId, now,
      user.user_id, user.generation, message.message_id, message.message_id, now),
      db.prepare(`INSERT OR IGNORE INTO media_groups(source_chat_id, media_group_id, user_id, direction,
        state, updated_at_ms, created_at, user_generation)
        SELECT user_id, ?, user_id, 'user_to_admin', 'initializing', ?, ?, generation FROM users
        WHERE user_id = ? AND generation = ? AND captcha_pending_group = ? AND captcha_message_id = ? AND captcha_verified = 0
      `).bind(groupId, Date.now(), now, user.user_id, user.generation, groupId, message.message_id),
      db.prepare(`INSERT OR IGNORE INTO media_group_messages(source_chat_id, media_group_id, message_id, created_at)
        SELECT user_id, ?, ?, ? FROM users WHERE user_id = ? AND generation = ?
          AND captcha_pending_group = ? AND captcha_message_id = ? AND captcha_verified = 0
      `).bind(groupId, message.message_id, now, user.user_id, user.generation, groupId, message.message_id)
    ]);
    if (Number(result[0].meta?.changes || 0) === 1) await send("captchaPrompt", code);
    else if (message.media_group_id) {
      const current = await getUser(db, user.user_id);
      if (current?.captcha_pending_group === groupId && current.generation === user.generation) {
        return processCaptcha(message, current, env, now);
      }
    }
    return;
  }

  if (/^\d{1,3}$/.test(answer) && Number(answer) === captchaQuestion(user.captcha_code).answer) {
    const result = await db.prepare(`
      UPDATE users SET captcha_verified = 1, captcha_code = NULL, captcha_until = 0,
        captcha_attempts = 0, captcha_last_at = ?, captcha_message_id = ?, erased = 0, updated_at = ?
      WHERE user_id = ? AND generation = ? AND blocked = 0 AND captcha_verified = 0
        AND captcha_code = ? AND captcha_until > ? AND captcha_attempts < 3
        AND forgotten_message_id < ? AND captcha_message_id < ?
    `).bind(now, message.message_id, now, user.user_id, user.generation,
      user.captcha_code, now, message.message_id, message.message_id).run();
    if (Number(result.meta?.changes || 0) === 1) {
      if (user.captcha_pending_group) await resumeCaptchaMessage(message, user, env, now);
      await send("captchaPassed");
    }
    return;
  }

  const reminder = Boolean(parseCommand(message.text));
  if (user.captcha_last_at > now - (reminder ? 60 : 5)) return;
  const attempts = user.captcha_attempts + (reminder ? 0 : 1);
  const result = await db.prepare(`
    UPDATE users SET captcha_attempts = ?, captcha_until = ?, captcha_last_at = ?,
      captcha_message_id = ?, updated_at = ?
    WHERE user_id = ? AND generation = ? AND blocked = 0 AND captcha_verified = 0
      AND captcha_code = ? AND captcha_until > ? AND captcha_attempts = ?
      AND captcha_last_at = ? AND forgotten_message_id < ? AND captcha_message_id < ?
  `).bind(attempts, attempts >= 3 ? now + CAPTCHA_COOLDOWN_SECONDS : user.captcha_until,
    now, message.message_id, now, user.user_id, user.generation, user.captcha_code,
    now, user.captcha_attempts, user.captcha_last_at, message.message_id, message.message_id).run();
  if (Number(result.meta?.changes || 0) === 1) {
    if (attempts >= 3) await clearCaptchaPending(db, { ...user, captcha_message_id: message.message_id });
    await send(attempts >= 3 ? "captchaLocked" : reminder ? "captchaPrompt" : "captchaWrong");
  }
}

async function forgetUser(db, userId, messageId, now) {
  await db.batch([
    db.prepare(`
      INSERT OR IGNORE INTO users(user_id, created_at, updated_at, erased)
      VALUES (?, ?, ?, 1)
    `).bind(userId, now, now),
    db.prepare(`
      DELETE FROM media_group_messages WHERE (source_chat_id = ? OR EXISTS (
        SELECT 1 FROM media_groups AS groups
        WHERE groups.user_id = ?
          AND groups.source_chat_id = media_group_messages.source_chat_id
          AND groups.media_group_id = media_group_messages.media_group_id
      ))
        AND EXISTS (SELECT 1 FROM users WHERE user_id = ? AND forgotten_message_id < ?)
    `).bind(userId, userId, userId, messageId),
    ...["media_groups", "message_map", "rate_admissions"].map((table) => db.prepare(`
      DELETE FROM ${table} WHERE user_id = ?
        AND EXISTS (SELECT 1 FROM users WHERE user_id = ? AND forgotten_message_id < ?)
    `).bind(userId, userId, messageId)),
    db.prepare(`
      UPDATE users SET username = NULL, first_name = '', last_name = '', topic_id = NULL,
        topic_card_message_id = NULL, topic_lease_until = 0, topic_lease_token = NULL,
        last_rate_key = NULL, blocked_notice_at = 0, updated_at = ?,
        captcha_verified = 0, captcha_code = NULL, captcha_until = 0, captcha_attempts = 0,
        captcha_last_at = 0, captcha_message_id = 0, captcha_pending_group = NULL,
        language = NULL, language_message_id = MAX(language_message_id, ?),
        generation = generation + 1, erased = 1, forgotten_message_id = ?, forgotten_at = ?
      WHERE user_id = ? AND forgotten_message_id < ?
    `).bind(now, messageId, messageId, now, userId, messageId)
  ]);
}

export async function relayUserMessageToAdmin(message, user, env, now) {
  if (await getMessageMap(env.BOT_DB, String(message.chat.id), message.message_id)) return;
  await requireCurrentUser(env.BOT_DB, user, true);

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

  await saveCopiedMessage(env, user, message, copied, env.ADMIN_USER_ID, now);
}

export async function processDirectAdminReply(message, env) {
  if (await getMessageMap(env.BOT_DB, String(message.chat.id), message.message_id)) return;
  const repliedMessageId = message.reply_to_message?.message_id;
  if (!repliedMessageId) {
    const command = parseCommand(message.text);
    if (["user", "block", "unblock"].includes(command)) {
      await telegram(env, "sendMessage", {
        chat_id: message.chat.id,
        text: t(env.BOT_LANGUAGE, "adminHelpDirect")
      });
    } else if (command) await sendUnknownCommand(message.chat.id, undefined, env);
    else await sendAdminReplyHint(message, env, "replyRequired");
    return;
  }

  const mapping = await env.BOT_DB.prepare(`
    SELECT source_message_id, user_id
    FROM message_map
    WHERE target_chat_id = ? AND target_message_id = ?
  `).bind(String(env.ADMIN_USER_ID), repliedMessageId).first();
  if (!mapping) {
    return sendAdminReplyHint(message, env, "replyUnavailable");
  }

  const user = await getUser(env.BOT_DB, mapping.user_id);
  if (!user || user.erased) return sendAdminReplyHint(message, env, "replyUnavailable");

  const command = parseCommand(message.text);
  if (command) {
    if (await handleAdminCommand(command, message, user, env)) return;
    await sendUnknownCommand(message.chat.id, undefined, env);
    return;
  }

  if (message.media_group_id) {
    const queued = await enqueueMediaMessage(
      message,
      user,
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
  await saveCopiedMessage(env, user, message, copied, user.user_id, Math.floor(Date.now() / 1000));
}

function buildDirectUserStatus(user, language) {
  const username = user.username ? `@${escapeHtml(safeIdentityText(user.username))}` : t(language, "notSet");
  const separator = t(language, "fieldSeparator");
  return [
    `<b>${t(language, "userDetails")}</b>`,
    `User ID${separator}<code>${escapeHtml(user.user_id)}</code>`,
    `${t(language, "name")}${separator}${escapeHtml(safeIdentityText([user.first_name, user.last_name].filter(Boolean).join(" ")) || t(language, "notProvided"))}`,
    `${t(language, "username")}${separator}${username}`,
    `${t(language, "status")}${separator}${t(language, user.blocked ? "blockedStatus" : "normalStatus")}`
  ].join("\n");
}

async function processAdminTopicMessage(message, env) {
  if (String(message.from?.id) !== String(env.ADMIN_USER_ID)) return;
  const command = parseCommand(message.text);
  if (command === "status") return sendAdminStatus(env.ADMIN_GROUP_ID, message.message_thread_id, env);
  if (command === "help") {
    await telegram(env, "sendMessage", {
      chat_id: env.ADMIN_GROUP_ID,
      message_thread_id: message.message_thread_id,
      text: t(env.BOT_LANGUAGE, "adminHelpTopic")
    });
    return;
  }

  if (!message.message_thread_id || message.is_topic_message === false) {
    return sendAdminReplyHint(message, env, "topicRequired");
  }
  if (await getMessageMap(env.BOT_DB, String(message.chat.id), message.message_id)) return;

  const user = await getUserByTopic(env.BOT_DB, message.message_thread_id);
  if (!user) return sendAdminReplyHint(message, env, "replyUnavailable");

  if (command) {
    const handled = await handleAdminCommand(command, message, user, env);
    if (handled) return;
    await sendUnknownCommand(env.ADMIN_GROUP_ID, message.message_thread_id, env);
    return;
  }

  if (message.media_group_id) {
    const queued = await enqueueMediaMessage(
      message,
      user,
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

  await saveCopiedMessage(env, user, message, copied, user.user_id, Math.floor(Date.now() / 1000));
}

async function handleAdminCommand(command, message, user, env) {
  const isTopic = String(message.chat.id) === String(env.ADMIN_GROUP_ID);
  const target = isTopic
    ? { chat_id: env.ADMIN_GROUP_ID, message_thread_id: message.message_thread_id }
    : { chat_id: env.ADMIN_USER_ID };
  if (command === "user") {
    await telegram(env, "sendMessage", {
      ...target,
      text: buildDirectUserStatus(user, env.BOT_LANGUAGE),
      parse_mode: "HTML"
    });
    return true;
  }
  if (command === "block" || command === "unblock") {
    const blocked = command === "block" ? 1 : 0;
    await env.BOT_DB.prepare(
      "UPDATE users SET blocked = ?, blocked_notice_at = 0, updated_at = ? WHERE user_id = ?"
    ).bind(blocked, Math.floor(Date.now() / 1000), user.user_id).run();
    await telegram(env, "sendMessage", {
      ...target,
      text: t(env.BOT_LANGUAGE, blocked ? "blocked" : "unblocked")
    });
    return true;
  }
  if (command === "close" && isTopic) {
    await telegram(env, "closeForumTopic", target);
    return true;
  }
  return false;
}

async function processEditedMessage(message, env) {
  if (!message?.chat || !message.from) return;
  const isText = typeof message.text === "string";
  const hasCaptionMedia = ["photo", "video", "animation", "audio", "document", "voice"].some((key) => message[key]);
  if (!isText && typeof message.caption !== "string" && !hasCaptionMedia) return;
  const chatId = String(message.chat.id);
  const isUserEdit = message.chat.type === "private" && String(message.from?.id) !== String(env.ADMIN_USER_ID);
  const isAdminTopicEdit = chatId === String(env.ADMIN_GROUP_ID) && String(message.from?.id) === String(env.ADMIN_USER_ID);
  const isAdminPrivateEdit = !env.ADMIN_GROUP_ID
    && message.chat.type === "private"
    && String(message.from?.id) === String(env.ADMIN_USER_ID);
  if (!isUserEdit && !isAdminTopicEdit && !isAdminPrivateEdit) return;

  let editingUser;
  if (isUserEdit) {
    editingUser = await getUser(env.BOT_DB, String(message.from.id));
    if (editingUser?.blocked || editingUser?.erased
      || (!editingUser?.captcha_verified && await captchaEnabled(env))) return;
  }
  const mapping = await env.BOT_DB.prepare(
    "SELECT target_chat_id, target_message_id, user_id FROM message_map WHERE source_chat_id = ? AND source_message_id = ?"
  ).bind(chatId, message.message_id).first();
  if (!mapping) {
    if (isUserEdit && message.message_id <= (editingUser?.captcha_message_id || 0)) return;
    if (parseCommand(message.text)) return;
    if (isAdminPrivateEdit && !message.reply_to_message?.message_id) return;
    throw new RetryableError("編輯訊息尚未建立轉送映射");
  }
  if (isUserEdit && !editingUser) return;

  const method = isText ? "editMessageText" : "editMessageCaption";
  const payload = {
    chat_id: mapping.target_chat_id,
    message_id: mapping.target_message_id,
    ...(isText
      ? { text: message.text, entities: message.entities }
      : { caption: message.caption || "", caption_entities: message.caption_entities })
  };
  try {
    await telegram(env, method, payload);
  } catch (error) {
    if (!String(error.message).includes("message is not modified")) throw error;
  }
}

async function ensureUserTopic(user, from, env) {
  await requireCurrentUser(env.BOT_DB, user);
  from = { ...from, id: from.id ?? user.user_id };
  if (user.topic_id && user.topic_card_message_id != null) return user;
  if (user.topic_id) {
    try {
      const card = await sendTopicUserCard(user.topic_id, from, env, user);
      await saveTopicCardMessage(env.BOT_DB, user, user.topic_id, card.message_id);
      return { ...user, topic_card_message_id: card.message_id };
    } catch (error) {
      if (!isTopicMissing(error)) throw error;
      await clearUserTopic(env.BOT_DB, user.user_id, user.topic_id);
      user = { ...user, topic_id: null, topic_card_message_id: null };
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const token = crypto.randomUUID();
  const claimed = await env.BOT_DB.prepare(`
    UPDATE users SET topic_lease_until = ?, topic_lease_token = ?, updated_at = ?
    WHERE user_id = ? AND generation = ? AND erased = 0 AND blocked = 0
      AND topic_id IS NULL AND topic_lease_until <= ?
  `).bind(now + TOPIC_LEASE_SECONDS, token, now, user.user_id, user.generation, now).run();

  if (Number(claimed.meta?.changes || 0) === 1) {
    try {
      const topic = await telegram(env, "createForumTopic", {
        chat_id: env.ADMIN_GROUP_ID,
        name: buildTopicName(from, env.BOT_LANGUAGE)
      });
      const assigned = await env.BOT_DB.prepare(`
        UPDATE users SET topic_id = ?, topic_card_message_id = NULL,
          topic_lease_until = 0, topic_lease_token = NULL, updated_at = ?
        WHERE user_id = ? AND generation = ? AND erased = 0 AND blocked = 0
          AND topic_lease_token = ?
      `).bind(topic.message_thread_id, now, user.user_id, user.generation, token).run();
      if (Number(assigned.meta?.changes || 0) !== 1) throw new ObsoleteWorkError();
      const card = await sendTopicUserCard(topic.message_thread_id, from, env, user);
      await saveTopicCardMessage(env.BOT_DB, user, topic.message_thread_id, card.message_id);
      return {
        ...user,
        topic_id: topic.message_thread_id,
        topic_card_message_id: card.message_id
      };
    } catch (error) {
      await env.BOT_DB.prepare(
        "UPDATE users SET topic_lease_until = 0, topic_lease_token = NULL WHERE user_id = ? AND topic_id IS NULL AND topic_lease_token = ?"
      ).bind(user.user_id, token).run().catch(() => {});
      throw error;
    }
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await delay(150);
    const current = await getUser(env.BOT_DB, user.user_id);
    if (!current || current.erased || current.blocked || current.generation !== user.generation) throw new ObsoleteWorkError();
    if (current.topic_id) return current;
  }
  throw new RetryableError("等待 Topic 建立逾時");
}

async function clearUserTopic(db, userId, topicId) {
  await db.prepare(`
    UPDATE users SET topic_id = NULL, topic_card_message_id = NULL, topic_lease_until = 0
    WHERE user_id = ? AND topic_id = ?
  `).bind(userId, topicId).run();
}

async function sendTopicUserCard(topicId, from, env, user) {
  return telegramToTopic(env, "sendMessage", {
    chat_id: env.ADMIN_GROUP_ID,
    message_thread_id: topicId,
    text: buildUserCard(from, env.BOT_LANGUAGE),
    parse_mode: "HTML"
  }, user);
}

async function saveTopicCardMessage(db, user, topicId, messageId) {
  const result = await db.prepare(`
    UPDATE users SET topic_card_message_id = ?, updated_at = ?
    WHERE user_id = ? AND generation = ? AND erased = 0 AND topic_id = ?
  `).bind(messageId, Math.floor(Date.now() / 1000), user.user_id, user.generation, topicId).run();
  if (Number(result.meta?.changes || 0) !== 1) throw new ObsoleteWorkError();
}

async function enqueueMediaMessage(message, user, direction, env, now, interval) {
  await requireCurrentUser(env.BOT_DB, user, direction === "user_to_admin");
  const sourceChatId = String(message.chat.id);
  const mediaGroupId = String(message.media_group_id);
  const nowMs = Date.now();
  const token = crypto.randomUUID();
  const inserted = await env.BOT_DB.prepare(`
    INSERT OR IGNORE INTO media_groups(
      source_chat_id, media_group_id, user_id, direction, state,
      updated_at_ms, lease_until_ms, created_at, user_generation, lease_token
    ) SELECT ?, ?, ?, ?, 'initializing', ?, ?, ?, ?, ?
      FROM users WHERE user_id = ? AND generation = ? AND erased = 0
  `).bind(sourceChatId, mediaGroupId, user.user_id, direction, nowMs,
    nowMs + UPDATE_LEASE_SECONDS * 1000, now, user.generation, token,
    user.user_id, user.generation).run();
  const created = Number(inserted.meta?.changes || 0) === 1;

  try {
    await env.BOT_DB.prepare(`
      INSERT OR IGNORE INTO media_group_messages(
        source_chat_id, media_group_id, message_id, created_at
      ) SELECT ?, ?, ?, ? FROM media_groups
        WHERE source_chat_id = ? AND media_group_id = ? AND user_generation = ?
    `).bind(sourceChatId, mediaGroupId, message.message_id, now,
      sourceChatId, mediaGroupId, user.generation).run();
    await env.BOT_DB.prepare(`
      UPDATE media_groups SET updated_at_ms = ?
      WHERE source_chat_id = ? AND media_group_id = ? AND state IN ('initializing', 'collecting')
    `).bind(nowMs, sourceChatId, mediaGroupId).run();
    if (created) return await initializeMediaGroup(sourceChatId, mediaGroupId, user, direction, env, now, interval, token);
  } catch (error) {
    if (created) await releaseMediaLease(env.BOT_DB, sourceChatId, mediaGroupId, token).catch(() => {});
    throw error;
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const group = await getMediaGroup(env.BOT_DB, sourceChatId, mediaGroupId);
    if (!group || group.user_generation !== user.generation) throw new ObsoleteWorkError();
    if (group.state === "initializing" && Number(group.lease_until_ms) <= Date.now()) {
      const claimed = await env.BOT_DB.prepare(`
        UPDATE media_groups SET lease_until_ms = ?, lease_token = ?
        WHERE source_chat_id = ? AND media_group_id = ? AND state = 'initializing'
          AND lease_until_ms <= ? AND user_generation = ?
      `).bind(Date.now() + UPDATE_LEASE_SECONDS * 1000, token,
        sourceChatId, mediaGroupId, Date.now(), user.generation).run();
      if (Number(claimed.meta?.changes || 0) === 1) {
        try {
          return await initializeMediaGroup(sourceChatId, mediaGroupId, user, direction, env, now, interval, token);
        } catch (error) {
          await releaseMediaLease(env.BOT_DB, sourceChatId, mediaGroupId, token).catch(() => {});
          throw error;
        }
      }
    }
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

async function initializeMediaGroup(sourceChatId, mediaGroupId, user, direction, env, now, interval, token) {
  const accepted = direction !== "user_to_admin"
    || await claimRateSlot(env.BOT_DB, user, now, interval, `album:${mediaGroupId}`);
  const result = await env.BOT_DB.prepare(`
    UPDATE media_groups SET state = ?, lease_until_ms = 0, lease_token = NULL
    WHERE source_chat_id = ? AND media_group_id = ? AND state = 'initializing' AND lease_token = ?
  `).bind(accepted ? "collecting" : "rejected", sourceChatId, mediaGroupId, token).run();
  if (Number(result.meta?.changes || 0) !== 1) throw new ObsoleteWorkError();
  return { created: true, rejected: !accepted };
}

async function releaseMediaLease(db, sourceChatId, mediaGroupId, token) {
  await db.prepare(`
    UPDATE media_groups SET lease_until_ms = 0, lease_token = NULL
    WHERE source_chat_id = ? AND media_group_id = ? AND lease_token = ?
  `).bind(sourceChatId, mediaGroupId, token).run();
}

async function flushMediaGroup(sourceChatId, mediaGroupId, env) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const group = await getMediaGroup(env.BOT_DB, sourceChatId, mediaGroupId);
    if (!group || group.state === "done" || group.state === "rejected") return;
    if (group.state === "processing" && Number(group.lease_until_ms) > Date.now()) return;
    if (group.state === "processing") {
      await env.BOT_DB.prepare(`
        UPDATE media_groups SET state = 'collecting', lease_until_ms = 0, lease_token = NULL
        WHERE source_chat_id = ? AND media_group_id = ?
          AND state = 'processing' AND lease_until_ms <= ?
      `).bind(sourceChatId, mediaGroupId, Date.now()).run();
      continue;
    }

    const remaining = Number(group.updated_at_ms) + MEDIA_GROUP_QUIET_MS - Date.now();
    if (remaining > 0) await delay(remaining);
    const claimTime = Date.now();
    const token = crypto.randomUUID();
    const claimed = await env.BOT_DB.prepare(`
      UPDATE media_groups SET state = 'processing', lease_until_ms = ?, lease_token = ?
      WHERE source_chat_id = ? AND media_group_id = ?
        AND state = 'collecting' AND updated_at_ms <= ?
    `).bind(
      claimTime + UPDATE_LEASE_SECONDS * 1000,
      token,
      sourceChatId,
      mediaGroupId,
      claimTime - MEDIA_GROUP_QUIET_MS
    ).run();
    if (Number(claimed.meta?.changes || 0) !== 1) continue;

    try {
      await deliverMediaGroup(group, { ...env, _albumLease: { sourceChatId, mediaGroupId, token } });
      await env.BOT_DB.prepare(`
        UPDATE media_groups SET state = 'done', lease_until_ms = 0, lease_token = NULL, last_error = NULL
        WHERE source_chat_id = ? AND media_group_id = ? AND lease_token = ?
      `).bind(sourceChatId, mediaGroupId, token).run();
      return;
    } catch (error) {
      await notifyMediaFailure(group, error, env);
      await env.BOT_DB.prepare(`
        UPDATE media_groups SET state = ?, lease_until_ms = 0, lease_token = NULL, last_error = ?
        WHERE source_chat_id = ? AND media_group_id = ? AND lease_token = ?
      `).bind(
        isRetryableError(error) || error instanceof ObsoleteWorkError ? "collecting" : "rejected",
        sanitizeError(error),
        sourceChatId,
        mediaGroupId,
        token
      ).run().catch(() => {});
      throw error;
    }
  }
  throw new RetryableError("相簿尚未取得處理租約");
}

async function deliverMediaGroup(group, env) {
  const rows = await env.BOT_DB.prepare(`
    SELECT message_id FROM media_group_messages AS messages
    WHERE source_chat_id = ? AND media_group_id = ?
      AND NOT EXISTS (SELECT 1 FROM message_map WHERE source_chat_id = messages.source_chat_id
        AND source_message_id = messages.message_id)
    ORDER BY message_id ASC
  `).bind(group.source_chat_id, group.media_group_id).all();
  const messageIds = (rows.results || []).map((row) => Number(row.message_id));
  if (!messageIds.length) return;

  const user = await getUser(env.BOT_DB, group.user_id);
  if (!user || user.erased || user.generation !== group.user_generation) throw new ObsoleteWorkError();
  if (group.media_group_id.startsWith("captcha:") && !user.captcha_verified) throw new ObsoleteWorkError();
  await requireCurrentUser(env.BOT_DB, user, group.direction === "user_to_admin");
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

  const copyParameters = {
    chat_id: targetChatId,
    from_chat_id: group.source_chat_id,
    message_ids: messageIds,
    message_thread_id: topicId
  };
  let copied;
  try {
    copied = await telegramToTopic(env, "copyMessages", copyParameters, user);
  } catch (error) {
    if (group.direction !== "user_to_admin" || !topicId || !isTopicMissing(error)) throw error;
    await clearUserTopic(env.BOT_DB, user.user_id, topicId);
    const topicUser = await ensureUserTopic({ ...user, topic_id: null }, user, env);
    copyParameters.chat_id = env.ADMIN_GROUP_ID;
    copyParameters.message_thread_id = topicUser.topic_id;
    copied = await telegramToTopic(env, "copyMessages", copyParameters, user);
  }

  if (!Array.isArray(copied) || copied.length !== messageIds.length) {
    await rollbackCopiedMessages(targetChatId, copied, env);
    throw new NonRetryableError("Telegram 未完整複製相簿");
  }
  const now = Math.floor(Date.now() / 1000);
  await saveCopiedMappings(env, user, messageIds.map((sourceMessageId, index) => ({
    sourceChatId: group.source_chat_id,
    sourceMessageId,
    targetChatId,
    targetMessageId: copied[index].message_id,
    userId: user.user_id,
    now
  })));
}

async function rollbackCopiedMessages(targetChatId, copied, env) {
  const copiedIds = Array.isArray(copied)
    ? copied.map((item) => Number(item?.message_id)).filter(Number.isSafeInteger)
    : [];
  if (!copiedIds.length) return true;
  try {
    await telegram(env, "deleteMessages", {
      chat_id: targetChatId,
      message_ids: copiedIds
    });
    return true;
  } catch (error) {
    console.log(JSON.stringify({
      event: "partial_album_rollback_failed",
      target_chat_id: String(targetChatId),
      count: copiedIds.length,
      error: sanitizeError(error)
    }));
    return false;
  }
}

async function sendDirectUserHeader(user, env) {
  const language = env.BOT_LANGUAGE;
  const separator = t(language, "fieldSeparator");
  const name = safeIdentityText([user.first_name, user.last_name].filter(Boolean).join(" ")) || t(language, "notProvided");
  const username = user.username ? `@${escapeHtml(safeIdentityText(user.username))}` : t(language, "notSet");
  const header = await telegram(env, "sendMessage", {
    chat_id: env.ADMIN_USER_ID,
    text: [
      `<b>${t(language, "receivedChat")}</b>`,
      `User ID${separator}<code>${escapeHtml(user.user_id)}</code>`,
      `${t(language, "name")}${separator}${escapeHtml(name)}`,
      `${t(language, "username")}${separator}${username}`
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

async function sendAdminReplyHint(message, env, key) {
  const text = t(env.BOT_LANGUAGE, key);
  try {
    await telegram(env, "sendMessage", {
      chat_id: message.chat.id,
      message_thread_id: message.message_thread_id,
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      text
    });
  } catch (error) {
    if (isRetryableError(error) || String(message.chat.id) !== String(env.ADMIN_GROUP_ID)
      || String(message.from?.id) !== String(env.ADMIN_USER_ID)) throw error;
    await telegram(env, "sendMessage", { chat_id: env.ADMIN_USER_ID, text });
  }
}

async function notifyStoppedUpdate(update, env) {
  const message = update.message || update.edited_message;
  if (!message?.chat || !message.from || message.from.is_bot) return;
  const adminTopic = String(message.chat.id) === String(env.ADMIN_GROUP_ID)
    && String(message.from.id) === String(env.ADMIN_USER_ID) && message.chat.is_forum;
  if (message.chat.type !== "private" && !adminTopic) return;
  if (message.chat.type === "private" && String(message.from.id) !== String(env.ADMIN_USER_ID)) {
    const user = await getUser(env.BOT_DB, String(message.from.id)).catch(() => null);
    env = { ...env, BOT_LANGUAGE: user?.language || env.BOT_LANGUAGE };
  }
  await sendAdminReplyHint(message, env, "retryStopped").catch((error) => {
    console.log(JSON.stringify({ event: "retry_notice_failed", error: sanitizeError(error) }));
  });
}

async function sendRateLimitNotice(chatId, env) {
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: userText(env, "rateLimit", "RATE_LIMIT_MESSAGE")
  });
}

async function notifyUserCopyFailure(chatId, error, env) {
  if (error instanceof ObsoleteWorkError || isRetryableError(error) || isTopicMissing(error)) return;
  await telegram(env, "sendMessage", {
    chat_id: chatId,
    text: userText(env, "unsupportedMessage", "UNSUPPORTED_MESSAGE")
  }).catch(() => {});
}

async function notifyAdminDeliveryFailure(message, error, env) {
  if (error instanceof ObsoleteWorkError || isRetryableError(error)) return;
  await telegram(env, "sendMessage", {
    chat_id: message.chat.id,
    message_thread_id: message.message_thread_id,
    text: t(env.BOT_LANGUAGE, "deliveryFailed")
  }).catch(() => {});
}

async function notifyMediaFailure(group, error, env) {
  if (error instanceof ObsoleteWorkError || isRetryableError(error)) return;
  const user = await getUser(env.BOT_DB, group.user_id).catch(() => null);
  if (group.direction === "user_to_admin") {
    await notifyUserCopyFailure(group.source_chat_id, error, { ...env, _userLanguage: user?.language || env.BOT_LANGUAGE });
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

class ObsoleteWorkError extends NonRetryableError {
  constructor() { super("使用者資料或處理租約已變更，取消舊工作"); }
}

async function telegram(env, method, payload) {
  let response;
  let data;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    try {
      response = await fetch(`${TELEGRAM_API}/bot${env.BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      throw new RetryableError(`Telegram ${method} 網路錯誤：${sanitizeError(error)}`);
    }
    try {
      data = await response.json();
    } catch {
      throw new RetryableError(`Telegram ${method} 回應讀取失敗（HTTP ${response.status}）`);
    }
  } finally {
    clearTimeout(timeoutId);
  }
  if (!data || typeof data !== "object") throw new RetryableError(`Telegram ${method} 回應格式無效`);
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

async function telegramToTopic(env, method, payload, user) {
  try {
    return await telegram(env, method, payload);
  } catch (error) {
    if (!payload.message_thread_id || !String(error.message).toLowerCase().includes("topic_closed")) throw error;
    await requireCurrentUser(env.BOT_DB, user, true);
    try {
      await telegram(env, "reopenForumTopic", {
        chat_id: payload.chat_id,
        message_thread_id: payload.message_thread_id
      });
    } catch (reopenError) {
      if (!/topic_not_modified|topic is not modified/i.test(String(reopenError.message))) throw reopenError;
    }
    return telegram(env, method, payload);
  }
}

async function claimUpdate(db, updateId) {
  const now = Math.floor(Date.now() / 1000);
  const token = crypto.randomUUID();
  const inserted = await db.prepare(`
    INSERT OR IGNORE INTO processed_updates(
      update_id, processed_at, status, attempts, updated_at, lease_token
    ) VALUES (?, ?, 'processing', 1, ?, ?)
  `).bind(updateId, now, now, token).run();
  if (Number(inserted.meta?.changes || 0) === 1) return { status: "accepted", token };
  const reclaimed = await db.prepare(`
    UPDATE processed_updates
    SET status = 'processing', attempts = attempts + 1, updated_at = ?, last_error = NULL, lease_token = ?
    WHERE update_id = ? AND (
      (status = 'failed' AND attempts < ?)
      OR (status = 'processing' AND updated_at <= ? AND attempts < ?)
    )
  `).bind(
    now,
    token,
    updateId,
    MAX_UPDATE_ATTEMPTS,
    now - UPDATE_LEASE_SECONDS,
    MAX_UPDATE_ATTEMPTS
  ).run();
  if (Number(reclaimed.meta?.changes || 0) === 1) return { status: "accepted", token };
  const current = await db.prepare(
    "SELECT status, attempts, updated_at, lease_token FROM processed_updates WHERE update_id = ?"
  ).bind(updateId).first();
  if (
    current
    && Number(current.attempts) >= MAX_UPDATE_ATTEMPTS
    && (current.status === "failed" || (current.status === "processing" && current.updated_at <= now - UPDATE_LEASE_SECONDS))
  ) {
    const discarded = await db.prepare(`
      UPDATE processed_updates SET status = 'discarded', updated_at = ?
      WHERE update_id = ? AND attempts >= ? AND updated_at = ? AND status = ? AND lease_token IS ?
    `).bind(now, updateId, MAX_UPDATE_ATTEMPTS, current.updated_at, current.status, current.lease_token).run();
    if (Number(discarded.meta?.changes || 0) !== 1) return { status: "busy" };
    console.log(JSON.stringify({ event: "update_retry_exhausted", update_id: updateId }));
    return { status: "exhausted" };
  }
  return { status: current?.status === "processing" ? "busy" : "duplicate" };
}

async function finishUpdate(db, updateId, token) {
  return db.prepare(`
    UPDATE processed_updates SET status = 'done', updated_at = ?, last_error = NULL
    WHERE update_id = ? AND lease_token = ? AND status = 'processing'
  `).bind(Math.floor(Date.now() / 1000), updateId, token).run();
}

async function recordUpdateFailure(db, updateId, retryable, error, token) {
  const result = await db.prepare(`
    UPDATE processed_updates SET
      status = CASE
        WHEN ? = 1 AND attempts >= ? THEN 'discarded'
        ELSE ?
      END,
      updated_at = ?,
      last_error = ?
    WHERE update_id = ? AND lease_token = ? AND status = 'processing'
  `).bind(
    retryable ? 1 : 0,
    MAX_UPDATE_ATTEMPTS,
    retryable ? "failed" : "discarded",
    Math.floor(Date.now() / 1000),
    sanitizeError(error),
    updateId,
    token || ""
  ).run();
  const stored = await db.prepare(
    "SELECT status FROM processed_updates WHERE update_id = ?"
  ).bind(updateId).first();
  return { status: stored?.status || null,
    terminal: Number(result.meta?.changes || 0) === 1 && stored?.status === "discarded" };
}

async function getUser(db, userId) {
  return db.prepare("SELECT * FROM users WHERE user_id = ?").bind(userId).first();
}

async function getUserByTopic(db, topicId) {
  return db.prepare("SELECT * FROM users WHERE topic_id = ?").bind(topicId).first();
}

async function upsertUser(db, from, now, messageId) {
  const userId = String(from.id);
  await db.prepare(`
    INSERT INTO users(user_id, username, first_name, last_name, created_at, updated_at, last_message_at, captcha_verified)
    VALUES (?, ?, ?, ?, ?, ?, 0, 1)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username,
      first_name = excluded.first_name,
      last_name = excluded.last_name,
      updated_at = excluded.updated_at,
      captcha_verified = 1,
      erased = 0
    WHERE users.forgotten_message_id < ? AND users.blocked = 0
  `).bind(
    userId,
    from.username || null,
    from.first_name || "",
    from.last_name || "",
    now,
    now,
    messageId
  ).run();
  return getUser(db, userId);
}

async function claimRateSlot(db, user, now, interval, rateKey) {
  await requireCurrentUser(db, user, true);
  const admitted = await db.prepare(`
    SELECT 1 AS ok FROM rate_admissions WHERE user_id = ? AND generation = ? AND rate_key = ?
  `).bind(user.user_id, user.generation, rateKey).first();
  if (admitted) return true;
  const results = await db.batch([
    db.prepare(`
      UPDATE users SET last_message_at = ?, last_rate_key = ?, updated_at = ?
      WHERE user_id = ? AND generation = ? AND erased = 0 AND blocked = 0
        AND (last_rate_key = ? OR last_message_at <= ?)
    `).bind(now, rateKey, now, user.user_id, user.generation, rateKey, now - interval),
    db.prepare(`
      INSERT OR IGNORE INTO rate_admissions(user_id, generation, rate_key, created_at)
      SELECT user_id, generation, ?, ? FROM users
      WHERE user_id = ? AND generation = ? AND erased = 0 AND blocked = 0 AND last_rate_key = ?
    `).bind(rateKey, now, user.user_id, user.generation, rateKey)
  ]);
  return Number(results[0].meta?.changes || 0) === 1 || Number(results[1].meta?.changes || 0) === 1;
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

async function requireCurrentUser(db, user, checkBlocked = false) {
  const current = await getUser(db, user.user_id);
  if (!current || current.erased || current.generation !== user.generation || (checkBlocked && current.blocked)) {
    throw new ObsoleteWorkError();
  }
}

function saveCopiedMessage(env, user, message, copied, targetChatId, now) {
  return saveCopiedMappings(env, user, [{
    sourceChatId: String(message.chat.id),
    sourceMessageId: message.message_id,
    targetChatId: String(targetChatId),
    targetMessageId: copied.message_id,
    userId: user.user_id,
    now
  }]);
}

async function saveCopiedMappings(env, user, values) {
  let failure;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const results = await env.BOT_DB.batch(values.map((item) => env.BOT_DB.prepare(`
        INSERT OR REPLACE INTO message_map(
          source_chat_id, source_message_id, target_chat_id, target_message_id, user_id, created_at
        ) SELECT ?, ?, ?, ?, ?, ? FROM users
          WHERE user_id = ? AND generation = ? AND erased = 0 AND blocked = ?
            AND (? = 0 OR EXISTS (SELECT 1 FROM processed_updates WHERE update_id = ?
              AND lease_token = ? AND status = 'processing'))
            AND (? = 0 OR EXISTS (SELECT 1 FROM media_groups WHERE source_chat_id = ?
              AND media_group_id = ? AND lease_token = ? AND state = 'processing'))
      `).bind(item.sourceChatId, item.sourceMessageId, item.targetChatId, item.targetMessageId,
        item.userId, item.now, user.user_id, user.generation, user.blocked,
        env._updateLease ? 1 : 0, env._updateLease?.id ?? 0, env._updateLease?.token ?? "",
        env._albumLease ? 1 : 0, env._albumLease?.sourceChatId ?? "",
        env._albumLease?.mediaGroupId ?? "", env._albumLease?.token ?? "")));
      if (results.some((result) => Number(result.meta?.changes || 0) !== 1)) throw new ObsoleteWorkError();
      return;
    } catch (error) {
      failure = error;
      if (error instanceof ObsoleteWorkError) break;
      if (attempt < 2) await delay(100 * (attempt + 1));
    }
  }
  const reverted = await rollbackCopiedMessages(values[0].targetChatId,
    values.map((item) => ({ message_id: item.targetMessageId })), env);
  if (!reverted) {
    await telegram(env, "sendMessage", {
      chat_id: values[0].sourceChatId,
      message_thread_id: String(values[0].sourceChatId) === String(env.ADMIN_GROUP_ID) ? user.topic_id : undefined,
      text: String(values[0].sourceChatId) === String(user.user_id)
        ? t(user.language || env.BOT_LANGUAGE, "untrackedDelivery") : t(env.BOT_LANGUAGE, "untrackedDelivery")
    }).catch(() => {});
    throw new NonRetryableError("已轉送但保存對照與撤回均失敗，停止重送以避免重複");
  }
  throw failure;
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
    db.prepare("DELETE FROM media_groups WHERE created_at < ?").bind(now - 2 * 86400),
    db.prepare("DELETE FROM rate_admissions WHERE created_at < ?").bind(now - 2 * 86400),
    db.prepare(`DELETE FROM users WHERE blocked = 0 AND
      ((erased = 1 AND forgotten_at < ?) OR (captcha_verified = 0 AND updated_at < ? AND forgotten_at < ?))
    `).bind(now - 7 * 86400, now - 7 * 86400, now - 7 * 86400)
  ]);
}

async function readiness(env) {
  if (configurationIssue(env)) {
    return json({ ok: false, service: "telegram-private-relay" }, { status: 503 });
  }
  try {
    const schema = await env.BOT_DB.prepare(`
      SELECT (SELECT generation FROM users LIMIT 1) AS generation,
        (SELECT forgotten_message_id FROM users LIMIT 1) AS forgotten_message_id,
        (SELECT captcha_verified + captcha_until + captcha_attempts + captcha_last_at + captcha_message_id
          + COALESCE(captcha_code, 0) FROM users LIMIT 1) AS captcha,
        (SELECT captcha_pending_group FROM users LIMIT 1) AS captcha_pending,
        (SELECT language FROM users WHERE language_message_id >= 0 LIMIT 1) AS user_language,
        (SELECT lease_token FROM processed_updates LIMIT 1) AS update_lease,
        (SELECT user_generation FROM media_groups LIMIT 1) AS album_generation,
        (SELECT lease_token FROM media_groups LIMIT 1) AS album_lease,
        (SELECT COUNT(*) FROM rate_admissions WHERE 0) AS admissions,
        (SELECT COUNT(*) FROM bot_settings WHERE id = 1 AND (captcha_enabled IS NULL OR captcha_enabled IN (0, 1))
          AND captcha_message_id >= 0) AS captcha_settings
    `).first();
    if (schema?.captcha_settings !== 1) throw new Error("驗證開關設定遺失");
    return json({ ok: true, service: "telegram-private-relay" });
  } catch {
    return json({ ok: false, service: "telegram-private-relay" }, { status: 503 });
  }
}

export function configurationIssue(env) {
  if (!env?.BOT_DB || typeof env.BOT_DB.prepare !== "function") return "BOT_DB";
  if (typeof env.BOT_TOKEN !== "string" || !env.BOT_TOKEN.trim()) return "BOT_TOKEN";
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(String(env.WEBHOOK_SECRET || ""))) return "WEBHOOK_SECRET";
  if (!/^\d+$/.test(String(env.ADMIN_USER_ID || ""))) return "ADMIN_USER_ID";
  if (env.ADMIN_GROUP_ID != null && String(env.ADMIN_GROUP_ID) !== "") {
    if (!/^-100\d+$/.test(String(env.ADMIN_GROUP_ID))) return "ADMIN_GROUP_ID";
  }
  if (env.BOT_LANGUAGE != null && !["zh", "ja", "en"].includes(env.BOT_LANGUAGE)) return "BOT_LANGUAGE";
  if (env.CAPTCHA_ENABLED != null && !["true", "false"].includes(env.CAPTCHA_ENABLED)) return "CAPTCHA_ENABLED";
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

async function commandIsForBot(text, env) {
  if (!parseCommand(text)) return true;
  const token = text.trim().split(/\s+/, 1)[0];
  if (!token.includes("@")) return true;
  const addressedTo = token.slice(token.indexOf("@") + 1);
  if (!/^[A-Za-z0-9_]+$/.test(addressedTo)) return false;
  if (!botIdentity || botIdentity.token !== env.BOT_TOKEN) {
    const me = await telegram(env, "getMe", {});
    if (!me?.username) throw new RetryableError("無法確認 Bot 的指令名稱");
    botIdentity = { token: env.BOT_TOKEN, username: me.username.toLowerCase() };
  }
  return addressedTo.toLowerCase() === botIdentity.username;
}

export function buildTopicName(from, language) {
  const displayName = safeIdentityText([from.first_name, from.last_name].filter(Boolean).join(" "));
  const identity = from.username ? `@${safeIdentityText(from.username)}` : String(from.id);
  return truncate(`${displayName || t(language, "user")} · ${identity}`, MAX_TOPIC_LENGTH);
}

export function buildUserCard(from, language) {
  const fullName = safeIdentityText([from.first_name, from.last_name].filter(Boolean).join(" ")) || t(language, "notProvided");
  const username = from.username ? `@${escapeHtml(safeIdentityText(from.username))}` : t(language, "notSet");
  const separator = t(language, "fieldSeparator");
  return [
    `<b>${t(language, "newChat")}</b>`,
    `User ID${separator}<code>${escapeHtml(String(from.id))}</code>`,
    `${t(language, "name")}${separator}${escapeHtml(fullName)}`,
    `${t(language, "username")}${separator}${username}`
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
  return message.includes("message thread not found");
}

function sanitizeError(error) {
  const code = error instanceof TelegramApiError ? `${error.errorCode} ` : "";
  return (code + String(error?.message || error || "unknown error"))
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

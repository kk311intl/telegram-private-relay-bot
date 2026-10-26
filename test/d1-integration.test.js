import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { captchaQuestion, processUpdate } from "../src/index.js";
import { t } from "../src/i18n.js";

class BoundStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
    this.values = [];
  }

  bind(...values) {
    this.values = values;
    return this;
  }

  runSync() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async run() { return this.runSync(); }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  async all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.values) };
  }
}

class TestD1 {
  constructor(migrationLimit = Infinity) {
    this.database = new DatabaseSync(":memory:");
    const migrationsUrl = new URL("../migrations/", import.meta.url);
    for (const migration of readdirSync(migrationsUrl).filter((name) => name.endsWith(".sql")).sort().slice(0, migrationLimit)) {
      this.database.exec(readFileSync(new URL(migration, migrationsUrl), "utf8"));
    }
  }

  prepare(sql) {
    return new BoundStatement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(statement.runSync());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}

function userMessage(messageId, extra = {}) {
  return {
    message_id: messageId,
    chat: { id: 2, type: "private" },
    from: { id: 2, is_bot: false, first_name: "測試者" },
    ...extra
  };
}

function adminMessage(messageId, text, extra = {}) {
  return { message_id: messageId, text, chat: { id: 1, type: "private" },
    from: { id: 1, is_bot: false }, ...extra };
}

function telegramResponse(result, status = 200, description = "mock failure") {
  return new Response(JSON.stringify(status === 200
    ? { ok: true, result }
    : { ok: false, error_code: status, description }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

async function withDatabaseMock(run) {
  const db = new TestD1();
  const originals = { fetch: globalThis.fetch, now: Date.now, timeout: globalThis.setTimeout };
  try { await run(db); }
  finally {
    globalThis.fetch = originals.fetch;
    Date.now = originals.now;
    globalThis.setTimeout = originals.timeout;
    db.close();
  }
}

function injectWriteFailure(db, matches, times = 1) {
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    const run = statement.runSync.bind(statement);
    statement.runSync = () => {
      if (times > 0 && matches(sql)) { times--; throw new Error("temporary D1 failure"); }
      return run();
    };
    return statement;
  };
}

function auditEnv(db, topic = true) {
  return { BOT_DB: db, CAPTCHA_ENABLED: "false", BOT_TOKEN: "test-token", WEBHOOK_SECRET: "test-secret", ADMIN_USER_ID: "1",
    ...(topic ? { ADMIN_GROUP_ID: "-1001" } : {}) };
}

function auditRequest(id, message) {
  return new Request("https://example.com/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
    body: JSON.stringify({ update_id: id, message })
  });
}

function seedAuditUser(db) {
  db.database.exec("INSERT INTO users(user_id,first_name,topic_id,topic_card_message_id,created_at,updated_at) VALUES ('2','Test',72,0,1,1)");
}

function languageCallback(messageId, data, extra = {}) {
  return { callback_query: { id: `callback-${messageId}`, from: { id: 2, is_bot: false }, data,
    message: { message_id: messageId, chat: { id: 2, type: "private" } }, ...extra } };
}

test("三語按鈕保存用戶偏好，歡迎與指令跟隨選擇，管理端維持部署語言", async () => {
  for (const language of ["zh", "en", "ja"]) await withDatabaseMock(async (db) => {
    const calls = [], env = { ...auditEnv(db), WELCOME_MESSAGE: "自訂歡迎" };
    globalThis.fetch = async (url, init) => {
      calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
      return telegramResponse({ message_id: 11 });
    };
    await processUpdate({ message: userMessage(10, { text: "/start" }) }, env);
    const welcome = calls.find((call) => call.method === "sendMessage").payload;
    assert.equal(welcome.text, "自訂歡迎");
    const buttons = welcome.reply_markup.inline_keyboard[0];
    assert.deepEqual(buttons.map((button) => button.text), ["中文", "English", "日本語"]);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM users").first()).n, 0);
    const data = buttons.find((button) => button.callback_data.startsWith(`lang:${language}:`)).callback_data;
    await processUpdate(languageCallback(11, data), env);
    const user = await db.prepare("SELECT * FROM users WHERE user_id = '2'").first();
    assert.equal(user.language, language);
    assert.equal(user.captcha_verified, 0);
    assert.equal(user.first_name, "");
    const menu = calls.find((call) => call.method === "setMyCommands").payload;
    assert.deepEqual(menu.scope, { type: "chat", chat_id: 2 });
    assert.deepEqual(menu.commands.map((command) => command.command), ["start", "help", "language", "id", "forget"]);
    assert.equal(menu.commands.find((command) => command.command === "help").description, t(language, "userCommand_help"));
    assert.ok(calls.some((call) => call.method === "answerCallbackQuery"));
    assert.deepEqual(calls.at(-1).payload.reply_markup, { inline_keyboard: [] });
    await processUpdate({ message: userMessage(12, { text: "/help" }) }, { ...env });
    assert.equal(calls.at(-1).payload.text, t(language, "userHelp"));
    await processUpdate({ message: userMessage(13, { text: "/start", from: { id: 2, is_bot: false, language_code: "fr" } }) }, { ...env });
    assert.equal(calls.at(-1).payload.text, language === "zh" ? "自訂歡迎" : t(language, "welcome"));
    await processUpdate({ message: userMessage(14, { text: "/id" }) }, env);
    assert.equal(calls.at(-1).payload.text, t(language, "userId") + t(language, "fieldSeparator") + "2");
    await processUpdate({ message: adminMessage(15, "/help") }, env);
    assert.equal(calls.at(-1).payload.text, t("zh", "adminHelpTopic"));
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM message_map").first()).n, 0);
  });
});

test("語言指令在驗證前可用，切換不重置題目、不免驗也不轉送指令", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: "true" }, calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push({ method, payload: JSON.parse(init.body) });
    return telegramResponse(method === "createForumTopic" ? { message_thread_id: 72 }
      : method === "copyMessages" ? [{ message_id: 700 }] : { message_id: 701 });
  };
  await processUpdate({ message: userMessage(10, { text: "/language en" }) }, env);
  await processUpdate({ message: userMessage(11, { text: "first contact" }) }, env);
  assert.ok(calls.at(-1).payload.text.startsWith(t("en", "captchaPrompt").split("{question}")[0]));
  const before = await db.prepare("SELECT * FROM users WHERE user_id = '2'").first();
  await processUpdate({ message: userMessage(12, { text: "/language ja" }) }, env);
  const after = await db.prepare("SELECT * FROM users WHERE user_id = '2'").first();
  for (const key of ["captcha_code", "captcha_until", "captcha_attempts", "captcha_pending_group", "captcha_message_id", "captcha_verified"]) {
    assert.equal(after[key], before[key], key);
  }
  assert.equal(calls.filter((call) => call.method.startsWith("copy")).length, 0);
  await processUpdate({ message: userMessage(13, { text: String(captchaQuestion(before.captcha_code).answer) }) }, env);
  assert.equal(calls.at(-1).payload.text, t("ja", "captchaPassed"));
  assert.deepEqual(calls.find((call) => call.method === "copyMessages").payload.message_ids, [11]);
  assert.ok(calls.some((call) => call.payload.text?.startsWith(`<b>${t("zh", "newChat")}</b>`)));
}));

test("語言按鈕只影響點選者的私訊，無效語言、管理者、群組與跨用戶回調不觸碰資料", async () => {
  const env = { ...auditEnv({ prepare() { throw new Error("must not access data"); } }) };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(String(url).endsWith("/answerCallbackQuery"));
    return telegramResponse(true);
  };
  try {
    for (const update of [
      languageCallback(11, "lang:fr:0:10"), languageCallback(11, "lang:en:0:10:extra"),
      languageCallback(11, "lang:en:0:0"), languageCallback(11, "lang:en:0:12"),
      languageCallback(11, "lang:en:99999999999999999999:10"),
      languageCallback(11, "lang:en:0:10", { from: { id: 3 } }),
      languageCallback(11, "lang:en:0:10", { from: { id: 2, is_bot: true } }),
      languageCallback(11, "lang:en:0:10", { message: undefined }),
      languageCallback(11, "lang:en:0:10", { message: { message_id: 11, chat: { id: 2, type: "group" } } }),
      languageCallback(11, "lang:en:0:10", { from: { id: 1 }, message: { message_id: 11, chat: { id: 1, type: "private" } } })
    ]) await processUpdate(update, env);
  } finally { globalThis.fetch = originalFetch; }
});

test("清除資料同時清除語言和個別選單，舊按鈕與舊指令不能恢復偏好", () => withDatabaseMock(async (db) => {
  const calls = [], env = auditEnv(db);
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
    return telegramResponse({ message_id: 11 });
  };
  await processUpdate(languageCallback(11, "lang:en:0:10"), env);
  await processUpdate({ message: userMessage(20, { text: "/forget confirm" }) }, env);
  assert.equal(calls.at(-1).payload.text, t("en", "forgetDone"));
  assert.deepEqual(calls.find((call) => call.method === "deleteMyCommands").payload.scope, { type: "chat", chat_id: 2 });
  await processUpdate(languageCallback(11, "lang:en:0:10"), env);
  await processUpdate(languageCallback(30, "lang:ja:0:10"), env);
  await processUpdate({ message: userMessage(15, { text: "/language en" }) }, env);
  let user = await db.prepare("SELECT * FROM users WHERE user_id = '2'").first();
  assert.equal(user.language, null);
  assert.equal(user.erased, 1);
  await processUpdate({ message: userMessage(31, { text: "/language" }) }, env);
  const data = calls.at(-1).payload.reply_markup.inline_keyboard[0].find((button) => button.text === "日本語").callback_data;
  await processUpdate(languageCallback(32, data), env);
  user = await db.prepare("SELECT * FROM users WHERE user_id = '2'").first();
  assert.equal(user.language, "ja");
  assert.equal(user.captcha_verified, 0);
  assert.equal(user.erased, 0);
}));

test("語言寫入和清除併發時，舊選擇不能重新建立資料", () => withDatabaseMock(async (db) => {
  const env = auditEnv(db), prepare = db.prepare.bind(db);
  globalThis.fetch = async () => telegramResponse(true);
  db.prepare = (sql) => {
    const statement = prepare(sql);
    if (sql.includes("INSERT INTO users(user_id, created_at, updated_at, language")) {
      const run = statement.run.bind(statement);
      statement.run = async () => {
        await processUpdate({ message: userMessage(20, { text: "/forget confirm" }) }, env);
        return run();
      };
    }
    return statement;
  };
  await processUpdate(languageCallback(11, "lang:en:0:10"), env);
  const user = await prepare("SELECT * FROM users WHERE user_id = '2'").first();
  assert.equal(user.language, null);
  assert.equal(user.erased, 1);
  assert.equal(user.generation, 1);
}));

test("語言通知失敗後可重試，舊回調不能覆蓋較新選擇，同一鍵盤只選一次", () => withDatabaseMock(async (db) => {
  const env = auditEnv(db), menus = [];
  let fail = true;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop(), payload = JSON.parse(init.body);
    if (method === "setMyCommands") menus.push(payload);
    if (method === "sendMessage" && fail) { fail = false; return telegramResponse(null, 503); }
    return telegramResponse(true);
  };
  const request = () => new Request("https://example.com/webhook", {
    method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "test-secret" },
    body: JSON.stringify({ update_id: 9400, ...languageCallback(11, "lang:en:0:10") })
  });
  assert.equal((await worker.fetch(request(), env)).status, 500);
  await processUpdate(languageCallback(11, "lang:ja:0:10"), env);
  assert.equal((await db.prepare("SELECT language FROM users WHERE user_id = '2'").first()).language, "en");
  await processUpdate({ message: userMessage(30, { text: "/language ja" }) }, env);
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal((await db.prepare("SELECT language FROM users WHERE user_id = '2'").first()).language, "ja");
  assert.equal(menus.length, 2);
  assert.equal(menus.at(-1).commands[0].description, t("ja", "userCommand_start"));
}));

test("用戶錯誤提示跟隨語言，自訂提示只覆蓋部署語言，封鎖不會被切語言解除", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  db.database.exec("UPDATE users SET language = 'en', captcha_verified = 1");
  const env = { ...auditEnv(db), BLOCKED_MESSAGE: "自訂封鎖", RATE_LIMIT_MESSAGE: "自訂限流", UNSUPPORTED_MESSAGE: "自訂類型", MESSAGE_INTERVAL_SECONDS: "60" }, calls = [];
  let failCopy = false;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push({ method, payload: JSON.parse(init.body) });
    return failCopy && method === "copyMessage" ? telegramResponse(null, 400) : telegramResponse({ message_id: 700 });
  };
  await processUpdate({ message: userMessage(10, { text: "hello" }) }, env);
  await processUpdate({ message: userMessage(11, { text: "hello again" }) }, env);
  assert.equal(calls.at(-1).payload.text, t("en", "rateLimit"));
  db.database.exec("UPDATE users SET blocked = 1");
  await processUpdate({ message: userMessage(12, { text: "blocked" }) }, env);
  assert.equal(calls.at(-1).payload.text, t("en", "blockedNotice"));
  await processUpdate({ message: userMessage(13, { text: "/language ja" }) }, env);
  assert.equal((await db.prepare("SELECT blocked FROM users").first()).blocked, 1);
  db.database.exec("UPDATE users SET blocked = 0, last_message_at = 0, language = 'en'");
  failCopy = true;
  await assert.rejects(processUpdate({ message: userMessage(14, { text: "unsupported" }) }, env));
  assert.equal(calls.at(-1).payload.text, t("en", "unsupportedMessage"));
  assert.equal(calls.find((call) => call.method === "copyMessage").payload.message_id, 10);
  assert.equal(calls.some((call) => call.payload.chat_id === "1"), false);
}));

test("管理者更新選單時補訂閱語言回調，保留 Webhook URL、更新類型及待處理訊息", () => withDatabaseMock(async (db) => {
  const calls = [], webhook = { url: "https://example.test/webhook", allowed_updates: ["message", "edited_message"], max_connections: 10 };
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push({ method, payload: JSON.parse(init.body) });
    return telegramResponse(method === "getWebhookInfo" ? webhook : true);
  };
  const env = { ...auditEnv(db), BOT_TOKEN: "admin-callback-subscription-test" };
  await processUpdate({ message: adminMessage(10, "/start") }, env);
  assert.deepEqual(calls.find((call) => call.method === "setWebhook").payload, {
    url: webhook.url, secret_token: env.WEBHOOK_SECRET, allowed_updates: ["message", "edited_message", "callback_query"],
    max_connections: 10, drop_pending_updates: false
  });
  calls.length = 0;
  webhook.allowed_updates.push("callback_query");
  await processUpdate({ message: adminMessage(11, "/start") }, env);
  assert.equal(calls.some((call) => call.method === "setWebhook"), false);
}));

test("使用者可自行啟用按鈕回調，不依賴管理者先更新選單；先停止等待再保存偏好", () => withDatabaseMock(async (db) => {
  const calls = [], env = { ...auditEnv(db), BOT_TOKEN: "user-callback-subscription-test" };
  const webhook = { url: "https://example.test/webhook", allowed_updates: ["message", "edited_message"], max_connections: 10 };
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop(), payload = JSON.parse(init.body);
    calls.push({ method, payload });
    return telegramResponse(method === "getWebhookInfo" ? webhook : { message_id: 11 });
  };
  await processUpdate({ message: userMessage(10, { text: "/start" }) }, env);
  assert.deepEqual(calls.map((call) => call.method), ["getWebhookInfo", "setWebhook", "sendMessage"]);
  const choice = calls.at(-1).payload.reply_markup.inline_keyboard[0][1].callback_data;
  calls.length = 0;
  await processUpdate(languageCallback(11, choice), env);
  assert.equal(calls[0].method, "answerCallbackQuery");
  assert.equal((await db.prepare("SELECT language FROM users").first()).language, "en");
  calls.length = 0;
  await processUpdate({ message: userMessage(12, { text: "/language" }) }, env);
  assert.deepEqual(calls.map((call) => call.method), ["sendMessage"]);
}));

test("初始化寫入暫時失敗後，相簿可由下一次重試完成", () => withDatabaseMock(async (db) => {
  let copies = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/copyMessages")) { copies++; return telegramResponse([{ message_id: 700 }]); }
    if (String(url).endsWith("/createForumTopic")) return telegramResponse({ message_thread_id: 72 });
    return telegramResponse({ message_id: 701 });
  };
  injectWriteFailure(db, (sql) => /UPDATE media_groups SET state = \?/.test(sql));
  const message = userMessage(10, { text: undefined, media_group_id: "recover-init", photo: [{}] });
  const env = auditEnv(db);
  assert.equal((await worker.fetch(auditRequest(7001, message), env)).status, 500);
  assert.equal((await worker.fetch(auditRequest(7001, message), env)).status, 200);
  assert.equal(copies, 1);
  assert.equal((await db.prepare("SELECT state FROM media_groups").first()).state, "done");
}));

test("第一則訊息為相簿時，Topic 和身分卡仍使用正確 User ID", () => withDatabaseMock(async (db) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push({ method, payload: JSON.parse(init.body) });
    if (method === "createForumTopic") return telegramResponse({ message_thread_id: 72 });
    if (method === "copyMessages") return telegramResponse([{ message_id: 700 }]);
    return telegramResponse({ message_id: 701 });
  };
  await processUpdate({ message: userMessage(10, { text: undefined, media_group_id: "identity", photo: [{}] }) }, auditEnv(db));
  assert.match(calls.find((call) => call.method === "createForumTopic").payload.name, /· 2$/);
  assert.match(calls.find((call) => call.method === "sendMessage").payload.text, /<code>2<\/code>/);
}));

test("清除確認後，先前仍在轉送的訊息不能重建對照", () => withDatabaseMock(async (db) => {
  let releaseCopy, enteredCopy;
  const entered = new Promise((resolve) => { enteredCopy = resolve; });
  const deleted = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    if (method === "copyMessage") {
      enteredCopy();
      await new Promise((resolve) => { releaseCopy = resolve; });
      return telegramResponse({ message_id: 700 });
    }
    if (method === "deleteMessages") deleted.push(...JSON.parse(init.body).message_ids);
    return telegramResponse({ message_id: 701 });
  };
  const env = auditEnv(db, false);
  const inflight = processUpdate({ message: userMessage(10) }, env);
  await entered;
  await processUpdate({ message: userMessage(11, { text: "/forget confirm" }) }, env);
  releaseCopy(); await inflight;
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM message_map").first()).total, 0);
  assert.deepEqual(deleted, [700]);
  assert.equal((await db.prepare("SELECT erased FROM users").first()).erased, 1);
}));

test("清除回覆失敗的重試不會刪掉之後的新資料", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  let failConfirmation = true;
  globalThis.fetch = async (url, init) => {
    const payload = JSON.parse(init.body);
    if (String(url).endsWith("/sendMessage") && payload.text === t("zh", "forgetDone") && failConfirmation) {
      failConfirmation = false; return telegramResponse(false, 503);
    }
    if (String(url).endsWith("/createForumTopic")) return telegramResponse({ message_thread_id: 73 });
    return telegramResponse({ message_id: 700 });
  };
  const env = auditEnv(db), forget = userMessage(20, { text: "/forget confirm" });
  assert.equal((await worker.fetch(auditRequest(7002, forget), env)).status, 500);
  await processUpdate({ message: userMessage(21) }, env);
  assert.equal((await worker.fetch(auditRequest(7002, forget), env)).status, 200);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM message_map").first()).total, 1);
  assert.equal((await db.prepare("SELECT erased FROM users").first()).erased, 0);
}));

test("清除前尚未開始處理的舊訊息不能重建個人資料", () => withDatabaseMock(async (db) => {
  globalThis.fetch = async () => telegramResponse({ message_id: 700 });
  const env = auditEnv(db, false);
  await processUpdate({ message: userMessage(30, { text: "/forget confirm" }) }, env);
  await processUpdate({ message: userMessage(29) }, env);
  const user = await db.prepare("SELECT * FROM users").first();
  assert.equal(user.erased, 1);
  assert.equal(user.first_name, "");
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM message_map").first()).total, 0);
}));

test("已接受的訊息重試不會被較新訊息的節流額度誤攔", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  let now = 1800000000000, fail = true;
  Date.now = () => now;
  const copies = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/copyMessage")) {
      copies.push(JSON.parse(init.body).message_id);
      if (fail) { fail = false; return telegramResponse(false, 503); }
    }
    return telegramResponse({ message_id: 700 + copies.length });
  };
  const env = auditEnv(db);
  assert.equal((await worker.fetch(auditRequest(7003, userMessage(40)), env)).status, 500);
  now += 2000;
  await worker.fetch(auditRequest(7004, userMessage(41)), env);
  assert.equal((await worker.fetch(auditRequest(7003, userMessage(40)), env)).status, 200);
  assert.deepEqual(copies, [40, 41, 40]);
  assert.ok(await db.prepare("SELECT 1 FROM message_map WHERE source_message_id=40").first());
}));

test("保存對照暫時失敗時只重試 D1，不重新轉送", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  let copies = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/copyMessage")) copies++;
    return telegramResponse({ message_id: 700 });
  };
  injectWriteFailure(db, (sql) => /INSERT OR REPLACE INTO message_map/.test(sql));
  assert.equal((await worker.fetch(auditRequest(7005, userMessage(50)), auditEnv(db))).status, 200);
  assert.equal(copies, 1);
  assert.ok(await db.prepare("SELECT 1 FROM message_map WHERE source_message_id=50").first());
}));

test("對照連續失敗會先撤回副本，下一次重試只留一則訊息", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  let copies = 0;
  const removed = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/copyMessage")) return telegramResponse({ message_id: 700 + ++copies });
    if (String(url).endsWith("/deleteMessages")) removed.push(...JSON.parse(init.body).message_ids);
    return telegramResponse(true);
  };
  injectWriteFailure(db, (sql) => /INSERT OR REPLACE INTO message_map/.test(sql), 3);
  const env = auditEnv(db), request = () => auditRequest(7006, userMessage(51));
  assert.equal((await worker.fetch(request(), env)).status, 500);
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal(copies, 2);
  assert.deepEqual(removed, [701]);
  assert.equal((await db.prepare("SELECT target_message_id FROM message_map").first()).target_message_id, 702);
}));

test("相簿已保存對照後狀態寫入失敗，不會整組重送", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  let copies = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/copyMessages")) { copies++; return telegramResponse([{ message_id: 700 }]); }
    return telegramResponse({ message_id: 701 });
  };
  injectWriteFailure(db, (sql) => /UPDATE media_groups SET state = 'done'/.test(sql));
  const env = auditEnv(db), message = userMessage(60, { text: undefined, media_group_id: "recover-done", photo: [{}] });
  assert.equal((await worker.fetch(auditRequest(7007, message), env)).status, 500);
  assert.equal((await worker.fetch(auditRequest(7007, message), env)).status, 200);
  assert.equal(copies, 1);
}));

test("狀態摘要會顯示處理中及逾期租約", () => withDatabaseMock(async (db) => {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT INTO processed_updates(update_id,processed_at,status,attempts,updated_at)
    VALUES (7008,?,'processing',1,?)`).bind(now - 120, now - 120).run();
  let text;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/getWebhookInfo")) return telegramResponse({ pending_update_count: 0 });
    text = JSON.parse(init.body).text; return telegramResponse(true);
  };
  await processUpdate({ message: { message_id: 70, chat: { id: 1, type: "private" },
    from: { id: 1, is_bot: false }, text: "/status" } }, auditEnv(db));
  assert.match(text, /處理中：1/);
  assert.match(text, /處理逾時（計入處理中）：1/);
}));

test("三語身分卡、管理資料、狀態及 ID 提示使用一致標點", async () => {
  for (const language of ["zh", "ja", "en"]) {
    await withDatabaseMock(async (db) => {
      const calls = [];
      globalThis.fetch = async (url, init) => {
        const method = String(url).split("/").pop(), payload = JSON.parse(init.body);
        calls.push({ method, payload });
        if (method === "getWebhookInfo") return telegramResponse({ pending_update_count: 3 });
        return telegramResponse({ message_id: 1000 + calls.length });
      };
      const env = { ...auditEnv(db, false), BOT_LANGUAGE: language };
      const separator = t(language, "fieldSeparator");
      await processUpdate({ message: userMessage(200, { text: "test" }) }, env);
      const header = calls.find((call) => call.method === "sendMessage").payload;
      assert.ok(header.text.includes(`User ID${separator}<code>2</code>`));
      assert.equal(header.parse_mode, "HTML");
      const mapping = await db.prepare("SELECT target_message_id FROM message_map WHERE source_message_id = 200").first();
      const admin = (id, text, extra = {}) => ({ message_id: id, text,
        chat: { id: 1, type: "private" }, from: { id: 1, is_bot: false }, ...extra });
      await processUpdate({ message: admin(201, "/user", {
        reply_to_message: { message_id: mapping.target_message_id }
      }) }, env);
      const details = calls.at(-1).payload.text;
      assert.ok(details.includes(`User ID${separator}<code>2</code>`));
      assert.ok(details.includes(`${t(language, "status")}${separator}${t(language, "normalStatus")}`));
      await processUpdate({ message: admin(202, "/status") }, env);
      const status = calls.at(-1).payload.text;
      assert.ok(status.startsWith(t(language, "adminStatus") + "\n\n"));
      for (const key of ["statusDone", "statusProcessing", "statusStalled", "statusFailed", "statusDiscarded"]) {
        assert.ok(status.includes(`${t(language, key)}${separator}0`));
      }
      assert.ok(status.includes(`${t(language, "statusPending")}${separator}3`));
      await processUpdate({ message: userMessage(203, { text: "/id" }) }, env);
      assert.equal(calls.at(-1).payload.text, `${t(language, "userId")}${separator}2`);
      await processUpdate({ message: admin(204, "/setup", {
        chat: { id: -1001, type: "supergroup", is_forum: true }
      }) }, env);
      assert.equal(calls.at(-1).payload.text, `${t(language, "groupId")}${separator}<code>-1001</code>`);
      if (language === "en") {
        assert.doesNotMatch(header.text, /：/);
        assert.doesNotMatch(details, /：/);
        assert.doesNotMatch(status, /：/);
      }
    });
  }
});

test("發給其他 Bot 的管理指令不執行，給自己的後綴仍可用", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  globalThis.fetch = async (url) => telegramResponse(String(url).endsWith("/getMe") ? { username: "ThisRelayBot" } : true);
  const env = { ...auditEnv(db), BOT_TOKEN: "test-command-token" };
  const message = { message_id: 80, chat: { id: -1001, type: "supergroup", is_forum: true },
    from: { id: 1, is_bot: false }, message_thread_id: 72, text: "/block@AnotherBot" };
  await processUpdate({ message }, env);
  assert.equal((await db.prepare("SELECT blocked FROM users").first()).blocked, 0);
  await processUpdate({ message: { ...message, text: "/block@AnotherBot!" } }, env);
  assert.equal((await db.prepare("SELECT blocked FROM users").first()).blocked, 0);
  await processUpdate({ message: { ...message, text: "/block@ThisRelayBot" } }, env);
  assert.equal((await db.prepare("SELECT blocked FROM users").first()).blocked, 1);
}));

test("清空或移除媒體 caption 都會同步空字串", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  db.database.exec("INSERT INTO message_map VALUES ('2',90,'-1001',700,'2',1)");
  const captions = [];
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).endsWith("/editMessageCaption"));
    captions.push(JSON.parse(init.body).caption); return telegramResponse(true);
  };
  for (const caption of ["", undefined]) await processUpdate({ edited_message: userMessage(90,
    { text: undefined, caption, photo: [{}] }) }, auditEnv(db));
  assert.deepEqual(captions, ["", ""]);
}));

test("Telegram 逾時限制涵蓋 HTTP 回應本文", () => withDatabaseMock(async (db) => {
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => realTimeout(callback, delay === 15000 ? 10 : delay, ...args);
  let signal;
  globalThis.fetch = async (_url, init) => {
    signal = init.signal;
    return { ok: true, status: 200, json: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("body aborted")), { once: true });
    }) };
  };
  await assert.rejects(processUpdate({ message: userMessage(100, { text: "/start" }) }, auditEnv(db)), /回應讀取失敗/);
  assert.equal(signal.aborted, true);
}));

test("第五次工作租約仍有效時，重複更新不得提前放棄", () => withDatabaseMock(async (db) => {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT INTO processed_updates(update_id,processed_at,status,attempts,updated_at,lease_token)
    VALUES (7009,?,'processing',5,?,'active')`).bind(now, now).run();
  assert.equal((await worker.fetch(auditRequest(7009, userMessage(110)), auditEnv(db))).status, 500);
  assert.equal((await db.prepare("SELECT status FROM processed_updates").first()).status, "processing");
}));

test("七天後清理非封鎖清除控制紀錄，保留封鎖紀錄與重新建立的資料", () => withDatabaseMock(async (db) => {
  const old = Math.floor(Date.now() / 1000) - 8 * 86400;
  await db.prepare(`INSERT INTO users(user_id,blocked,erased,forgotten_at,created_at,updated_at)
    VALUES ('2',0,1,?,?,?),('3',1,1,?,?,?),('4',0,0,?,?,?)`)
    .bind(old, old, old, old, old, old, old, old, old).run();
  await db.prepare("UPDATE users SET captcha_verified=1 WHERE user_id='4'").run();
  let cleanup;
  await worker.scheduled({}, auditEnv(db), { waitUntil(promise) { cleanup = promise; } });
  await cleanup;
  assert.equal(await db.prepare("SELECT * FROM users WHERE user_id='2'").first(), null);
  assert.ok(await db.prepare("SELECT * FROM users WHERE user_id='3'").first());
  assert.ok(await db.prepare("SELECT * FROM users WHERE user_id='4'").first());
}));

test("失去更新租約的舊工作會撤回自己的副本，不能覆寫新對照", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  let now = 1800000000000, copies = 0, releaseCopy, enteredCopy;
  Date.now = () => now;
  const entered = new Promise((resolve) => { enteredCopy = resolve; });
  const removed = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/copyMessage")) {
      const id = 700 + ++copies;
      if (copies === 1) { enteredCopy(); await new Promise((resolve) => { releaseCopy = resolve; }); }
      return telegramResponse({ message_id: id });
    }
    if (String(url).endsWith("/deleteMessages")) removed.push(...JSON.parse(init.body).message_ids);
    return telegramResponse(true);
  };
  const env = auditEnv(db), request = () => auditRequest(7010, userMessage(120));
  const old = worker.fetch(request(), env);
  await entered;
  now += 61000;
  assert.equal((await worker.fetch(request(), env)).status, 200);
  releaseCopy();
  assert.equal((await old).status, 200);
  assert.deepEqual(removed, [701]);
  assert.equal((await db.prepare("SELECT target_message_id FROM message_map").first()).target_message_id, 702);
  assert.equal((await db.prepare("SELECT status FROM processed_updates").first()).status, "done");
}));

test("失去相簿租約的舊工作不能覆寫接手者的對照或狀態", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  const realNow = Date.now;
  let offset = 0, copies = 0, releaseCopy, enteredCopy;
  Date.now = () => realNow() + offset;
  const entered = new Promise((resolve) => { enteredCopy = resolve; });
  const removed = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/copyMessages")) {
      const messageIds = JSON.parse(init.body).message_ids;
      const first = ++copies === 1;
      if (first) { enteredCopy(); await new Promise((resolve) => { releaseCopy = resolve; }); }
      return telegramResponse(messageIds.map((_id, index) => ({ message_id: first ? 701 : 702 + index })));
    }
    if (String(url).endsWith("/deleteMessages")) removed.push(...JSON.parse(init.body).message_ids);
    return telegramResponse(true);
  };
  const env = auditEnv(db);
  const photo = (id) => userMessage(id, { text: undefined, media_group_id: "reclaimed-album", photo: [{}] });
  const old = worker.fetch(auditRequest(7012, photo(130)), env);
  await entered;
  offset += 61000;
  assert.equal((await worker.fetch(auditRequest(7013, photo(131)), env)).status, 200);
  releaseCopy(); await old;
  assert.deepEqual(removed, [701]);
  const mappings = (await db.prepare("SELECT target_message_id FROM message_map ORDER BY source_message_id").all()).results;
  assert.deepEqual(mappings.map((row) => row.target_message_id), [702, 703]);
  assert.equal((await db.prepare("SELECT state FROM media_groups").first()).state, "done");
}));

test("撤回失敗時告知發送者並停止同一更新自動重送", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  let copies = 0, notice;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/copyMessage")) { copies++; return telegramResponse({ message_id: 700 }); }
    if (String(url).endsWith("/deleteMessages")) return telegramResponse(false, 403);
    notice = JSON.parse(init.body).text; return telegramResponse(true);
  };
  injectWriteFailure(db, (sql) => /INSERT OR REPLACE INTO message_map/.test(sql), 3);
  const env = auditEnv(db), request = () => auditRequest(7011, userMessage(121));
  const result = await worker.fetch(request(), env);
  assert.equal((await result.json()).discarded, true);
  await worker.fetch(request(), env);
  assert.equal(copies, 1);
  assert.match(notice, /停止自動重送/);
}));

test("ready 拒絕缺少新 migration 的 D1，套用後恢復", async () => {
  const db = new TestD1(5);
  try {
    const request = () => new Request("https://example.com/ready");
    assert.equal((await worker.fetch(request(), auditEnv(db))).status, 503);
    db.database.exec(readFileSync(new URL("../migrations/0006_verification_pending_message.sql", import.meta.url), "utf8"));
    assert.equal((await worker.fetch(request(), auditEnv(db))).status, 503);
    db.database.exec(readFileSync(new URL("../migrations/0007_user_language.sql", import.meta.url), "utf8"));
    assert.equal((await worker.fetch(request(), auditEnv(db))).status, 200);
  } finally { db.close(); }
});

test("管理者 /start 更新使用者選單，管理指令仍只對本人可見", () => withDatabaseMock(async (db) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
    return telegramResponse(true);
  };
  await processUpdate({ message: {
    message_id: 1, chat: { id: 1, type: "private" },
    from: { id: 1, is_bot: false }, text: "/start"
  } }, { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", ADMIN_GROUP_ID: "-1001", BOT_DB: db, CAPTCHA_ENABLED: "false" });
  const menus = calls.filter((call) => call.method === "setMyCommands");
  assert.equal(menus.length, 3);
  assert.deepEqual(menus[0].payload.scope, { type: "chat", chat_id: "1" });
  assert.deepEqual(menus[0].payload.commands.map((item) => item.command), ["start", "help", "status", "captcha", "unblock"]);
  assert.deepEqual(menus[1].payload.scope, { type: "chat_member", chat_id: "-1001", user_id: 1 });
  assert.deepEqual(menus[1].payload.commands.map((item) => item.command),
    ["help", "status", "user", "block", "unblock", "close"]);
  assert.deepEqual(menus[2].payload.scope, { type: "all_private_chats" });
  assert.deepEqual(menus[2].payload.commands.map((item) => item.command), ["start", "help", "language", "id", "forget"]);
  calls.length = 0;
  await processUpdate({ message: {
    message_id: 2, chat: { id: 1, type: "private" },
    from: { id: 1, is_bot: false }, text: "/start"
  } }, { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_DB: db, CAPTCHA_ENABLED: "false" });
  assert.deepEqual(calls.find((call) => call.method === "setMyCommands").payload.commands
    .map((item) => item.command), ["start", "help", "status", "captcha", "user", "block", "unblock"]);
}));

test("管理者 /status 顯示近 24 小時更新與 Webhook 待處理數", () => withDatabaseMock(async (db) => {
  const calls = [];
  const now = Math.floor(Date.now() / 1000);
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push({ method, payload: JSON.parse(init.body) });
    return telegramResponse(method === "getWebhookInfo" ? { pending_update_count: 3 } : true);
  };
  await db.prepare(`INSERT INTO processed_updates(update_id, processed_at, status, attempts, updated_at)
    VALUES (1, ?, 'done', 1, ?), (2, ?, 'failed', 2, ?), (3, ?, 'discarded', 5, ?),
      (4, ?, 'done', 1, ?)`)
    .bind(now, now, now, now, now, now, now - 2 * 86400, now - 2 * 86400).run();
  const env = { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_DB: db, CAPTCHA_ENABLED: "false" };
  await processUpdate({ message: {
    message_id: 5, chat: { id: 1, type: "private" },
    from: { id: 1, is_bot: false }, text: "/status"
  } }, env);
  const text = calls.find((call) => call.method === "sendMessage").payload.text;
  assert.match(text, /已完成：1/);
  assert.match(text, /等待重試：1/);
  assert.match(text, /停止重試：1/);
  assert.match(text, /待處理：3/);
  await processUpdate({ message: {
    message_id: 6, chat: { id: -1001, type: "supergroup", is_forum: true },
    from: { id: 99, is_bot: false }, message_thread_id: 77, text: "/status"
  } }, { ...env, ADMIN_GROUP_ID: "-1001" });
  assert.equal(calls.filter((call) => call.method === "getWebhookInfo").length, 1);
  await processUpdate({ message: {
    message_id: 7, chat: { id: -1001, type: "supergroup", is_forum: true },
    from: { id: 1, is_bot: false }, text: "/status"
  } }, { ...env, ADMIN_GROUP_ID: "-1001" });
  assert.equal(calls.filter((call) => call.method === "getWebhookInfo").length, 2);
}));

test("/forget 需確認並清除路由資料，封鎖者保留最小封鎖紀錄", () => withDatabaseMock(async (db) => {
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return telegramResponse({ message_id: sent.length });
  };
  for (const [id, blocked] of [["2", 0], ["3", 1]]) {
    await db.prepare(`INSERT INTO users(user_id, username, first_name, blocked, topic_id,
      created_at, updated_at) VALUES (?, 'old_name', 'Old Name', ?, ?, 1, 1)`)
      .bind(id, blocked, Number(id) + 70).run();
    await db.prepare(`INSERT INTO message_map(source_chat_id, source_message_id,
      target_chat_id, target_message_id, user_id, created_at)
      VALUES (?, 10, '-1001', ?, ?, 1)`).bind(id, Number(id) + 70, id).run();
    await db.prepare(`INSERT INTO media_groups(source_chat_id, media_group_id, user_id,
      direction, state, updated_at_ms, created_at)
      VALUES (?, 'album', ?, 'user_to_admin', 'done', 1, 1)`).bind(id, id).run();
    await db.prepare(`INSERT INTO media_group_messages(source_chat_id, media_group_id,
      message_id, created_at) VALUES (?, 'album', 11, 1)`).bind(id).run();
  }
  const env = { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_DB: db, CAPTCHA_ENABLED: "false" };
  await processUpdate({ message: userMessage(1, { text: "/forget" }) }, env);
  assert.equal((await db.prepare("SELECT username FROM users WHERE user_id = '2'").first()).username, "old_name");
  await processUpdate({ message: userMessage(2, { text: "/forget confirm" }) }, env);
  await processUpdate({ message: userMessage(3, {
    chat: { id: 3, type: "private" }, from: { id: 3, is_bot: false }, text: "/forget confirm"
  }) }, env);
  const erased = await db.prepare("SELECT * FROM users WHERE user_id = '2'").first();
  assert.equal(erased.erased, 1);
  assert.equal(erased.first_name, "");
  assert.equal(erased.topic_id, null);
  const blocked = await db.prepare("SELECT * FROM users WHERE user_id = '3'").first();
  assert.equal(blocked.blocked, 1);
  assert.equal(blocked.username, null);
  assert.equal(blocked.first_name, "");
  assert.equal(blocked.topic_id, null);
  assert.match(sent.at(-1).text, /清除資料不會解除封鎖/);
  await processUpdate({ message: {
    message_id: 4, chat: { id: 1, type: "private" },
    from: { id: 1, is_bot: false }, text: "/unblock 3"
  } }, env);
  assert.equal((await db.prepare("SELECT * FROM users WHERE user_id = '3'").first()).blocked, 0);
  for (const table of ["message_map", "media_groups", "media_group_messages"]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count, 0);
  }
}));

test("使用者歡迎訊息依部署語言，不依 Telegram 使用者語言", () => withDatabaseMock(async (db) => {
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/sendMessage")) sent.push(JSON.parse(init.body).text);
    return telegramResponse({ message_id: sent.length });
  };
  for (const language of ["ja", "en"]) {
    await processUpdate({ message: userMessage(sent.length + 1, {
      text: "/start",
      from: { id: 2, is_bot: false, language_code: "zh" }
    }) }, { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_LANGUAGE: language, BOT_DB: db, CAPTCHA_ENABLED: "false" });
  }
  assert.equal(sent[0], t("ja", "welcome"));
  assert.equal(sent[1], t("en", "welcome"));
  await processUpdate({ message: userMessage(3, { text: "/start" }) }, {
    BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_LANGUAGE: "en",
    WELCOME_MESSAGE: "Custom greeting", BOT_DB: db, CAPTCHA_ENABLED: "false"
  });
  assert.equal(sent[2], "Custom greeting");
}));

test("封鎖與無法轉送提示可由部署設定覆蓋", () => withDatabaseMock(async (db) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body);
    calls.push({ method, payload });
    if (method === "createForumTopic") return telegramResponse({ message_thread_id: 77 });
    if (method === "copyMessage") return telegramResponse(false, 400);
    return telegramResponse({ message_id: calls.length + 100 });
  };
  const env = {
    BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", ADMIN_GROUP_ID: "-1001",
    BLOCKED_MESSAGE: "Contact support", UNSUPPORTED_MESSAGE: "Use plain text",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  await db.prepare("INSERT INTO users(user_id, blocked, created_at, updated_at) VALUES ('2', 1, 0, 0)").run();
  await processUpdate({ message: userMessage(1, { text: "blocked" }) }, env);
  assert.ok(calls.some((call) => call.payload.text === "Contact support"));
  await db.prepare("UPDATE users SET blocked = 0 WHERE user_id = '2'").run();
  await assert.rejects(processUpdate({ message: userMessage(2, { text: "unsupported" }) }, env));
  assert.ok(calls.some((call) => call.payload.text === "Use plain text"));
}));

test("相簿聚合後只呼叫一次 copyMessages 並保存每則映射", () => withDatabaseMock(async (db) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body);
    calls.push({ method, payload });
    if (method === "createForumTopic") return telegramResponse({ message_thread_id: 77 });
    if (method === "copyMessages") {
      return telegramResponse(payload.message_ids.map((id, index) => ({ message_id: 100 + index })));
    }
    return telegramResponse({ message_id: 50 });
  };

  const env = {
    BOT_TOKEN: "test-token",
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001",
    MESSAGE_INTERVAL_SECONDS: "2",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  await Promise.all([
    processUpdate({ message: userMessage(10, { media_group_id: "album-1", photo: [{}] }) }, env),
    processUpdate({ message: userMessage(11, { media_group_id: "album-1", photo: [{}] }) }, env)
  ]);
  const albumCalls = calls.filter((call) => call.method === "copyMessages");
  assert.equal(albumCalls.length, 1);
  assert.deepEqual(albumCalls[0].payload.message_ids, [10, 11]);
  assert.equal(albumCalls[0].payload.message_thread_id, 77);
  assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
  const mapped = await db.prepare("SELECT COUNT(*) AS count FROM message_map").first();
  assert.equal(mapped.count, 2);
}));

test("逾期的相簿處理 lease 可由重試接手", () => withDatabaseMock(async (db) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body);
    calls.push({ method, payload });
    if (method === "createForumTopic") return telegramResponse({ message_thread_id: 77 });
    if (method === "copyMessages") {
      return telegramResponse(payload.message_ids.map(() => ({ message_id: 501 })));
    }
    return telegramResponse({ message_id: 50 });
  };
  const env = {
    BOT_TOKEN: "test-token",
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  const now = Math.floor(Date.now() / 1000);
  await db.prepare("INSERT INTO users(user_id, first_name, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind("2", "測試者", now, now).run();
  await db.prepare(`
    INSERT INTO media_groups(source_chat_id, media_group_id, user_id, direction, state,
      updated_at_ms, lease_until_ms, created_at)
    VALUES (?, ?, ?, 'user_to_admin', 'processing', ?, ?, ?)
  `).bind("2", "expired-album", "2", Date.now() - 10_000, Date.now() - 1_000, now).run();
  await db.prepare(`
    INSERT INTO media_group_messages(source_chat_id, media_group_id, message_id, created_at)
    VALUES (?, ?, ?, ?)
  `).bind("2", "expired-album", 120, now).run();

  await processUpdate({ message: userMessage(120, { media_group_id: "expired-album", photo: [{}] }) }, env);

  assert.equal(calls.filter((call) => call.method === "copyMessages").length, 1);
  assert.equal((await db.prepare("SELECT state FROM media_groups WHERE media_group_id = ?")
    .bind("expired-album").first()).state, "done");
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM message_map").first()).count, 1);
}));

test("同使用者併發訊息只建立一個 Topic", () => withDatabaseMock(async (db) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push({ method, payload: JSON.parse(init.body) });
    if (method === "createForumTopic") {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return telegramResponse({ message_thread_id: 88 });
    }
    return telegramResponse({ message_id: calls.length + 100 });
  };
  const env = {
    BOT_TOKEN: "test-token",
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001",
    MESSAGE_INTERVAL_SECONDS: "0",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  await Promise.all([
    processUpdate({ message: userMessage(20, { text: "一" }) }, env),
    processUpdate({ message: userMessage(21, { text: "二" }) }, env)
  ]);
  assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
  assert.equal(calls.filter((call) => call.method === "copyMessage").length, 2);
  const user = await db.prepare("SELECT topic_id FROM users WHERE user_id = '2'").first();
  assert.equal(user.topic_id, 88);
}));

test("原子節流會拒絕同秒的第二則一般訊息", () => withDatabaseMock(async (db) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body);
    calls.push({ method, payload });
    if (method === "createForumTopic") return telegramResponse({ message_thread_id: 99 });
    return telegramResponse({ message_id: calls.length + 200 });
  };
  const env = {
    BOT_TOKEN: "test-token",
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001",
    MESSAGE_INTERVAL_SECONDS: "2",
    RATE_LIMIT_MESSAGE: "Please wait",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  await Promise.all([
    processUpdate({ message: userMessage(30, { text: "第一則" }) }, env),
    processUpdate({ message: userMessage(31, { text: "第二則" }) }, env)
  ]);
  assert.equal(calls.filter((call) => call.method === "copyMessage").length, 1);
  assert.equal(calls.filter((call) => call.payload.text === "Please wait").length, 1);
}));

test("永久 Telegram 錯誤會記錄 discarded 並停止重試", () => withDatabaseMock(async (db) => {
  globalThis.fetch = async () => telegramResponse(false, 400);
  const update = {
    update_id: 4001,
    message: {
      message_id: 1,
      chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false },
      text: "/start"
    }
  };
  const response = await worker.fetch(new Request("https://example.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "valid-secret"
    },
    body: JSON.stringify(update)
  }), {
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "valid-secret",
    ADMIN_USER_ID: "1",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, discarded: true });
  const stored = await db.prepare(
    "SELECT status, attempts FROM processed_updates WHERE update_id = 4001"
  ).first();
  assert.equal(stored.status, "discarded");
  assert.equal(stored.attempts, 1);
}));

test("暫時 Telegram 錯誤會記錄 failed 並允許後續重試", () => withDatabaseMock(async (db) => {
  let telegramStatus = 500;
  globalThis.fetch = async () => telegramResponse(
    telegramStatus === 200 ? { message_id: 1 } : false,
    telegramStatus
  );
  const update = {
    update_id: 5001,
    message: {
      message_id: 1,
      chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false },
      text: "/start"
    }
  };
  const env = {
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "valid-secret",
    ADMIN_USER_ID: "1",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  const request = () => new Request("https://example.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "valid-secret"
    },
    body: JSON.stringify(update)
  });
  const failedResponse = await worker.fetch(request(), env);
  assert.equal(failedResponse.status, 500);
  assert.equal((await db.prepare(
    "SELECT status FROM processed_updates WHERE update_id = 5001"
  ).first()).status, "failed");

  telegramStatus = 200;
  const retryResponse = await worker.fetch(request(), env);
  assert.equal(retryResponse.status, 200);
  const stored = await db.prepare(
    "SELECT status, attempts FROM processed_updates WHERE update_id = 5001"
  ).first();
  assert.equal(stored.status, "done");
  assert.equal(stored.attempts, 2);
}));

test("Telegram 429 會回傳有上限的 Retry-After", () => withDatabaseMock(async (db) => {
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false,
    error_code: 429,
    description: "Too Many Requests",
    parameters: { retry_after: 7200 }
  }), {
    status: 429,
    headers: { "content-type": "application/json" }
  });
  const update = {
    update_id: 5002,
    message: userMessage(2, { text: "/start" })
  };
  const response = await worker.fetch(new Request("https://example.test/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "valid-secret" },
    body: JSON.stringify(update)
  }), {
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "valid-secret",
    ADMIN_USER_ID: "1",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("retry-after"), "3600");
}));

test("未知管理指令只回提示，不會誤傳給使用者", () => withDatabaseMock(async (db) => {
  await db.prepare(`
    INSERT INTO users(user_id, first_name, topic_id, created_at, updated_at)
    VALUES ('2', '測試者', 77, 1, 1)
  `).run();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
    return telegramResponse({ message_id: 1 });
  };
  await processUpdate({
    message: {
      message_id: 70,
      message_thread_id: 77,
      is_topic_message: true,
      chat: { id: -1001, type: "supergroup", is_forum: true },
      from: { id: 1, is_bot: false },
      text: "/blok"
    }
  }, { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", ADMIN_GROUP_ID: "-1001", BOT_DB: db, CAPTCHA_ENABLED: "false" });
  assert.equal(calls.some((call) => call.method === "copyMessage"), false);
  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.text, /未知指令/);
}));

test("管理者私訊模式會沿用最近對話，不重複產生身分標頭", () => withDatabaseMock(async (db) => {
  const calls = [];
  let nextMessageId = 100;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body);
    const result = { message_id: nextMessageId++ };
    calls.push({ method, payload, result });
    return telegramResponse(result);
  };
  const env = {
    BOT_TOKEN: "test-token",
    ADMIN_USER_ID: "1",
    MESSAGE_INTERVAL_SECONDS: "0",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  await processUpdate({ message: userMessage(80, { text: "第一則" }) }, env);
  await processUpdate({ message: userMessage(81, { text: "第二則" }) }, env);
  const headerCalls = calls.filter((call) => call.method === "sendMessage");
  const copyCalls = calls.filter((call) => call.method === "copyMessage");
  assert.equal(headerCalls.length, 1);
  assert.equal(copyCalls.length, 2);
  assert.equal(copyCalls[1].payload.reply_parameters.message_id, copyCalls[0].result.message_id);
}));

test("相簿處理期間晚到的項目會改為單則補送", () => withDatabaseMock(async (db) => {
  const calls = [];
  let releaseAlbum;
  let markAlbumStarted;
  const albumStarted = new Promise((resolve) => { markAlbumStarted = resolve; });
  const albumRelease = new Promise((resolve) => { releaseAlbum = resolve; });
  let nextMessageId = 500;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body);
    calls.push({ method, payload });
    if (method === "createForumTopic") return telegramResponse({ message_thread_id: 77 });
    if (method === "copyMessages") {
      markAlbumStarted();
      await albumRelease;
      return telegramResponse(payload.message_ids.map(() => ({ message_id: nextMessageId++ })));
    }
    return telegramResponse({ message_id: nextMessageId++ });
  };
  const env = {
    BOT_TOKEN: "test-token",
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001",
    MESSAGE_INTERVAL_SECONDS: "0",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  const firstBatch = Promise.all([
    processUpdate({ message: userMessage(90, { media_group_id: "late-album", photo: [{}] }) }, env),
    processUpdate({ message: userMessage(91, { media_group_id: "late-album", photo: [{}] }) }, env)
  ]);
  await albumStarted;
  const lateMessage = processUpdate({
    message: userMessage(92, { media_group_id: "late-album", photo: [{}] })
  }, env);
  releaseAlbum();
  await Promise.all([firstBatch, lateMessage]);
  assert.equal(calls.filter((call) => call.method === "copyMessages").length, 1);
  assert.equal(calls.filter((call) => call.method === "copyMessage").length, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM message_map").first()).count, 3);
}));

test("相簿部分複製時會刪除已送出的孤立訊息", () => withDatabaseMock(async (db) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body);
    calls.push({ method, payload });
    if (method === "createForumTopic") return telegramResponse({ message_thread_id: 77 });
    if (method === "copyMessages") return telegramResponse([{ message_id: 700 }]);
    return telegramResponse(method === "deleteMessages" ? true : { message_id: 50 });
  };
  const env = {
    BOT_TOKEN: "test-token",
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001",
    MESSAGE_INTERVAL_SECONDS: "0",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  await assert.rejects(Promise.all([
    processUpdate({ message: userMessage(100, { media_group_id: "partial-album", photo: [{}] }) }, env),
    processUpdate({ message: userMessage(101, { media_group_id: "partial-album", photo: [{}] }) }, env)
  ]), /Telegram 未完整複製相簿/);
  const rollback = calls.find((call) => call.method === "deleteMessages");
  assert.deepEqual(rollback.payload.message_ids, [700]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM message_map").first()).count, 0);
}));

test("使用者指令不會消耗一般訊息節流額度", () => withDatabaseMock(async (db) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push({ method, payload: JSON.parse(init.body) });
    if (method === "createForumTopic") return telegramResponse({ message_thread_id: 81 });
    return telegramResponse({ message_id: calls.length + 800 });
  };
  const env = {
    BOT_TOKEN: "test-token",
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001",
    MESSAGE_INTERVAL_SECONDS: "60",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  await processUpdate({ message: userMessage(110, { text: "/start" }) }, env);
  await processUpdate({ message: userMessage(111, { text: "緊接著的訊息" }) }, env);
  assert.equal(calls.filter((call) => call.method === "copyMessage").length, 1);
  assert.equal(calls.some((call) => call.payload.text === "訊息傳送過快，請稍後再試。"), false);
}));

test("可重試錯誤超過上限後會轉為 discarded", () => withDatabaseMock(async (db) => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return telegramResponse(false, 500);
  };
  const update = {
    update_id: 6001,
    message: userMessage(120, { text: "/start" })
  };
  const env = {
    BOT_TOKEN: "test-token",
    WEBHOOK_SECRET: "valid-secret",
    ADMIN_USER_ID: "1",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  const request = () => new Request("https://example.test/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "valid-secret" },
    body: JSON.stringify(update)
  });
  for (let attempt = 0; attempt < 4; attempt += 1) {
    assert.equal((await worker.fetch(request(), env)).status, 500);
  }
  const exhausted = await worker.fetch(request(), env);
  assert.equal(exhausted.status, 200);
  assert.deepEqual(await exhausted.json(), { ok: true, discarded: true });
  assert.equal(calls, 6); // Five processing attempts, then one best-effort stop notice.
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal(calls, 6);
  assert.equal((await db.prepare(
    "SELECT status FROM processed_updates WHERE update_id = 6001"
  ).first()).status, "discarded");
}));

test("編輯事件早於原訊息時會要求重試並在映射建立後同步", () => withDatabaseMock(async (db) => {
  const calls = [];
  let nextMessageId = 900;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body);
    calls.push({ method, payload });
    if (method === "createForumTopic") return telegramResponse({ message_thread_id: 91 });
    return telegramResponse(method.startsWith("edit") ? true : { message_id: nextMessageId++ });
  };
  const env = {
    BOT_TOKEN: "test-token",
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001",
    MESSAGE_INTERVAL_SECONDS: "0",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  const edited = {
    edited_message: userMessage(130, { text: "編輯後", entities: [] })
  };
  await assert.rejects(processUpdate(edited, env), /尚未建立轉送映射/);
  await processUpdate({ message: userMessage(130, { text: "原訊息" }) }, env);
  await processUpdate(edited, env);
  const editCall = calls.find((call) => call.method === "editMessageText");
  assert.equal(editCall.payload.chat_id, "-1001");
  assert.equal(editCall.payload.text, "編輯後");
}));

test("Topic 資料卡暫時失敗後會沿用原 Topic 補送", () => withDatabaseMock(async (db) => {
  const calls = [];
  let cardAttempts = 0;
  let nextMessageId = 950;
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    const payload = JSON.parse(init.body);
    calls.push({ method, payload });
    if (method === "createForumTopic") return telegramResponse({ message_thread_id: 92 });
    if (method === "sendMessage" && payload.message_thread_id === 92) {
      cardAttempts += 1;
      if (cardAttempts === 1) return telegramResponse(false, 500);
    }
    return telegramResponse({ message_id: nextMessageId++ });
  };
  const env = {
    BOT_TOKEN: "test-token",
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001",
    MESSAGE_INTERVAL_SECONDS: "0",
    BOT_DB: db, CAPTCHA_ENABLED: "false"
  };
  const update = { message: userMessage(140, { text: "需要補卡" }) };
  await assert.rejects(processUpdate(update, env), /mock failure/);
  await processUpdate(update, env);
  assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
  assert.equal(cardAttempts, 2);
  const user = await db.prepare(
    "SELECT topic_id, topic_card_message_id FROM users WHERE user_id = '2'"
  ).first();
  assert.equal(user.topic_id, 92);
  assert.ok(user.topic_card_message_id > 0);
}));

test("三語使用者 /help 只讀取一次語言偏好，不寫入、不轉送或反覆註冊選單", async () => {
  for (const language of ["zh", "ja", "en"]) {
    await withDatabaseMock(async (db) => {
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
        return telegramResponse(true);
      };
      const prepare = db.prepare.bind(db);
      let reads = 0;
      db.prepare = (sql) => {
        reads++;
        assert.equal(sql, "SELECT * FROM users WHERE user_id = ?");
        return prepare(sql);
      };
      await processUpdate({ message: userMessage(2000, { text: "/help" }) },
        { ...auditEnv(db), BOT_LANGUAGE: language });
      db.prepare = prepare;
      assert.equal(reads, 1);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].method, "sendMessage");
      assert.equal(calls[0].payload.text, t(language, "userHelp"));
      assert.doesNotMatch(calls[0].payload.text, /\/(block|unblock|status)\b/);
      assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM users").first()).total, 0);
      await processUpdate({ message: userMessage(2001, { text: "/start" }) }, auditEnv(db));
      assert.equal(calls.filter((call) => call.method === "setMyCommands").length, 0);
    });
  }
});

test("預設使用者選單按部署語言註冊，語言選項標示三語且管理指令不外洩", async () => {
  for (const language of ["zh", "ja", "en"]) {
    await withDatabaseMock(async (db) => {
      const calls = [];
      globalThis.fetch = async (url, init) => {
        calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
        return telegramResponse(true);
      };
      await processUpdate({ message: adminMessage(2010, "/start") },
        { ...auditEnv(db), BOT_LANGUAGE: language });
      const menus = calls.filter((call) => call.method === "setMyCommands");
      const userMenu = menus.find((call) => call.payload.scope.type === "all_private_chats");
      assert.deepEqual(userMenu.payload.commands, ["start", "help", "language", "id", "forget"].map((command) => ({
        command, description: command === "language" ? "中文 / English / 日本語" : t(language, `userCommand_${command}`)
      })));
      assert.equal(menus.filter((call) => call.payload.commands.some((item) => item.command === "block"))
        .every((call) => call.payload.scope.user_id === 1 || call.payload.scope.chat_id === "1"), true);
    });
  }
});

test("管理者未指定回覆或回覆過期對照時，明確提示未送出且不猜測使用者", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
    return telegramResponse(true);
  };
  const cases = [
    [false, adminMessage(2020, "未選擇回覆"), "replyRequired"],
    [false, adminMessage(2021, "過期對照", { reply_to_message: { message_id: 999 } }), "replyUnavailable"],
    [false, adminMessage(2022, "/block", { reply_to_message: { message_id: 999 } }), "replyUnavailable"],
    [true, adminMessage(2023, "錯誤位置"), "topicRequired"],
    [true, adminMessage(2024, "群組一般訊息", {
      chat: { id: -1001, type: "supergroup", is_forum: true }
    }), "topicRequired"]
  ];
  for (const [topic, message, key] of cases) {
    calls.length = 0;
    await processUpdate({ message }, auditEnv(db, topic));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "sendMessage");
    assert.equal(calls[0].payload.chat_id, message.chat.id);
    assert.equal(calls[0].payload.text, t("zh", key));
    assert.equal(calls[0].payload.reply_parameters.message_id, message.message_id);
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM message_map").first()).total, 0);
}));

test("清除後的舊話題回覆會提示失效，不重建個人資料或路由", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
    return telegramResponse(true);
  };
  await processUpdate({ message: userMessage(2030, { text: "/forget confirm" }) }, auditEnv(db));
  calls.length = 0;
  await processUpdate({ message: adminMessage(2031, "舊話題回覆", {
    chat: { id: -1001, type: "supergroup", is_forum: true }, message_thread_id: 72
  }) }, auditEnv(db));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.text, t("zh", "replyUnavailable"));
  assert.equal(calls[0].payload.message_thread_id, 72);
  const user = await db.prepare("SELECT erased,topic_id,first_name FROM users WHERE user_id='2'").first();
  assert.deepEqual({ ...user }, { erased: 1, topic_id: null, first_name: "" });
}));

test("轉送重試耗盡只提示原發送者一次，不把不確定送達說成未送達", async () => {
  for (const topicReply of [false, true]) {
    await withDatabaseMock(async (db) => {
      seedAuditUser(db);
      const calls = [];
      globalThis.fetch = async (url, init) => {
        const method = String(url).split("/").pop(), payload = JSON.parse(init.body);
        calls.push({ method, payload });
        return method === "copyMessage" ? telegramResponse(false, 503) : telegramResponse(true);
      };
      const message = topicReply ? adminMessage(2040, "回覆", {
        chat: { id: -1001, type: "supergroup", is_forum: true }, message_thread_id: 72
      }) : userMessage(2040, { text: "傳送" });
      const env = auditEnv(db);
      for (let attempt = 0; attempt < 5; attempt++) {
        const response = await worker.fetch(auditRequest(8001, message), env);
        assert.equal(response.status, attempt < 4 ? 500 : 200);
      }
      await worker.fetch(auditRequest(8001, message), env);
      assert.equal(calls.filter((call) => call.method === "copyMessage").length, 5);
      const notices = calls.filter((call) => call.method === "sendMessage");
      assert.equal(notices.length, 1);
      assert.equal(notices[0].payload.chat_id, message.chat.id);
      assert.equal(notices[0].payload.message_thread_id, message.message_thread_id);
      assert.equal(notices[0].payload.text, t("zh", "retryStopped"));
      assert.match(notices[0].payload.text, /先確認/);
      assert.doesNotMatch(notices[0].payload.text, /未送達/);
      assert.match((await db.prepare("SELECT last_error FROM processed_updates WHERE update_id=8001").first()).last_error, /^503 /);
    });
  }
});

test("失效的最後一次更新租約只發一次停止提示，忽略非管理者群組來源", () => withDatabaseMock(async (db) => {
  const now = Math.floor(Date.now() / 1000);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
    return telegramResponse(true);
  };
  for (const [id, message] of [[8002, userMessage(2050, { text: "舊工作" })], [8003, {
    ...userMessage(2051, { text: "群組訊息" }), chat: { id: -1001, type: "supergroup", is_forum: true }
  }]]) {
    await db.prepare(`INSERT INTO processed_updates(update_id,processed_at,status,attempts,updated_at,lease_token)
      VALUES (?,?,'processing',5,?,'expired')`).bind(id, now - 120, now - 120).run();
    assert.equal((await worker.fetch(auditRequest(id, message), auditEnv(db))).status, 200);
    assert.equal((await worker.fetch(auditRequest(id, message), auditEnv(db))).status, 200);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.chat_id, 2);
}));

test("失去租約的舊工作不能重複發送新工作已處理的終止提示", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(`INSERT INTO processed_updates(update_id,processed_at,status,attempts,updated_at,lease_token)
    VALUES (8004,?,'failed',4,?,'old')`).bind(now, now).run();
  const calls = [];
  globalThis.fetch = async (url) => {
    const method = String(url).split("/").pop(); calls.push(method);
    await db.prepare("UPDATE processed_updates SET status='discarded',lease_token='new-worker' WHERE update_id=8004").run();
    return telegramResponse(false, 503);
  };
  assert.equal((await worker.fetch(auditRequest(8004, userMessage(2060, { text: "test" })), auditEnv(db))).status, 200);
  assert.deepEqual(calls, ["copyMessage"]);
}));

test("文字與相簿遇到關閉話題時沿用原話題，只有被刪除才另建", async () => {
  for (const album of [false, true]) {
    for (const deleted of [false, true]) {
      await withDatabaseMock(async (db) => {
        seedAuditUser(db);
        const calls = [];
        let copies = 0;
        globalThis.fetch = async (url, init) => {
          const method = String(url).split("/").pop(), payload = JSON.parse(init.body);
          calls.push({ method, payload });
          if (method === "createForumTopic") return telegramResponse({ message_thread_id: 73 });
          if (method === "copyMessage" || method === "copyMessages") {
            if (++copies === 1) return telegramResponse(false, 400, deleted ? "message thread not found" : "TOPIC_CLOSED");
            return telegramResponse(album ? [{ message_id: 900 }] : { message_id: 900 });
          }
          return telegramResponse({ message_id: 901 });
        };
        const message = userMessage(2070, album
          ? { text: undefined, media_group_id: "recover-topic", photo: [{}] } : { text: "test" });
        await processUpdate({ message }, auditEnv(db));
        assert.equal(copies, 2);
        assert.equal(calls.filter((call) => call.method === "reopenForumTopic").length, deleted ? 0 : 1);
        assert.equal(calls.filter((call) => call.method === "createForumTopic").length, deleted ? 1 : 0);
        assert.equal((await db.prepare("SELECT topic_id FROM users WHERE user_id='2'").first()).topic_id, deleted ? 73 : 72);
        assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM message_map").first()).total, 1);
      });
    }
  }
});

test("補送身分卡遇到關閉話題且被其他工作重開時，仍沿用原話題", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  await db.prepare("UPDATE users SET topic_card_message_id=NULL WHERE user_id='2'").run();
  const calls = [];
  let cards = 0;
  globalThis.fetch = async (url) => {
    const method = String(url).split("/").pop(); calls.push(method);
    if (method === "sendMessage" && ++cards === 1) return telegramResponse(false, 400, "TOPIC_CLOSED");
    if (method === "reopenForumTopic") return telegramResponse(false, 400, "TOPIC_NOT_MODIFIED");
    return telegramResponse({ message_id: 902 });
  };
  await processUpdate({ message: userMessage(2080, { text: "test" }) }, auditEnv(db));
  assert.equal(cards, 2);
  assert.equal(calls.filter((method) => method === "createForumTopic").length, 0);
  assert.equal((await db.prepare("SELECT topic_id FROM users WHERE user_id='2'").first()).topic_id, 72);
}));

test("話題重開前重新檢查清除與封鎖狀態，不為舊工作恢復路由", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  const calls = [];
  globalThis.fetch = async (url) => {
    const method = String(url).split("/").pop(); calls.push(method);
    await db.prepare("UPDATE users SET blocked=1 WHERE user_id='2'").run();
    return telegramResponse(false, 400, "TOPIC_CLOSED");
  };
  await processUpdate({ message: userMessage(2090, { text: "test" }) }, auditEnv(db));
  assert.deepEqual(calls, ["copyMessage"]);
  assert.equal((await db.prepare("SELECT COUNT(*) AS total FROM message_map").first()).total, 0);
}));

test("/status 排除自身，從既有索引取得最近轉送及簡短失敗原因", async () => {
  for (const language of ["zh", "ja", "en"]) {
    await withDatabaseMock(async (db) => {
      seedAuditUser(db);
      const now = Math.floor(Date.now() / 1000), calls = [];
      await db.prepare("INSERT INTO message_map VALUES ('2',3000,'-1001',900,'2',?)").bind(now - 300).run();
      await db.prepare(`INSERT INTO processed_updates(update_id,processed_at,status,attempts,updated_at,last_error)
        VALUES (8100,?,'failed',1,?,'503 Telegram copyMessage error'),
          (8101,?,'discarded',5,?,'403 private detail bot123456:DO_NOT_DISPLAY'),
          (8102,?,'discarded',5,?,'old failure')`)
        .bind(now - 120, now - 120, now - 60, now - 60, now - 172800, now - 172800).run();
      globalThis.fetch = async (url, init) => {
        const method = String(url).split("/").pop(), payload = JSON.parse(init.body);
        calls.push({ method, payload });
        return telegramResponse(method === "getWebhookInfo" ? { pending_update_count: 0 } : true);
      };
      const sql = [], prepare = db.prepare.bind(db);
      db.prepare = (query) => { sql.push(query); return prepare(query); };
      const response = await worker.fetch(auditRequest(8103, adminMessage(2100, "/status")),
        { ...auditEnv(db), BOT_LANGUAGE: language });
      assert.equal(response.status, 200);
      const text = calls.at(-1).payload.text, separator = t(language, "fieldSeparator");
      assert.ok(text.includes(`${t(language, "statusProcessing")}${separator}0`));
      assert.ok(text.includes(`${t(language, "statusFailed")}${separator}1`));
      assert.ok(text.includes(`${t(language, "statusDiscarded")}${separator}1`));
      assert.ok(text.includes(t(language, "statusLastRelay")));
      assert.ok(text.includes(t(language, "failurePermission")));
      assert.doesNotMatch(text, /DO_NOT_DISPLAY|private detail|old failure/);
      const statusSql = sql.find((query) => /GROUP BY status/.test(query));
      const plan = await prepare("EXPLAIN QUERY PLAN " + statusSql)
        .bind(now - 60, now - 86400, 8103).all();
      assert.ok(plan.results.some((row) => /idx_processed_updates_status/.test(row.detail)));
      const relayPlan = await prepare("EXPLAIN QUERY PLAN SELECT MAX(created_at) AS latest_at FROM message_map").all();
      assert.ok(relayPlan.results.some((row) => /idx_message_map_created/.test(row.detail)));
    });
  }
});

test("無異常時 /status 只做兩次唯讀查詢，無轉送記錄時不誤報時間", () => withDatabaseMock(async (db) => {
  const sql = [], prepare = db.prepare.bind(db);
  db.prepare = (query) => { sql.push(query); return prepare(query); };
  let text;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/getWebhookInfo")) return telegramResponse({ pending_update_count: 0 });
    text = JSON.parse(init.body).text; return telegramResponse(true);
  };
  await processUpdate({ message: adminMessage(2110, "/status") }, auditEnv(db));
  assert.equal(sql.length, 2);
  assert.ok(sql.every((query) => /^\s*SELECT/.test(query)));
  assert.ok(text.includes(t("zh", "statusNoRelay")));
  assert.ok(text.includes(`${t("zh", "statusLastError")}：${t("zh", "statusNoError")}`));
}));

test("舊話題已關閉時，未送出提示改私訊管理者，不重新開啟失效話題", () => withDatabaseMock(async (db) => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop(), payload = JSON.parse(init.body);
    calls.push({ method, payload });
    return String(payload.chat_id) === "-1001"
      ? telegramResponse(false, 400, "TOPIC_CLOSED") : telegramResponse(true);
  };
  await processUpdate({ message: adminMessage(2120, "舊話題回覆", {
    chat: { id: -1001, type: "supergroup", is_forum: true }, message_thread_id: 999
  }) }, auditEnv(db));
  assert.deepEqual(calls.map((call) => call.method), ["sendMessage", "sendMessage"]);
  assert.equal(calls[1].payload.chat_id, "1");
  assert.equal(calls[1].payload.text, t("zh", "replyUnavailable"));
  assert.equal(calls[1].payload.reply_parameters, undefined);
  assert.equal(calls[1].payload.message_thread_id, undefined);
}));

test("驗證遷移保留既有聯絡者，清除者與新使用者仍須答題", async () => {
  const db = new TestD1(4);
  try {
    db.database.exec("INSERT INTO users(user_id,erased,created_at,updated_at) VALUES ('2',0,1,1),('3',1,1,1)");
    db.database.exec(readFileSync(new URL("../migrations/0005_contact_verification.sql", import.meta.url), "utf8"));
    db.database.exec("INSERT INTO users(user_id,created_at,updated_at) VALUES ('4',1,1)");
    const rows = (await db.prepare("SELECT captcha_verified FROM users ORDER BY user_id").all()).results;
    assert.deepEqual(rows.map((row) => row.captcha_verified), [1, 0, 0]);
  } finally { db.close(); }
});

test("所有算術題都只有簡單整數答案，除法無零除與餘數", () => {
  const operations = new Set();
  for (let code = 0; code < 324; code++) {
    const { question, answer } = captchaQuestion(code);
    const [, left, op, right] = /^(\d+) ([+−×÷]) (\d+)$/.exec(question);
    const a = Number(left), b = Number(right);
    const expected = op === "+" ? a + b : op === "−" ? a - b : op === "×" ? a * b : a / b;
    assert.equal(answer, expected);
    assert.ok(Number.isInteger(answer) && answer >= 0 && answer <= 81);
    if (op === "÷") assert.ok(b > 0 && a % b === 0);
    operations.add(op);
  }
  assert.equal(operations.size, 4);
});

test("預設攔截文字與媒體；刷訊息不寫個人資料、不反覆出題或建立 Topic", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
    return telegramResponse({ message_id: 700 });
  };
  await processUpdate({ message: userMessage(10, { text: "廣告連結" }) }, env);
  const pending = await db.prepare("SELECT * FROM users WHERE user_id='2'").first();
  assert.equal(pending.captcha_verified, 0);
  assert.equal(pending.first_name, "");
  assert.equal(pending.username, null);
  assert.equal(pending.topic_id, null);
  let writes = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = prepare(sql), run = statement.runSync.bind(statement);
    statement.runSync = () => { writes++; return run(); };
    return statement;
  };
  for (let id = 11; id <= 60; id++) {
    await processUpdate({ message: userMessage(id, id % 2 ? { text: "廣告" }
      : { photo: [{}], media_group_id: "spam" }) }, env);
  }
  await processUpdate({ edited_message: userMessage(10, { text: "改成廣告" }) }, env);
  assert.equal(writes, 0);
  assert.deepEqual(calls.map((call) => call.method), ["sendMessage"]);
  assert.ok(calls[0].payload.text.includes(t("zh", "captchaPrompt").split("{question}")[0]));
  for (const table of ["message_map", "rate_admissions"]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0);
  }
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM media_groups WHERE state='initializing'").first()).n, 1);
  assert.equal((await db.prepare("SELECT message_id FROM media_group_messages").first()).message_id, 10);
}));

test("三語兩種模式保留歡迎文字，首則訊息答題後自動轉送，答案與其他舊內容不轉送", async () => {
  for (const topic of [true, false]) for (const language of ["zh", "ja", "en"]) {
    await withDatabaseMock(async (db) => {
      const env = { ...auditEnv(db, topic), CAPTCHA_ENABLED: undefined, BOT_LANGUAGE: language,
        ...(language === "zh" ? { WELCOME_MESSAGE: "原有自訂歡迎" } : {}) };
      const calls = [];
      globalThis.fetch = async (url, init) => {
        const method = String(url).split("/").pop();
        calls.push({ method, payload: JSON.parse(init.body) });
        if (method === "copyMessages") return telegramResponse([{ message_id: 700 }]);
        return telegramResponse(method === "createForumTopic" ? { message_thread_id: 72 } : { message_id: 700 });
      };
      await processUpdate({ message: userMessage(10, { text: "/start" }) }, env);
      assert.equal(calls.find((call) => call.method === "sendMessage").payload.text, env.WELCOME_MESSAGE || t(language, "welcome"));
      assert.equal((await db.prepare("SELECT COUNT(*) n FROM users").first()).n, 0);
      await processUpdate({ message: userMessage(11, { text: "第一則聯絡內容" }) }, env);
      assert.ok(calls.at(-1).payload.text.startsWith(t(language, "captchaPrompt").split("{question}")[0]));
      await db.prepare("UPDATE users SET captcha_code=0 WHERE user_id='2'").run();
      await processUpdate({ message: userMessage(12, { text: "２" }) }, env);
      assert.equal(calls.at(-1).payload.text, t(language, "captchaPassed"));
      assert.equal((await db.prepare("SELECT captcha_verified FROM users WHERE user_id='2'").first()).captcha_verified, 1);
      assert.deepEqual(calls.filter((call) => call.method === "copyMessages").map((call) => call.payload.message_ids), [[11]]);
      for (const id of [9, 10, 12]) {
        await processUpdate({ message: userMessage(id, { text: "舊內容" }) }, env);
        await processUpdate({ edited_message: userMessage(id, { text: "編輯舊內容" }) }, env);
      }
      assert.equal(calls.some((call) => call.method === "copyMessage"), false);
      await processUpdate({ message: userMessage(11, { text: "重複的原訊息" }) }, env);
      assert.equal(calls.filter((call) => call.method === "copyMessages").length, 1);
      await processUpdate({ edited_message: userMessage(11, { text: "編輯第一則內容" }) }, env);
      assert.equal(calls.at(-1).method, "editMessageText");
      await processUpdate({ message: userMessage(20, { text: "真正聯絡" }) }, env);
      assert.deepEqual(calls.filter((call) => call.method === "copyMessage")
        .map((call) => call.payload.message_id), [20]);
      await processUpdate({ edited_message: userMessage(20, { text: "修改聯絡內容" }) }, env);
      assert.equal(calls.at(-1).method, "editMessageText");
      await processUpdate({ message: adminMessage(30, "回覆", topic
        ? { chat: { id: -1001, type: "supergroup", is_forum: true }, message_thread_id: 72 }
        : { reply_to_message: { message_id: 700 } }) }, env);
      assert.equal(calls.at(-1).method, "copyMessage");
      assert.equal(calls.at(-1).payload.chat_id, "2");
    });
  }
});

test("三次錯誤後冷卻，重複更新不重扣次數；冷卻內不讀寫路由或發提示", () => withDatabaseMock(async (db) => {
  let now = 2_000_000_000;
  Date.now = () => now * 1000;
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined };
  let notices = 0;
  globalThis.fetch = async () => { notices++; return telegramResponse({ message_id: 700 }); };
  await processUpdate({ message: userMessage(10, { text: "首次聯絡" }) }, env);
  for (let attempt = 1; attempt <= 3; attempt++) {
    now += 5;
    const request = () => auditRequest(9000 + attempt, userMessage(10 + attempt, { text: "999" }));
    assert.equal((await worker.fetch(request(), env)).status, 200);
    assert.equal((await worker.fetch(request(), env)).status, 200);
    assert.equal((await db.prepare("SELECT captcha_attempts FROM users").first()).captcha_attempts, attempt);
  }
  assert.equal(notices, 4);
  const locked = await db.prepare("SELECT * FROM users").first();
  assert.equal(locked.captcha_until, now + 900);
  now += 899;
  await processUpdate({ message: userMessage(20, { text: String(captchaQuestion(locked.captcha_code).answer) }) }, env);
  await processUpdate({ message: userMessage(21, { text: "重複廣告" }) }, env);
  assert.equal(notices, 4);
  assert.deepEqual(await db.prepare("SELECT * FROM users").first(), locked);
  now++;
  await processUpdate({ message: userMessage(22, { text: "重新聯絡" }) }, env);
  assert.equal(notices, 5);
  assert.equal((await db.prepare("SELECT captcha_attempts FROM users").first()).captcha_attempts, 0);
}));

test("過期答案不暫存或轉送；/start 只顯示歡迎且不重置期限或錯誤次數", () => withDatabaseMock(async (db) => {
  let now = 2_000_000_000;
  Date.now = () => now * 1000;
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined };
  globalThis.fetch = async () => telegramResponse({ message_id: 700 });
  await processUpdate({ message: userMessage(10, { text: "首次聯絡" }) }, env);
  now += 5;
  await processUpdate({ message: userMessage(11, { text: "999" }) }, env);
  now += 60;
  await processUpdate({ message: userMessage(12, { text: "/start" }) }, env);
  let user = await db.prepare("SELECT * FROM users").first();
  assert.equal(user.captcha_attempts, 1);
  assert.equal(user.captcha_until, 2_000_000_300);
  now = user.captcha_until;
  await processUpdate({ message: userMessage(13, { text: String(captchaQuestion(user.captcha_code).answer) }) }, env);
  user = await db.prepare("SELECT * FROM users").first();
  assert.equal(user.captcha_verified, 0);
  assert.equal(user.captcha_until, 0);
  assert.equal(user.captcha_pending_group, null);
  assert.equal(user.captcha_attempts, 0);
  await processUpdate({ message: userMessage(14, { text: "重新傳送聯絡內容" }) }, env);
  user = await db.prepare("SELECT * FROM users").first();
  assert.equal(user.captcha_until, now + 300);
  assert.deepEqual((await db.prepare("SELECT message_id FROM media_group_messages").all()).results.map((row) => row.message_id), [14]);
}));

test("Telegram 暫時失敗後可補送同一道題與通過通知，絕不把答案變成一般轉送", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined };
  let fail = true;
  let failPassed = false;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop(), payload = JSON.parse(init.body);
    calls.push({ method, payload });
    if (fail) { fail = false; return telegramResponse(false, 500); }
    if (failPassed && payload.text === t("zh", "captchaPassed")) {
      failPassed = false;
      return telegramResponse(false, 500);
    }
    if (method === "createForumTopic") return telegramResponse({ message_thread_id: 72 });
    if (method === "copyMessages") return telegramResponse([{ message_id: 700 }]);
    return telegramResponse({ message_id: 700 });
  };
  const first = () => auditRequest(9100, userMessage(10, { text: "廣告" }));
  assert.equal((await worker.fetch(first(), env)).status, 500);
  const code = (await db.prepare("SELECT captcha_code FROM users").first()).captcha_code;
  assert.equal((await worker.fetch(first(), env)).status, 200);
  assert.equal((await db.prepare("SELECT captcha_code FROM users").first()).captcha_code, code);
  assert.equal(calls[0].payload.text, calls[1].payload.text);
  failPassed = true;
  const answer = () => auditRequest(9101, userMessage(11, { text: String(captchaQuestion(code).answer) }));
  assert.equal((await worker.fetch(answer(), env)).status, 500);
  assert.equal((await worker.fetch(answer(), env)).status, 200);
  assert.equal(calls.at(-1).payload.text, t("zh", "captchaPassed"));
  assert.deepEqual(calls.filter((call) => call.method === "copyMessages").map((call) => call.payload.message_ids), [[10]]);
}));

test("答題併發清除或封鎖時不能通過驗證，也不能由舊更新恢復資料", async () => {
  for (const erase of [true, false]) await withDatabaseMock(async (db) => {
    const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined };
    globalThis.fetch = async () => telegramResponse({ message_id: 700 });
    await processUpdate({ message: userMessage(10, { text: "首次聯絡" }) }, env);
    const user = await db.prepare("SELECT * FROM users").first();
    const prepare = db.prepare.bind(db);
    db.prepare = (sql) => {
      const statement = prepare(sql);
      if (/UPDATE users SET captcha_verified = 1/.test(sql)) {
        const run = statement.run.bind(statement);
        statement.run = async () => {
          if (erase) await processUpdate({ message: userMessage(20, { text: "/forget confirm" }) }, env);
          else db.database.exec("UPDATE users SET blocked=1 WHERE user_id='2'");
          return run();
        };
      }
      return statement;
    };
    await processUpdate({ message: userMessage(11, { text: String(captchaQuestion(user.captcha_code).answer) }) }, env);
    const current = await prepare("SELECT * FROM users").first();
    assert.equal(current.captcha_verified, 0);
    assert.equal(erase ? current.erased : current.blocked, 1);
    await processUpdate({ message: userMessage(12, { text: "延遲訊息" }) }, env);
    assert.equal((await prepare("SELECT * FROM users").first()).captcha_verified, 0);
  });
});

test("驗證關閉與已通過驗證時的正常轉送 SQL 相同，無額外讀寫", () => withDatabaseMock(async (db) => {
  seedAuditUser(db);
  db.database.exec("UPDATE users SET captcha_verified=1 WHERE user_id='2'");
  globalThis.fetch = async () => telegramResponse({ message_id: 700 });
  const env = auditEnv(db), queries = [];
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => { queries.push(sql); return prepare(sql); };
  Date.now = () => 2_000_000_000_000;
  await processUpdate({ message: userMessage(10, { text: "正常聯絡" }) }, env);
  const before = [...queries];
  db.database.exec("DELETE FROM message_map; DELETE FROM rate_admissions; UPDATE users SET last_message_at=0, last_rate_key=NULL");
  queries.length = 0;
  await processUpdate({ message: userMessage(11, { text: "正常聯絡" }) }, { ...env, CAPTCHA_ENABLED: undefined });
  assert.deepEqual(queries, before);
}));

test("每日原有清理會移除七天未完成驗證者，保留近期、已通過與封鎖者", () => withDatabaseMock(async (db) => {
  const now = Math.floor(Date.now() / 1000), old = now - 8 * 86400;
  db.database.exec(`INSERT INTO users(user_id,captcha_verified,blocked,created_at,updated_at) VALUES
    ('2',0,0,${old},${old}),('3',0,0,${now},${now}),('4',1,0,${old},${old}),('5',0,1,${old},${old})`);
  let cleanup;
  await worker.scheduled({}, auditEnv(db), { waitUntil(promise) { cleanup = promise; } });
  await cleanup;
  assert.deepEqual((await db.prepare("SELECT user_id FROM users ORDER BY user_id").all()).results
    .map((row) => row.user_id), ["3", "4", "5"]);
}));

test("併發首次訊息只出一題；併發錯誤不重扣驗證次數", () => withDatabaseMock(async (db) => {
  let now = 2_000_000_000;
  Date.now = () => now * 1000;
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined };
  let notices = 0;
  globalThis.fetch = async () => { notices++; return telegramResponse({ message_id: 700 }); };
  await Promise.all([10, 11, 12].map((id) => processUpdate({ message: userMessage(id, { text: "廣告" }) }, env)));
  assert.equal(notices, 1);
  now += 5;
  await Promise.all([20, 21, 22].map((id) => processUpdate({ message: userMessage(id, { text: "999" }) }, env)));
  assert.equal(notices, 2);
  assert.equal((await db.prepare("SELECT captcha_attempts FROM users").first()).captcha_attempts, 1);
}));

test("驗證前 /id 不建資料，清除後舊答案無效且新聯絡必須重新驗證", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined };
  globalThis.fetch = async (url) => telegramResponse(String(url).endsWith("/copyMessages")
    ? [{ message_id: 700 }] : String(url).endsWith("/createForumTopic") ? { message_thread_id: 72 } : { message_id: 700 });
  await processUpdate({ message: userMessage(1, { text: "/id" }) }, env);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM users").first()).n, 0);
  await processUpdate({ message: userMessage(10, { text: "首次聯絡" }) }, env);
  const answer = String(captchaQuestion((await db.prepare("SELECT captcha_code FROM users").first()).captcha_code).answer);
  await processUpdate({ message: userMessage(11, { text: answer }) }, env);
  await processUpdate({ message: userMessage(20, { text: "/forget confirm" }) }, env);
  await processUpdate({ message: userMessage(11, { text: answer }) }, env);
  let user = await db.prepare("SELECT * FROM users").first();
  assert.equal(user.captcha_verified, 0);
  assert.equal(user.captcha_code, null);
  assert.equal(user.erased, 1);
  await processUpdate({ message: userMessage(30, { text: "再次聯絡" }) }, env);
  user = await db.prepare("SELECT * FROM users").first();
  assert.equal(user.captcha_verified, 0);
  assert.equal(user.first_name, "");
  assert.notEqual(user.captcha_code, null);
  assert.equal(user.topic_id, null);
}));

test("管理者私訊開關立即生效，跨請求保留並優先於部署預設，關閉不解除封鎖", () => withDatabaseMock(async (db) => {
  const env = auditEnv(db, false), calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
    if (String(url).endsWith("/copyMessages")) return telegramResponse([{ message_id: 700 }]);
    return telegramResponse({ message_id: 700 });
  };
  await processUpdate({ message: adminMessage(10, "/captcha") }, env);
  assert.ok(calls.at(-1).payload.text.startsWith(t("zh", "captchaDisabled")));
  await processUpdate({ message: adminMessage(11, "/captcha on") }, env);
  await processUpdate({ message: userMessage(20, { text: "待驗證" }) }, { ...env });
  assert.equal(calls.some((call) => call.method === "copyMessage"), false);
  await processUpdate({ message: adminMessage(12, "/captcha off") }, env);
  await processUpdate({ message: userMessage(21, { text: "可直接聯絡" }) }, { ...env, CAPTCHA_ENABLED: "true" });
  assert.equal(calls.at(-1).method, "copyMessage");
  await db.prepare("UPDATE users SET blocked=1 WHERE user_id='2'").run();
  const copies = calls.filter((call) => call.method === "copyMessage").length;
  await processUpdate({ message: userMessage(22, { text: "仍被封鎖" }) }, env);
  assert.equal(calls.filter((call) => call.method === "copyMessage").length, copies);
  await processUpdate({ message: adminMessage(13, "/captcha on") }, env);
  await processUpdate({ message: userMessage(30, { chat: { id: 3, type: "private" },
    from: { id: 3, is_bot: false }, text: "新聯絡者" }) }, { ...env });
  assert.ok(calls.at(-1).payload.text.startsWith(t("zh", "captchaPrompt").split("{question}")[0]));
  assert.equal((await db.prepare("SELECT captcha_enabled FROM bot_settings").first()).captcha_enabled, 1);
}));

test("三語管理選單包含驗證開關，狀態與無效參數只讀取設定", async () => {
  for (const language of ["zh", "ja", "en"]) await withDatabaseMock(async (db) => {
    const env = { ...auditEnv(db), BOT_LANGUAGE: language }, calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
      return telegramResponse(true);
    };
    await processUpdate({ message: adminMessage(10, "/start") }, env);
    const menus = calls.filter((call) => call.method === "setMyCommands");
    assert.deepEqual(menus.filter((call) => call.payload.commands.some((item) => item.command === "captcha"))
      .map((call) => call.payload.scope), [{ type: "chat", chat_id: "1" }]);
    for (const text of ["/captcha", "/captcha invalid", "/captcha on extra"]) {
      await processUpdate({ message: adminMessage(11, text) }, env);
      assert.equal(calls.at(-1).payload.text, t(language, "captchaDisabled") + "\n\n" + t(language, "captchaControls"));
    }
    const row = await db.prepare("SELECT * FROM bot_settings").first();
    assert.equal(row.captcha_enabled, null);
    assert.equal(row.captcha_message_id, 0);
    assert.equal((await db.prepare("SELECT COUNT(*) n FROM users").first()).n, 0);
  });
});

test("使用者、群組與編輯更新不能修改開關，其他 Bot 的命令也不執行", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined, BOT_TOKEN: "captcha-scope-test" };
  globalThis.fetch = async (url) => telegramResponse(String(url).endsWith("/getMe")
    ? { username: "ThisRelayBot" } : { message_id: 700 });
  await processUpdate({ message: userMessage(10, { text: "/captcha off" }) }, env);
  await processUpdate({ message: adminMessage(11, "/captcha off", {
    chat: { id: -1001, type: "supergroup", is_forum: true }, message_thread_id: 72
  }) }, env);
  await processUpdate({ edited_message: adminMessage(12, "/captcha off") }, env);
  await processUpdate({ message: adminMessage(13, "/captcha@AnotherBot off") }, env);
  const setting = await db.prepare("SELECT * FROM bot_settings").first();
  assert.equal(setting.captcha_enabled, null);
  assert.equal(setting.captcha_message_id, 0);
  await processUpdate({ message: adminMessage(14, "/captcha@ThisRelayBot OFF") }, env);
  assert.equal((await db.prepare("SELECT captcha_enabled FROM bot_settings").first()).captcha_enabled, 0);
}));

test("舊開關命令通知失敗後重試，不能覆蓋較新設定", () => withDatabaseMock(async (db) => {
  const env = auditEnv(db);
  let fail = true;
  const texts = [];
  globalThis.fetch = async (_url, init) => {
    texts.push(JSON.parse(init.body).text);
    if (fail) { fail = false; return telegramResponse(false, 500); }
    return telegramResponse({ message_id: 700 });
  };
  const old = () => auditRequest(9200, adminMessage(10, "/captcha off"));
  assert.equal((await worker.fetch(old(), env)).status, 500);
  await processUpdate({ message: adminMessage(11, "/captcha on") }, env);
  assert.equal((await worker.fetch(old(), env)).status, 200);
  const row = await db.prepare("SELECT * FROM bot_settings").first();
  assert.equal(row.captcha_enabled, 1);
  assert.equal(row.captcha_message_id, 11);
  assert.ok(texts.at(-1).startsWith(t("zh", "captchaEnabled")));
}));

test("開關寫入暫時失敗可重試，設定列遺失時 ready 與新轉送都關閉通行", () => withDatabaseMock(async (db) => {
  const env = auditEnv(db);
  let sends = 0;
  globalThis.fetch = async () => { sends++; return telegramResponse(true); };
  injectWriteFailure(db, (sql) => /UPDATE bot_settings SET captcha_enabled/.test(sql));
  const request = () => auditRequest(9201, adminMessage(10, "/captcha on"));
  assert.equal((await worker.fetch(request(), env)).status, 500);
  assert.equal((await worker.fetch(request(), env)).status, 200);
  assert.equal(sends, 1);
  await db.prepare("DELETE FROM bot_settings").run();
  assert.equal((await worker.fetch(new Request("https://example.test/ready"), env)).status, 503);
  assert.equal((await worker.fetch(auditRequest(9202, userMessage(20, { text: "不應轉送" })), env)).status, 500);
  assert.equal(sends, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM users").first()).n, 0);
}));

test("首組相簿只暫存最多十個 ID，通過後整組自動轉送；晚到項目不受答案水位誤攔", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined }, calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop(), payload = JSON.parse(init.body);
    calls.push({ method, payload });
    return telegramResponse(method === "copyMessages" ? payload.message_ids.map((id) => ({ message_id: 1000 + id }))
      : method === "createForumTopic" ? { message_thread_id: 72 } : { message_id: 700 });
  };
  await Promise.all(Array.from({ length: 10 }, (_, index) => processUpdate({ message:
    userMessage(10 + index, { photo: [{}], media_group_id: "first" }) }, env)));
  await processUpdate({ message: userMessage(20, { photo: [{}], media_group_id: "first" }) }, env);
  await processUpdate({ message: userMessage(30, { photo: [{}], media_group_id: "other" }) }, env);
  assert.equal(calls.length, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM media_group_messages").first()).n, 10);
  db.database.exec("UPDATE users SET captcha_code=0; UPDATE media_groups SET updated_at_ms=updated_at_ms-1000");
  await processUpdate({ message: userMessage(200, { text: "2" }) }, env);
  assert.deepEqual(calls.filter((call) => call.method === "copyMessages").map((call) => call.payload.message_ids),
    [Array.from({ length: 10 }, (_, i) => i + 10)]);
  assert.equal((await db.prepare("SELECT captcha_pending_group FROM users").first()).captcha_pending_group, null);
  await processUpdate({ message: userMessage(21, { photo: [{}], media_group_id: "first" }) }, env);
  assert.deepEqual(calls.filter((call) => call.method === "copyMessages").at(-1).payload.message_ids, [21]);
  await processUpdate({ message: userMessage(10, { photo: [{}], media_group_id: "first" }) }, env);
  assert.equal(calls.filter((call) => call.method === "copyMessages").length, 2);
}));

test("首次暫存的 D1 批次失敗會完整回滾，重送後保存原訊息且不保存內容本體", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined };
  globalThis.fetch = async () => telegramResponse({ message_id: 700 });
  injectWriteFailure(db, (sql) => /INSERT OR IGNORE INTO media_groups/.test(sql));
  const request = () => auditRequest(9300, userMessage(10, { text: "不得存入 D1 的私人內容" }));
  assert.equal((await worker.fetch(request(), env)).status, 500);
  let user = await db.prepare("SELECT * FROM users").first();
  assert.equal(user.captcha_code, null);
  assert.equal(user.captcha_pending_group, null);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM media_group_messages").first()).n, 0);
  assert.equal((await worker.fetch(request(), env)).status, 200);
  user = await db.prepare("SELECT * FROM users").first();
  assert.ok(user.captcha_pending_group);
  const rows = await db.prepare("SELECT * FROM media_group_messages").all();
  assert.equal(rows.results[0].message_id, 10);
  assert.ok(!JSON.stringify([user, rows]).includes("不得存入 D1 的私人內容"));
}));

test("通過後第一則訊息狀態寫入失敗，重試沿用已保存對照而不重複複製", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined };
  let copies = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/copyMessages")) { copies++; return telegramResponse([{ message_id: 700 }]); }
    return telegramResponse(String(url).endsWith("/createForumTopic") ? { message_thread_id: 72 } : { message_id: 701 });
  };
  await processUpdate({ message: userMessage(10, { text: "第一則" }) }, env);
  db.database.exec("UPDATE users SET captcha_code=0; UPDATE media_groups SET updated_at_ms=updated_at_ms-1000");
  injectWriteFailure(db, (sql) => /UPDATE media_groups SET state = 'done'/.test(sql));
  const answer = () => auditRequest(9301, userMessage(11, { text: "2" }));
  assert.equal((await worker.fetch(answer(), env)).status, 500);
  assert.ok((await db.prepare("SELECT captcha_pending_group FROM users").first()).captcha_pending_group);
  assert.equal((await worker.fetch(answer(), env)).status, 200);
  assert.equal(copies, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM message_map").first()).n, 1);
  assert.equal((await db.prepare("SELECT captcha_pending_group FROM users").first()).captcha_pending_group, null);
}));

test("首次自動轉送失去更新租約時撤回副本，保留待送指標讓新租約恢復", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined };
  let copies = 0, rollbacks = 0, loseLease = true;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/copyMessages")) {
      copies++;
      if (loseLease) {
        loseLease = false;
        db.database.exec("UPDATE processed_updates SET status='failed',lease_token='replacement' WHERE update_id=9302");
      }
      return telegramResponse([{ message_id: 700 + copies }]);
    }
    if (String(url).endsWith("/deleteMessages")) rollbacks++;
    return telegramResponse(String(url).endsWith("/createForumTopic") ? { message_thread_id: 72 } : { message_id: 701 });
  };
  await processUpdate({ message: userMessage(10, { text: "第一則" }) }, env);
  db.database.exec("UPDATE users SET captcha_code=0; UPDATE media_groups SET updated_at_ms=updated_at_ms-1000");
  const answer = () => auditRequest(9302, userMessage(11, { text: "2" }));
  assert.equal((await worker.fetch(answer(), env)).status, 500);
  assert.ok((await db.prepare("SELECT captcha_pending_group FROM users").first()).captcha_pending_group);
  assert.equal((await db.prepare("SELECT state FROM media_groups").first()).state, "collecting");
  assert.equal((await worker.fetch(answer(), env)).status, 200);
  assert.equal(rollbacks, 1);
  assert.equal(copies, 2);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM message_map").first()).n, 1);
}));

test("原訊息已無法取得時保留驗證結果、釋放待送狀態，後續正常訊息仍可送達", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined }, calls = [];
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push({ method, payload: JSON.parse(init.body) });
    return telegramResponse(method === "copyMessages" ? [] : method === "createForumTopic"
      ? { message_thread_id: 72 } : { message_id: 700 });
  };
  await processUpdate({ message: userMessage(10, { text: "已被刪除的內容" }) }, env);
  db.database.exec("UPDATE users SET captcha_code=0; UPDATE media_groups SET updated_at_ms=updated_at_ms-1000");
  const response = await worker.fetch(auditRequest(9303, userMessage(11, { text: "2" })), env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).discarded, true);
  const user = await db.prepare("SELECT * FROM users").first();
  assert.equal(user.captcha_verified, 1);
  assert.equal(user.captcha_pending_group, null);
  await processUpdate({ message: userMessage(20, { text: "重新傳送內容" }) }, env);
  assert.equal(calls.at(-1).method, "copyMessage");
  assert.equal(calls.at(-1).payload.message_id, 20);
}));

test("舊版本尚未完成的題目沒有待送 ID 時不轉送舊答案，下一則內容採新流程", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined }, calls = [];
  seedAuditUser(db);
  await db.prepare("UPDATE users SET captcha_code=0,captcha_until=?,captcha_message_id=10")
    .bind(Math.floor(Date.now() / 1000) + 300).run();
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop(), payload = JSON.parse(init.body);
    calls.push({ method, payload });
    return telegramResponse(method === "copyMessages" ? [{ message_id: 700 }] : { message_id: 701 });
  };
  await processUpdate({ message: userMessage(11, { text: "2" }) }, env);
  assert.equal(calls.at(-1).payload.text, t("zh", "captchaExpired"));
  await processUpdate({ message: userMessage(12, { text: "新的聯絡內容" }) }, env);
  db.database.exec("UPDATE users SET captcha_code=0; UPDATE media_groups SET updated_at_ms=updated_at_ms-1000");
  await processUpdate({ message: userMessage(20, { text: "2" }) }, env);
  assert.deepEqual(calls.filter((call) => call.method === "copyMessages").map((call) => call.payload.message_ids), [[12]]);
}));

test("首次自動轉送期間清除資料會撤回副本，待送參照與路由都不能由舊工作重建", () => withDatabaseMock(async (db) => {
  const env = { ...auditEnv(db), CAPTCHA_ENABLED: undefined };
  let rollbacks = 0;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/copyMessages")) {
      await processUpdate({ message: userMessage(20, { text: "/forget confirm" }) }, env);
      return telegramResponse([{ message_id: 700 }]);
    }
    if (String(url).endsWith("/deleteMessages")) rollbacks++;
    return telegramResponse(String(url).endsWith("/createForumTopic") ? { message_thread_id: 72 } : { message_id: 701 });
  };
  await processUpdate({ message: userMessage(10, { text: "第一則" }) }, env);
  db.database.exec("UPDATE users SET captcha_code=0; UPDATE media_groups SET updated_at_ms=updated_at_ms-1000");
  await processUpdate({ message: userMessage(11, { text: "2" }) }, env);
  const user = await db.prepare("SELECT * FROM users").first();
  assert.equal(user.erased, 1);
  assert.equal(user.captcha_verified, 0);
  assert.equal(user.captcha_pending_group, null);
  assert.equal(rollbacks, 1);
  for (const table of ["message_map", "media_groups", "media_group_messages"]) {
    assert.equal((await db.prepare(`SELECT COUNT(*) n FROM ${table}`).first()).n, 0);
  }
}));

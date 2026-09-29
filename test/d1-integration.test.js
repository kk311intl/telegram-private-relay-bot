import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { processUpdate } from "../src/index.js";

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

  async run() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes) } };
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.values) || null;
  }

  async all() {
    return { success: true, results: this.database.prepare(this.sql).all(...this.values) };
  }
}

class TestD1 {
  constructor() {
    this.database = new DatabaseSync(":memory:");
    const migrationsUrl = new URL("../migrations/", import.meta.url);
    for (const migration of readdirSync(migrationsUrl).filter((name) => name.endsWith(".sql")).sort()) {
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
      for (const statement of statements) results.push(await statement.run());
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

function telegramResponse(result, status = 200) {
  return new Response(JSON.stringify(status === 200
    ? { ok: true, result }
    : { ok: false, error_code: status, description: "mock failure" }), {
    status,
    headers: { "content-type": "application/json" }
  });
}

test("管理者 /start 設定只對本人可見的模式專屬指令選單", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
    return telegramResponse(true);
  };
  try {
    await processUpdate({ message: {
      message_id: 1, chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false }, text: "/start"
    } }, { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", ADMIN_GROUP_ID: "-1001", BOT_DB: db });
    const menus = calls.filter((call) => call.method === "setMyCommands");
    assert.equal(menus.length, 2);
    assert.deepEqual(menus[0].payload.scope, { type: "chat", chat_id: "1" });
    assert.deepEqual(menus[0].payload.commands.map((item) => item.command), ["start", "help", "status", "unblock"]);
    assert.deepEqual(menus[1].payload.scope, { type: "chat_member", chat_id: "-1001", user_id: 1 });
    assert.deepEqual(menus[1].payload.commands.map((item) => item.command),
      ["help", "status", "user", "block", "unblock", "close"]);
    calls.length = 0;
    await processUpdate({ message: {
      message_id: 2, chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false }, text: "/start"
    } }, { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_DB: db });
    assert.deepEqual(calls.find((call) => call.method === "setMyCommands").payload.commands
      .map((item) => item.command), ["start", "help", "status", "user", "block", "unblock"]);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("管理者 /status 顯示近 24 小時更新與 Webhook 待處理數", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
  const calls = [];
  const now = Math.floor(Date.now() / 1000);
  globalThis.fetch = async (url, init) => {
    const method = String(url).split("/").pop();
    calls.push({ method, payload: JSON.parse(init.body) });
    return telegramResponse(method === "getWebhookInfo" ? { pending_update_count: 3 } : true);
  };
  try {
    await db.prepare(`INSERT INTO processed_updates(update_id, processed_at, status, attempts, updated_at)
      VALUES (1, ?, 'done', 1, ?), (2, ?, 'failed', 2, ?), (3, ?, 'discarded', 5, ?),
        (4, ?, 'done', 1, ?)`)
      .bind(now, now, now, now, now, now, now - 2 * 86400, now - 2 * 86400).run();
    const env = { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_DB: db };
    await processUpdate({ message: {
      message_id: 5, chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false }, text: "/status"
    } }, env);
    const text = calls.find((call) => call.method === "sendMessage").payload.text;
    assert.match(text, /已完成: 1/);
    assert.match(text, /等待重試: 1/);
    assert.match(text, /已放棄: 1/);
    assert.match(text, /待處理: 3/);
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
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("/forget 需確認並清除路由資料，封鎖者保留最小封鎖紀錄", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return telegramResponse({ message_id: sent.length });
  };
  try {
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
    const env = { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_DB: db };
    await processUpdate({ message: userMessage(1, { text: "/forget" }) }, env);
    assert.equal((await db.prepare("SELECT username FROM users WHERE user_id = '2'").first()).username, "old_name");
    await processUpdate({ message: userMessage(2, { text: "/forget confirm" }) }, env);
    await processUpdate({ message: userMessage(3, {
      chat: { id: 3, type: "private" }, from: { id: 3, is_bot: false }, text: "/forget confirm"
    }) }, env);
    assert.equal(await db.prepare("SELECT * FROM users WHERE user_id = '2'").first(), null);
    const blocked = await db.prepare("SELECT * FROM users WHERE user_id = '3'").first();
    assert.equal(blocked.blocked, 1);
    assert.equal(blocked.username, null);
    assert.equal(blocked.first_name, "");
    assert.equal(blocked.topic_id, null);
    assert.match(sent.at(-1).text, /ID 和封鎖狀態/);
    await processUpdate({ message: {
      message_id: 4, chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false }, text: "/unblock 3"
    } }, env);
    assert.equal(await db.prepare("SELECT * FROM users WHERE user_id = '3'").first(), null);
    for (const table of ["message_map", "media_groups", "media_group_messages"]) {
      assert.equal((await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first()).count, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("使用者歡迎訊息依部署語言，不依 Telegram 使用者語言", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push(JSON.parse(init.body).text);
    return telegramResponse({ message_id: sent.length });
  };
  try {
    for (const language of ["ja", "en"]) {
      await processUpdate({ message: userMessage(sent.length + 1, {
        text: "/start",
        from: { id: 2, is_bot: false, language_code: "zh" }
      }) }, { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_LANGUAGE: language, BOT_DB: db });
    }
    assert.match(sent[0], /こんにちは/);
    assert.match(sent[1], /Hello/);
    await processUpdate({ message: userMessage(3, { text: "/start" }) }, {
      BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_LANGUAGE: "en",
      WELCOME_MESSAGE: "Custom greeting", BOT_DB: db
    });
    assert.equal(sent[2], "Custom greeting");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("封鎖與無法轉送提示可由部署設定覆蓋", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  try {
    await db.prepare("INSERT INTO users(user_id, blocked, created_at, updated_at) VALUES ('2', 1, 0, 0)").run();
    await processUpdate({ message: userMessage(1, { text: "blocked" }) }, env);
    assert.ok(calls.some((call) => call.payload.text === "Contact support"));
    await db.prepare("UPDATE users SET blocked = 0 WHERE user_id = '2'").run();
    await assert.rejects(processUpdate({ message: userMessage(2, { text: "unsupported" }) }, env));
    assert.ok(calls.some((call) => call.payload.text === "Use plain text"));
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("相簿聚合後只呼叫一次 copyMessages 並保存每則映射", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  try {
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
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("逾期的相簿處理 lease 可由重試接手", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  try {
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
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("同使用者併發訊息只建立一個 Topic", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  try {
    await Promise.all([
      processUpdate({ message: userMessage(20, { text: "一" }) }, env),
      processUpdate({ message: userMessage(21, { text: "二" }) }, env)
    ]);
    assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
    assert.equal(calls.filter((call) => call.method === "copyMessage").length, 2);
    const user = await db.prepare("SELECT topic_id FROM users WHERE user_id = '2'").first();
    assert.equal(user.topic_id, 88);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("原子節流會拒絕同秒的第二則一般訊息", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  try {
    await Promise.all([
      processUpdate({ message: userMessage(30, { text: "第一則" }) }, env),
      processUpdate({ message: userMessage(31, { text: "第二則" }) }, env)
    ]);
    assert.equal(calls.filter((call) => call.method === "copyMessage").length, 1);
    assert.equal(calls.filter((call) => call.payload.text === "Please wait").length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("永久 Telegram 錯誤會記錄 discarded 並停止重試", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
  try {
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
      BOT_DB: db
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, discarded: true });
    const stored = await db.prepare(
      "SELECT status, attempts FROM processed_updates WHERE update_id = 4001"
    ).first();
    assert.equal(stored.status, "discarded");
    assert.equal(stored.attempts, 1);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("暫時 Telegram 錯誤會記錄 failed 並允許後續重試", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  const request = () => new Request("https://example.test/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": "valid-secret"
    },
    body: JSON.stringify(update)
  });
  try {
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
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("Telegram 429 會回傳有上限的 Retry-After", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
  try {
    const response = await worker.fetch(new Request("https://example.test/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": "valid-secret" },
      body: JSON.stringify(update)
    }), {
      BOT_TOKEN: "test-token",
      WEBHOOK_SECRET: "valid-secret",
      ADMIN_USER_ID: "1",
      BOT_DB: db
    });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("retry-after"), "3600");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("未知管理指令只回提示，不會誤傳給使用者", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
  await db.prepare(`
    INSERT INTO users(user_id, first_name, topic_id, created_at, updated_at)
    VALUES ('2', '測試者', 77, 1, 1)
  `).run();
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: String(url).split("/").pop(), payload: JSON.parse(init.body) });
    return telegramResponse({ message_id: 1 });
  };
  try {
    await processUpdate({
      message: {
        message_id: 70,
        message_thread_id: 77,
        is_topic_message: true,
        chat: { id: -1001, type: "supergroup", is_forum: true },
        from: { id: 1, is_bot: false },
        text: "/blok"
      }
    }, { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", ADMIN_GROUP_ID: "-1001", BOT_DB: db });
    assert.equal(calls.some((call) => call.method === "copyMessage"), false);
    assert.equal(calls.length, 1);
    assert.match(calls[0].payload.text, /未知指令/);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("私聊備用模式會沿用最近對話，不重複產生身分標頭", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  try {
    await processUpdate({ message: userMessage(80, { text: "第一則" }) }, env);
    await processUpdate({ message: userMessage(81, { text: "第二則" }) }, env);
    const headerCalls = calls.filter((call) => call.method === "sendMessage");
    const copyCalls = calls.filter((call) => call.method === "copyMessage");
    assert.equal(headerCalls.length, 1);
    assert.equal(copyCalls.length, 2);
    assert.equal(copyCalls[1].payload.reply_parameters.message_id, copyCalls[0].result.message_id);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("相簿處理期間晚到的項目會改為單則補送", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  try {
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
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("相簿部分複製時會刪除已送出的孤立訊息", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  try {
    await assert.rejects(Promise.all([
      processUpdate({ message: userMessage(100, { media_group_id: "partial-album", photo: [{}] }) }, env),
      processUpdate({ message: userMessage(101, { media_group_id: "partial-album", photo: [{}] }) }, env)
    ]), /Telegram 未完整複製相簿/);
    const rollback = calls.find((call) => call.method === "deleteMessages");
    assert.deepEqual(rollback.payload.message_ids, [700]);
    assert.equal((await db.prepare("SELECT COUNT(*) AS count FROM message_map").first()).count, 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("使用者指令不會消耗一般訊息節流額度", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  try {
    await processUpdate({ message: userMessage(110, { text: "/start" }) }, env);
    await processUpdate({ message: userMessage(111, { text: "緊接著的訊息" }) }, env);
    assert.equal(calls.filter((call) => call.method === "copyMessage").length, 1);
    assert.equal(calls.some((call) => call.payload.text === "訊息傳送過快，請稍後再試。"), false);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("可重試錯誤超過上限後會轉為 discarded", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  const request = () => new Request("https://example.test/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "valid-secret" },
    body: JSON.stringify(update)
  });
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal((await worker.fetch(request(), env)).status, 500);
    }
    const exhausted = await worker.fetch(request(), env);
    assert.equal(exhausted.status, 200);
    assert.deepEqual(await exhausted.json(), { ok: true, discarded: true });
    assert.equal(calls, 5);
    assert.equal((await db.prepare(
      "SELECT status FROM processed_updates WHERE update_id = 6001"
    ).first()).status, "discarded");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("編輯事件早於原訊息時會要求重試並在映射建立後同步", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  const edited = {
    edited_message: userMessage(130, { text: "編輯後", entities: [] })
  };
  try {
    await assert.rejects(processUpdate(edited, env), /尚未建立轉送映射/);
    await processUpdate({ message: userMessage(130, { text: "原訊息" }) }, env);
    await processUpdate(edited, env);
    const editCall = calls.find((call) => call.method === "editMessageText");
    assert.equal(editCall.payload.chat_id, "-1001");
    assert.equal(editCall.payload.text, "編輯後");
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

test("Topic 資料卡暫時失敗後會沿用原 Topic 補送", async () => {
  const originalFetch = globalThis.fetch;
  const db = new TestD1();
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
    BOT_DB: db
  };
  const update = { message: userMessage(140, { text: "需要補卡" }) };
  try {
    await assert.rejects(processUpdate(update, env), /mock failure/);
    await processUpdate(update, env);
    assert.equal(calls.filter((call) => call.method === "createForumTopic").length, 1);
    assert.equal(cardAttempts, 2);
    const user = await db.prepare(
      "SELECT topic_id, topic_card_message_id FROM users WHERE user_id = '2'"
    ).first();
    assert.equal(user.topic_id, 92);
    assert.ok(user.topic_card_message_id > 0);
  } finally {
    globalThis.fetch = originalFetch;
    db.close();
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import worker, {
  configurationIssue,
  processDirectAdminReply,
  processUpdate
} from "../src/index.js";

const context = { waitUntil() {} };

test("health 只回傳非敏感服務狀態", async () => {
  const response = await worker.fetch(new Request("https://example.test/health"), {}, context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "telegram-private-relay" });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("未知路徑不公開管理功能", async () => {
  const response = await worker.fetch(new Request("https://example.test/initDatabase"), {}, context);
  assert.equal(response.status, 404);
});

test("Webhook 設定不完整時拒絕服務", async () => {
  const response = await worker.fetch(new Request("https://example.test/webhook", {
    method: "POST"
  }), {}, context);
  assert.equal(response.status, 503);
});

test("Webhook Secret 錯誤時不接觸資料庫", async () => {
  let touchedDatabase = false;
  const env = {
    BOT_TOKEN: "bot-token",
    WEBHOOK_SECRET: "correct-secret",
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001",
    BOT_DB: {
      prepare() {
        touchedDatabase = true;
        throw new Error("不應接觸資料庫");
      }
    }
  };
  const response = await worker.fetch(new Request("https://example.test/webhook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "wrong-secret" }
  }), env, context);
  assert.equal(response.status, 403);
  assert.equal(touchedDatabase, false);
});

test("已授權 Webhook 拒絕非物件 JSON", async () => {
  const env = {
    BOT_TOKEN: "bot-token",
    WEBHOOK_SECRET: "correct-secret",
    ADMIN_USER_ID: "1",
    BOT_DB: { prepare() { throw new Error("不應接觸資料庫"); } }
  };
  for (const body of ["null", "[]"]) {
    const response = await worker.fetch(new Request("https://example.test/webhook", {
      method: "POST",
      headers: { "X-Telegram-Bot-Api-Secret-Token": env.WEBHOOK_SECRET },
      body
    }), env, context);
    assert.equal(response.status, 400);
  }
});

test("ready 不洩漏缺少的設定名稱", async () => {
  const response = await worker.fetch(new Request("https://example.test/ready"), {}, context);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, service: "telegram-private-relay" });
});

test("設定驗證拒絕空白或格式錯誤的管理 ID", () => {
  const base = {
    BOT_TOKEN: "token",
    WEBHOOK_SECRET: "valid-secret",
    BOT_DB: { prepare() {} }
  };
  assert.equal(configurationIssue({ ...base, ADMIN_USER_ID: " " }), "ADMIN_USER_ID");
  assert.equal(configurationIssue({ ...base, ADMIN_USER_ID: "1", ADMIN_GROUP_ID: "group" }), "ADMIN_GROUP_ID");
  assert.equal(configurationIssue({ ...base, ADMIN_USER_ID: "1", ADMIN_GROUP_ID: "" }), null);
  assert.equal(configurationIssue({ ...base, ADMIN_USER_ID: "1", BOT_LANGUAGE: "fr" }), "BOT_LANGUAGE");
  assert.equal(configurationIssue({ ...base, ADMIN_USER_ID: "1", BOT_LANGUAGE: "ja" }), null);
  assert.equal(configurationIssue({ ...base, ADMIN_USER_ID: "1", WELCOME_MESSAGE: "x".repeat(4097) }), "WELCOME_MESSAGE");
  assert.equal(configurationIssue({ ...base, ADMIN_USER_ID: "1", BLOCKED_MESSAGE: "短訊息" }), null);
});

test("非指定群組的更新直接忽略", async () => {
  await processUpdate({
    update_id: 1,
    message: {
      message_id: 2,
      chat: { id: -1002, type: "supergroup", is_forum: true },
      from: { id: 9, is_bot: false },
      text: "不應處理"
    }
  }, {
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001"
  });
});

test("指定群組中的非管理者訊息直接忽略", async () => {
  await processUpdate({
    update_id: 1,
    message: {
      message_id: 2,
      message_thread_id: 3,
      chat: { id: -1001, type: "supergroup", is_forum: true },
      from: { id: 9, is_bot: false },
      text: "不應轉送"
    }
  }, {
    ADMIN_USER_ID: "1",
    ADMIN_GROUP_ID: "-1001"
  });
});

test("未設定管理群組時，管理者仍可使用 /start", async () => {
  const originalFetch = globalThis.fetch;
  let sentPayload;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/sendMessage")) sentPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    await processUpdate({
      message: {
        message_id: 2,
        chat: { id: 1, type: "private" },
        from: { id: 1, is_bot: false },
        text: "/start"
      }
    }, {
      BOT_TOKEN: "test-token",
      ADMIN_USER_ID: "1"
    });
    assert.match(sentPayload.text, /管理者私聊備用模式/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("管理者回覆依部署語言，不依 Telegram 使用者語言", async () => {
  const originalFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/sendMessage")) sent.push(JSON.parse(init.body).text);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  try {
    for (const language of ["ja", "en"]) {
      await processUpdate({ message: {
        message_id: 2,
        chat: { id: 1, type: "private" },
        from: { id: 1, is_bot: false, language_code: "zh" },
        text: "/start"
      } }, { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_LANGUAGE: language });
    }
    assert.match(sent[0], /管理者との直接チャットモード/);
    assert.match(sent[1], /direct-admin mode/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("只有管理者可在話題群組使用 /setup 查詢群組 ID", async () => {
  const originalFetch = globalThis.fetch;
  let sentPayload;
  globalThis.fetch = async (_url, init) => {
    sentPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    await processUpdate({
      message: {
        message_id: 3,
        message_thread_id: 7,
        chat: { id: -1001234567890, type: "supergroup", is_forum: true },
        from: { id: 1, is_bot: false },
        text: "/setup"
      }
    }, {
      BOT_TOKEN: "test-token",
      ADMIN_USER_ID: "1"
    });
    assert.equal(sentPayload.chat_id, -1001234567890);
    assert.match(sentPayload.text, /-1001234567890/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("已設定舊管理群組時仍可在新群組查詢 /setup", async () => {
  const originalFetch = globalThis.fetch;
  let sentPayload;
  globalThis.fetch = async (_url, init) => {
    sentPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    await processUpdate({
      message: {
        message_id: 4,
        message_thread_id: 8,
        chat: { id: -1002222222222, type: "supergroup", is_forum: true },
        from: { id: 1, is_bot: false },
        text: "/setup"
      }
    }, {
      BOT_TOKEN: "test-token",
      ADMIN_USER_ID: "1",
      ADMIN_GROUP_ID: "-1001111111111"
    });
    assert.equal(sentPayload.chat_id, -1002222222222);
    assert.match(sentPayload.text, /-1002222222222/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("私聊備用模式只把管理者對應回覆送給原使用者", async () => {
  const originalFetch = globalThis.fetch;
  let copiedPayload;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/copyMessage")) copiedPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 88 } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const db = {
    async batch(statements) { return Promise.all(statements.map((statement) => statement.run())); },
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("SELECT target_chat_id, target_message_id, user_id")) {
                return null;
              }
              if (sql.includes("SELECT source_message_id, user_id")) {
                return { source_message_id: 12, user_id: "2" };
              }
              if (sql.includes("FROM users")) {
                return { user_id: "2", first_name: "使用者", last_name: "", blocked: 0 };
              }
              return null;
            },
            async run() {
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
  try {
    await processDirectAdminReply({
      message_id: 20,
      chat: { id: 1, type: "private" },
      from: { id: 1, is_bot: false },
      reply_to_message: { message_id: 10 },
      text: "回覆內容"
    }, {
      BOT_TOKEN: "test-token",
      ADMIN_USER_ID: "1",
      BOT_DB: db
    });
    assert.equal(copiedPayload.chat_id, "2");
    assert.equal(copiedPayload.reply_parameters.message_id, 12);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("封鎖後編輯舊訊息不會同步", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("不應呼叫 Telegram");
  };
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes("FROM message_map")) {
                return { target_chat_id: "-1001", target_message_id: 9, user_id: "2" };
              }
              if (sql.includes("FROM users")) return { user_id: "2", blocked: 1 };
              return null;
            }
          };
        }
      };
    }
  };
  try {
    await processUpdate({
      edited_message: {
        message_id: 4,
        chat: { id: 2, type: "private" },
        from: { id: 2, is_bot: false },
        text: "封鎖後的新內容"
      }
    }, { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", ADMIN_GROUP_ID: "-1001", BOT_DB: db });
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("私聊備用模式會同步管理者編輯", async () => {
  const originalFetch = globalThis.fetch;
  let calledMethod;
  let sentPayload;
  globalThis.fetch = async (url, init) => {
    calledMethod = String(url).split("/").pop();
    sentPayload = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return { target_chat_id: "2", target_message_id: 10, user_id: "2" };
            }
          };
        }
      };
    }
  };
  try {
    await processUpdate({
      edited_message: {
        message_id: 8,
        chat: { id: 1, type: "private" },
        from: { id: 1, is_bot: false },
        text: "修正後回覆",
        entities: []
      }
    }, { BOT_TOKEN: "test-token", ADMIN_USER_ID: "1", BOT_DB: db });
    assert.equal(calledMethod, "editMessageText");
    assert.equal(sentPayload.chat_id, "2");
    assert.equal(sentPayload.text, "修正後回覆");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

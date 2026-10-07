import test from "node:test";
import assert from "node:assert/strict";
import {
  buildTopicName,
  buildUserCard,
  clampInteger,
  escapeHtml,
  parseCommand,
  truncate
} from "../src/index.js";
import { t } from "../src/i18n.js";

test("parseCommand 支援 bot 後綴並忽略參數", () => {
  assert.equal(parseCommand("/BLOCK@MyBot now"), "block");
  assert.equal(parseCommand("一般訊息"), null);
});

test("buildTopicName 限制名稱長度", () => {
  const name = buildTopicName({ id: 123, first_name: "測".repeat(140) });
  assert.equal(Array.from(name).length, 128);
  assert.ok(name.endsWith("…"));
});

test("buildTopicName 移除換行與雙向控制字元", () => {
  const name = buildTopicName({ id: 123, first_name: "管理\n者\u202e假名" });
  assert.equal(name, "管理 者 假名 · 123");
});

test("buildUserCard 會跳脫 Telegram HTML", () => {
  const card = buildUserCard({ id: 123, first_name: "<測試>", username: "a&b" });
  assert.match(card, /&lt;測試&gt;/);
  assert.match(card, /@a&amp;b/);
  assert.doesNotMatch(card, /<測試>/);
});

test("部署語言控制資料卡和預設名稱", () => {
  assert.match(buildUserCard({ id: 123 }, "ja"), /新しい個別チャット/);
  assert.match(buildUserCard({ id: 123 }, "en"), /New private chat/);
  assert.equal(buildTopicName({ id: 123 }, "en"), "User · 123");
});

test("三種部署語言都有完整的訊息文字", () => {
  const keys = Object.keys({
    adminReadyTopic: 1, adminReadyDirect: 1, blockedNotice: 1, welcome: 1,
    userId: 1, rateLimit: 1, blocked: 1, unblocked: 1, unknownCommand: 1,
    adminHelpTopic: 1, adminHelpDirect: 1, adminStatus: 1, statusDone: 1,
    statusFailed: 1, statusDiscarded: 1, statusPending: 1, statusProcessing: 1,
    statusStalled: 1, unknown: 1, notBlocked: 1,
    forgetConfirm: 1, forgetDone: 1, command_start: 1, command_help: 1,
    command_status: 1, command_user: 1, command_block: 1,
    command_unblock: 1, command_close: 1,
    unsupportedMessage: 1, deliveryFailed: 1, albumFailed: 1, untrackedDelivery: 1,
    groupId: 1, newChat: 1, receivedChat: 1, userDetails: 1, name: 1,
    username: 1, status: 1, blockedStatus: 1, normalStatus: 1,
    notSet: 1, notProvided: 1, user: 1, fieldSeparator: 1
  });
  for (const language of ["zh", "ja", "en"]) {
    for (const key of keys) assert.ok(t(language, key), `${language}.${key}`);
  }
  assert.equal(t(undefined, "welcome"), t("zh", "welcome"));
});

test("三語資料卡使用對應標點並保留 HTML 跳脫", () => {
  for (const language of ["zh", "ja", "en"]) {
    const separator = language === "en" ? ": " : "：";
    const card = buildUserCard({ id: 123, first_name: "<Example>", username: "a&b" }, language);
    assert.equal(t(language, "fieldSeparator"), separator);
    assert.ok(card.includes(`User ID${separator}<code>123</code>`));
    assert.ok(card.includes(`${t(language, "name")}${separator}&lt;Example&gt;`));
    assert.ok(card.includes(`${t(language, "username")}${separator}@a&amp;b`));
    if (language === "en") assert.doesNotMatch(card, /：/);
  }
});

test("三語操作提示分行並保留資料清除的安全範圍", () => {
  const limits = {
    zh: [/不會刪除|不會刪/, /備份/, /不會解除封鎖/, /User ID/, /舊請求/, /7 天.*排程/, /新訊息/],
    ja: [/削除しません/, /バックアップ/, /ブロックは解除されません/, /User ID/, /古いリクエスト/, /7日後.*定期処理/, /新しいメッセージ/],
    en: [/not deleted/, /backups/, /block remains/, /User ID/, /old requests/, /scheduled cleanup.*7 days/, /new messages/]
  };
  for (const language of ["zh", "ja", "en"]) {
    for (const key of ["adminHelpTopic", "adminHelpDirect"]) {
      const help = t(language, key);
      for (const command of ["user", "block", "unblock", "status"]) {
        assert.match(help, new RegExp(`^/${command} — `, "m"));
      }
      assert.match(help, /^\/unblock USER_ID — /m);
    }
    assert.match(t(language, "adminHelpTopic"), /^\/close — /m);
    assert.doesNotMatch(t(language, "adminHelpDirect"), /\/close/);
    assert.match(t(language, "forgetConfirm"), /\/forget confirm/);
    for (const key of ["forgetConfirm", "forgetDone"]) {
      const text = t(language, key);
      assert.ok(text.includes("\n\n"));
      assert.ok(text.includes("Telegram"));
      for (const limit of limits[language]) assert.match(text, limit);
    }
    assert.doesNotMatch(t(language, "adminStatus"), /D1/);
  }
  assert.match(t("en", "forgetConfirm"), /stores about you/);
  assert.doesNotMatch(t("en", "welcome"), /\bwe\b|we'll/i);
});

test("escapeHtml 跳脫特殊字元", () => {
  assert.equal(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;");
});

test("truncate 不拆散 Unicode 字元", () => {
  assert.equal(truncate("甲乙丙丁", 3), "甲乙…");
});

test("clampInteger 套用範圍與預設值", () => {
  assert.equal(clampInteger("99", 0, 60, 2), 60);
  assert.equal(clampInteger("bad", 0, 60, 2), 2);
});

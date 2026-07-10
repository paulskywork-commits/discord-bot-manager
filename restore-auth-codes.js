const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MODE = process.env.MODE || "normal";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || "";
const RESTORE_DM_USER_ID = process.env.RESTORE_DM_USER_ID || "";
const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL || "";

const RESTORE_PLAN_FILE = process.env.RESTORE_PLAN_FILE || "plans/restore-plan-latest.json";

const AUTH_DIR = "restore-auth";
const AUTH_TTL_MINUTES = Number(process.env.AUTH_TTL_MINUTES || "10");

function berlinTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date).replace(" ", "T");
}

function fileStamp(date = new Date()) {
  return berlinTimestamp(date).replace("T", "-").replace(/:/g, "-");
}

function requireValue(value, name) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function createCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";

  for (let i = 0; i < 10; i++) {
    code += alphabet[crypto.randomInt(0, alphabet.length)];
  }

  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hashCode(code, salt) {
  return sha256(`${salt}:${code}`);
}

function readRestorePlan() {
  if (!fs.existsSync(RESTORE_PLAN_FILE)) {
    throw new Error(`Restore Plan file not found: ${RESTORE_PLAN_FILE}`);
  }

  return JSON.parse(fs.readFileSync(RESTORE_PLAN_FILE, "utf8"));
}

function shortPlanSummary(plan) {
  const summary = plan.summary || {};

  return {
    actions_total: summary.actions_total ?? 0,
    create_missing_roles: summary.create_missing_roles ?? 0,
    create_missing_channels: summary.create_missing_channels ?? 0,
    restore_missing_bans: summary.restore_missing_bans ?? 0,
    review_changed_roles: summary.review_changed_roles ?? 0,
    review_changed_channels: summary.review_changed_channels ?? 0
  };
}

async function discordApi(endpoint, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, {
    ...options,
    headers: {
      "Authorization": `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Discord API error ${response.status}: ${text}`);
  }

  if (!text) {
    return null;
  }

  return JSON.parse(text);
}

async function sendDiscordDm(userId, content) {
  const dmChannel = await discordApi("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({
      recipient_id: userId
    })
  });

  await discordApi(`/channels/${dmChannel.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      allowed_mentions: {
        parse: []
      }
    })
  });
}

async function sendWebhook(content) {
  if (!LOG_WEBHOOK_URL) {
    console.log("No LOG_WEBHOOK_URL set. Skipping webhook log.");
    return;
  }

  const response = await fetch(LOG_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      username: "Bot Manager Log",
      content,
      allowed_mentions: {
        parse: []
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Log Webhook error ${response.status}: ${errorText}`);
  }
}

function createAuthorization(plan) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + AUTH_TTL_MINUTES * 60 * 1000);

  const authId = `restore-auth-${fileStamp(now)}-${crypto.randomBytes(4).toString("hex")}`;

  const codeA = createCode();
  const codeB = createCode();

  const saltA = crypto.randomBytes(32).toString("hex");
  const saltB = crypto.randomBytes(32).toString("hex");

  const authData = {
    metadata: {
      auth_id: authId,
      created_at_utc: now.toISOString(),
      created_at_berlin: berlinTimestamp(now),
      expires_at_utc: expiresAt.toISOString(),
      expires_at_berlin: berlinTimestamp(expiresAt),
      ttl_minutes: AUTH_TTL_MINUTES,
      mode: "restore-authorization-only",
      warning: "No Discord restore was executed. This file only stores hashed authorization codes."
    },
    source: {
      restore_plan_file: RESTORE_PLAN_FILE,
      plan_summary: shortPlanSummary(plan)
    },
    status: {
      used: false,
      used_at_utc: null,
      used_at_berlin: null,
      revoked: false,
      revoked_at_utc: null,
      revoked_at_berlin: null
    },
    verification: {
      code_a: {
        delivery: "discord_dm",
        recipient_user_id: RESTORE_DM_USER_ID,
        hash_algorithm: "sha256",
        salt: saltA,
        hash: hashCode(codeA, saltA)
      },
      code_b: {
        delivery: "admin_log_channel",
        hash_algorithm: "sha256",
        salt: saltB,
        hash: hashCode(codeB, saltB)
      }
    },
    safety_rules: {
      plaintext_codes_are_not_saved: true,
      restore_execute_must_check_expiry: true,
      restore_execute_must_check_used_status: true,
      restore_execute_must_mark_auth_as_used_before_changes: true,
      rerun_should_fail_after_auth_is_used: true
    }
  };

  return {
    authData,
    authId,
    codeA,
    codeB,
    expiresAt
  };
}

function writeAuthorization(authData) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });

  const authId = authData.metadata.auth_id;

  const datedPath = path.join(AUTH_DIR, `${authId}.json`);
  const latestPath = path.join(AUTH_DIR, "restore-auth-latest.json");

  const jsonText = JSON.stringify(authData, null, 2) + "\n";

  fs.writeFileSync(datedPath, jsonText, "utf8");
  fs.writeFileSync(latestPath, jsonText, "utf8");

  return {
    datedPath,
    latestPath
  };
}

async function runTestMode() {
  const berlinTime = berlinTimestamp();

  await sendWebhook(
    `🧪 **Restore Auth Codes TEST completed**\n\nPassword check passed.\nNo Discord changes were made.\nNo codes were generated.\nNo DM was sent.\nNo authorization file was created.\nNo GitHub files were changed.\n\nSelected plan file: ${RESTORE_PLAN_FILE}\nTime: ${berlinTime} Europe/Berlin`
  );

  console.log("Restore Auth Codes test mode completed.");
}

async function runNormalMode() {
  requireValue(DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN");
  requireValue(RESTORE_DM_USER_ID, "RESTORE_DM_USER_ID");
  requireValue(LOG_WEBHOOK_URL, "LOG_WEBHOOK_URL");

  const plan = readRestorePlan();
  const summary = shortPlanSummary(plan);

  const authorization = createAuthorization(plan);
  const files = writeAuthorization(authorization.authData);

  const dmMessage =
    `🔐 **Restore Authorization Code A**\n\n` +
    `Code A:\n` +
    `\`${authorization.codeA}\`\n\n` +
    `Auth ID:\n` +
    `\`${authorization.authId}\`\n\n` +
    `Expires:\n` +
    `${berlinTimestamp(authorization.expiresAt)} Europe/Berlin\n\n` +
    `This code alone cannot execute a restore. Code B and the restore password are also required.`;

  const adminMessage =
    `🔐 **Restore Authorization Code B**\n\n` +
    `Code B:\n` +
    `\`${authorization.codeB}\`\n\n` +
    `Auth ID:\n` +
    `\`${authorization.authId}\`\n\n` +
    `Restore plan:\n` +
    `${RESTORE_PLAN_FILE}\n\n` +
    `Planned actions: ${summary.actions_total}\n` +
    `Create missing roles: ${summary.create_missing_roles}\n` +
    `Create missing channels: ${summary.create_missing_channels}\n` +
    `Restore missing bans: ${summary.restore_missing_bans}\n` +
    `Review changed roles: ${summary.review_changed_roles}\n` +
    `Review changed channels: ${summary.review_changed_channels}\n\n` +
    `Authorization file:\n` +
    `${files.latestPath}\n\n` +
    `Expires:\n` +
    `${berlinTimestamp(authorization.expiresAt)} Europe/Berlin\n\n` +
    `No Discord restore was executed.`;

  await sendDiscordDm(RESTORE_DM_USER_ID, dmMessage);
  await sendWebhook(adminMessage);

  console.log(`Restore authorization created: ${files.datedPath}`);
  console.log(`Latest restore authorization written: ${files.latestPath}`);
  console.log(`Auth ID: ${authorization.authId}`);
  console.log("Plaintext codes were not printed or saved.");
}

async function main() {
  try {
    if (MODE === "test") {
      await runTestMode();
      return;
    }

    if (MODE === "normal") {
      await runNormalMode();
      return;
    }

    throw new Error(`Unknown MODE: ${MODE}`);
  } catch (error) {
    console.error(error.message);

    try {
      await sendWebhook(
        `❌ **Restore Auth Codes failed**\n\n${error.message}\n\nTime: ${berlinTimestamp()} Europe/Berlin`
      );
    } catch (logError) {
      console.error("Could not send failure log:", logError.message);
    }

    process.exit(1);
  }
}

main();

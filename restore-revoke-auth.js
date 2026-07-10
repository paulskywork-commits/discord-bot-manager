const fs = require("fs");
const path = require("path");

const MODE = process.env.MODE || "normal";
const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL || "";

const AUTH_FILE = process.env.AUTH_FILE || "restore-auth/restore-auth-latest.json";
const REVOKE_REASON = process.env.REVOKE_REASON || "No reason provided.";

const AUTH_DIR = "restore-auth";

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

function requireValue(value, name) {
  if (!value) {
    throw new Error(`Missing required value: ${name}`);
  }
}

function validateAuthFilePath(filePath) {
  requireValue(filePath, "AUTH_FILE");

  const normalized = path.normalize(filePath);

  if (path.isAbsolute(normalized) || normalized.startsWith("..")) {
    throw new Error("AUTH_FILE must be a relative path inside restore-auth/.");
  }

  if (!normalized.startsWith(`${AUTH_DIR}${path.sep}`)) {
    throw new Error(`AUTH_FILE must start with ${AUTH_DIR}/`);
  }

  if (!normalized.endsWith(".json")) {
    throw new Error("AUTH_FILE must be a .json file.");
  }

  return normalized;
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Authorization file not found: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  const jsonText = JSON.stringify(data, null, 2) + "\n";
  fs.writeFileSync(filePath, jsonText, "utf8");
}

function listAuthJsonFiles() {
  if (!fs.existsSync(AUTH_DIR)) {
    throw new Error(`Authorization directory not found: ${AUTH_DIR}`);
  }

  return fs.readdirSync(AUTH_DIR)
    .filter(file => file.endsWith(".json"))
    .map(file => path.join(AUTH_DIR, file));
}

function markRevoked(authData) {
  const now = new Date();

  authData.status = authData.status || {};
  authData.status.revoked = true;
  authData.status.revoked_at_utc = now.toISOString();
  authData.status.revoked_at_berlin = berlinTimestamp(now);
  authData.status.revoke_reason = REVOKE_REASON;

  authData.status.revoked_note = "Authorization was revoked. Restore Execute must reject this authorization.";

  authData.safety_rules = authData.safety_rules || {};
  authData.safety_rules.restore_execute_must_check_revoked_status = true;

  return authData;
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

async function runTestMode() {
  const authFile = validateAuthFilePath(AUTH_FILE);

  await sendWebhook(
    `🧪 **Restore Auth Revoke TEST completed**\n\n` +
    `Password check passed.\nNo Discord changes were made.\nNo authorization file was changed.\nNo GitHub files were changed.\n\n` +
    `Selected auth file: ${authFile}\n` +
    `Reason: ${REVOKE_REASON}\n\n` +
    `Time: ${berlinTimestamp()} Europe/Berlin`
  );

  console.log("Restore Auth Revoke test mode completed.");
}

async function runNormalMode() {
  const authFile = validateAuthFilePath(AUTH_FILE);
  const selectedAuth = readJson(authFile);

  const authId = selectedAuth.metadata?.auth_id;

  if (!authId) {
    throw new Error("Selected authorization file has no metadata.auth_id.");
  }

  const matchingFiles = [];

  for (const file of listAuthJsonFiles()) {
    try {
      const data = readJson(file);

      if (data.metadata?.auth_id === authId) {
        const updated = markRevoked(data);
        writeJson(file, updated);
        matchingFiles.push(file);
      }
    } catch (error) {
      console.log(`Skipping unreadable auth file ${file}: ${error.message}`);
    }
  }

  if (matchingFiles.length === 0) {
    throw new Error(`No authorization files found for auth_id: ${authId}`);
  }

  const updatedSelectedAuth = readJson(authFile);
  const planFile = updatedSelectedAuth.source?.restore_plan_file || "unknown";

  await sendWebhook(
    `🚫 **Restore Authorization revoked**\n\n` +
    `No Discord changes were made.\nNo restore was executed.\n\n` +
    `Auth ID: ${authId}\n` +
    `Selected auth file: ${authFile}\n` +
    `Matching files updated: ${matchingFiles.length}\n` +
    `Restore plan: ${planFile}\n\n` +
    `Reason: ${REVOKE_REASON}\n\n` +
    `This authorization can no longer be used for Restore Execute.\n\n` +
    `Time: ${berlinTimestamp()} Europe/Berlin`
  );

  console.log("Restore authorization revoked.");
  console.log(`Auth ID: ${authId}`);
  console.log(`Updated files: ${matchingFiles.join(", ")}`);
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
        `❌ **Restore Auth Revoke failed**\n\n` +
        `${error.message}\n\n` +
        `No Discord changes were made.\nNo restore was executed.\n\n` +
        `Time: ${berlinTimestamp()} Europe/Berlin`
      );
    } catch (logError) {
      console.error("Could not send failure log:", logError.message);
    }

    process.exit(1);
  }
}

main();

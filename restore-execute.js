const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MODE = process.env.MODE || "test";

const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL || "";

const AUTH_FILE = process.env.AUTH_FILE || "restore-auth/restore-auth-latest.json";
const CODE_A = process.env.CODE_A || "";
const CODE_B = process.env.CODE_B || "";
const CONFIRM_TEXT = process.env.CONFIRM_TEXT || "";

const MASTER_PASSWORD = process.env.MASTER_PASSWORD || "";
const RESTORE_MASTER_PASSWORD = process.env.RESTORE_MASTER_PASSWORD || "";

const EXPECTED_CONFIRM_TEXT = process.env.EXPECTED_CONFIRM_TEXT || "RESTORE_EXECUTE_TEST";

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

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function hashCode(code, salt) {
  return sha256(`${salt}:${code}`);
}

function safeEqualHex(a, b) {
  const bufferA = Buffer.from(a || "", "hex");
  const bufferB = Buffer.from(b || "", "hex");

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

function safeEqualText(a, b) {
  const bufferA = Buffer.from(a || "", "utf8");
  const bufferB = Buffer.from(b || "", "utf8");

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufferA, bufferB);
}

function readAuthFile() {
  if (!fs.existsSync(AUTH_FILE)) {
    throw new Error(`Authorization file not found: ${AUTH_FILE}`);
  }

  return JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
}

function writeAuthFile(authData) {
  const jsonText = JSON.stringify(authData, null, 2) + "\n";

  fs.writeFileSync(AUTH_FILE, jsonText, "utf8");

  const latestPath = path.join(path.dirname(AUTH_FILE), "restore-auth-latest.json");

  if (AUTH_FILE !== latestPath && fs.existsSync(latestPath)) {
    fs.writeFileSync(latestPath, jsonText, "utf8");
  }
}

function verifyConfirmText() {
  if (CONFIRM_TEXT !== EXPECTED_CONFIRM_TEXT) {
    throw new Error(`Wrong confirm text. Expected: ${EXPECTED_CONFIRM_TEXT}`);
  }
}

function verifyMasterPassword() {
  requireValue(MASTER_PASSWORD, "MASTER_PASSWORD");
  requireValue(RESTORE_MASTER_PASSWORD, "RESTORE_MASTER_PASSWORD");

  if (!safeEqualText(MASTER_PASSWORD, RESTORE_MASTER_PASSWORD)) {
    throw new Error("Master password is wrong.");
  }
}

function verifyAuthStatus(authData) {
  const now = new Date();

  if (authData.status?.revoked === true) {
    throw new Error("Authorization was revoked.");
  }

  if (authData.status?.used === true) {
    throw new Error("Authorization was already used. Re-run blocked.");
  }

  const expiresAtRaw = authData.metadata?.expires_at_utc;

  if (!expiresAtRaw) {
    throw new Error("Authorization file has no expiry timestamp.");
  }

  const expiresAt = new Date(expiresAtRaw);

  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("Authorization expiry timestamp is invalid.");
  }

  if (now.getTime() > expiresAt.getTime()) {
    throw new Error(`Authorization expired at ${authData.metadata.expires_at_berlin || expiresAtRaw}.`);
  }
}

function verifyCodes(authData) {
  requireValue(CODE_A, "CODE_A");
  requireValue(CODE_B, "CODE_B");

  const codeAInfo = authData.verification?.code_a;
  const codeBInfo = authData.verification?.code_b;

  if (!codeAInfo?.salt || !codeAInfo?.hash) {
    throw new Error("Authorization file is missing Code A verification data.");
  }

  if (!codeBInfo?.salt || !codeBInfo?.hash) {
    throw new Error("Authorization file is missing Code B verification data.");
  }

  const codeAHash = hashCode(CODE_A.trim(), codeAInfo.salt);
  const codeBHash = hashCode(CODE_B.trim(), codeBInfo.salt);

  if (!safeEqualHex(codeAHash, codeAInfo.hash)) {
    throw new Error("Code A is wrong.");
  }

  if (!safeEqualHex(codeBHash, codeBInfo.hash)) {
    throw new Error("Code B is wrong.");
  }
}

function markAuthAsUsed(authData) {
  const now = new Date();

  authData.status = authData.status || {};
  authData.status.used = true;
  authData.status.used_at_utc = now.toISOString();
  authData.status.used_at_berlin = berlinTimestamp(now);

  authData.status.used_by_workflow_mode = MODE;
  authData.status.used_note = "Authorization was consumed by Restore Execute safety gate. No real Discord restore was executed in test mode.";

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
  requireValue(AUTH_FILE, "AUTH_FILE");
  requireValue(CONFIRM_TEXT, "CONFIRM_TEXT");

  verifyConfirmText();
  verifyMasterPassword();

  const authData = readAuthFile();

  verifyAuthStatus(authData);
  verifyCodes(authData);

  const updatedAuthData = markAuthAsUsed(authData);
  writeAuthFile(updatedAuthData);

  const authId = updatedAuthData.metadata?.auth_id || "unknown";
  const planFile = updatedAuthData.source?.restore_plan_file || "unknown";
  const summary = updatedAuthData.source?.plan_summary || {};

  await sendWebhook(
    `✅ **Restore Execute SAFETY TEST passed**\n\n` +
    `No Discord changes were made.\nNo real restore was executed.\n\n` +
    `Password check passed.\nMaster password passed.\nConfirm text passed.\nCode A passed.\nCode B passed.\nAuthorization expiry check passed.\nAuthorization used-status check passed.\n\n` +
    `Authorization was marked as used to block re-runs.\n\n` +
    `Auth ID: ${authId}\n` +
    `Auth file: ${AUTH_FILE}\n` +
    `Restore plan: ${planFile}\n\n` +
    `Planned actions: ${summary.actions_total ?? 0}\n` +
    `Create missing roles: ${summary.create_missing_roles ?? 0}\n` +
    `Create missing channels: ${summary.create_missing_channels ?? 0}\n` +
    `Restore missing bans: ${summary.restore_missing_bans ?? 0}\n` +
    `Review changed roles: ${summary.review_changed_roles ?? 0}\n` +
    `Review changed channels: ${summary.review_changed_channels ?? 0}\n\n` +
    `Time: ${berlinTimestamp()} Europe/Berlin`
  );

  console.log("Restore Execute safety test passed.");
  console.log("Authorization was marked as used.");
  console.log("No Discord changes were made.");
}

async function main() {
  try {
    if (MODE !== "test") {
      throw new Error("Only MODE=test is currently allowed. Real restore execution is not implemented yet.");
    }

    await runTestMode();
  } catch (error) {
    console.error(error.message);

    try {
      await sendWebhook(
        `❌ **Restore Execute SAFETY TEST failed**\n\n` +
        `${error.message}\n\n` +
        `No Discord changes were made.\nNo real restore was executed.\n\n` +
        `Time: ${berlinTimestamp()} Europe/Berlin`
      );
    } catch (logError) {
      console.error("Could not send failure log:", logError.message);
    }

    process.exit(1);
  }
}

main();

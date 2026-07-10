const fs = require("fs");
const path = require("path");

const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL || "";
const RESTORE_PREVIEW_FILE = process.env.RESTORE_PREVIEW_FILE || "reports/restore-preview-latest.json";

const PLAN_DIR = "plans";

function berlinTimestamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date()).replace(" ", "T");
}

function fileStamp() {
  return berlinTimestamp().replace("T", "-").replace(/:/g, "-");
}

function readPreviewReport() {
  if (!fs.existsSync(RESTORE_PREVIEW_FILE)) {
    throw new Error(`Restore Preview Report nicht gefunden: ${RESTORE_PREVIEW_FILE}`);
  }

  return JSON.parse(fs.readFileSync(RESTORE_PREVIEW_FILE, "utf8"));
}

function channelTypeName(type) {
  const types = {
    0: "text",
    2: "voice",
    4: "category",
    5: "announcement",
    13: "stage",
    15: "forum",
    16: "media"
  };

  return types[type] || `unknown-${type}`;
}

function buildRestorePlan(preview) {
  const missingRoles = preview.roles?.missing || [];
  const changedRoles = preview.roles?.changed || [];
  const extraRoles = preview.roles?.extra || [];

  const missingChannels = preview.channels?.missing || [];
  const changedChannels = preview.channels?.changed || [];
  const extraChannels = preview.channels?.extra || [];

  const missingBans = preview.bans?.missing || [];
  const extraBans = preview.bans?.extra || [];

  const plannedActions = [];

  for (const role of missingRoles) {
    plannedActions.push({
      action: "create_missing_role",
      risk: "medium",
      name: role.name,
      backup_id: role.id,
      details: {
        color: role.color,
        hoist: role.hoist,
        position: role.position,
        permissions: role.permissions,
        mentionable: role.mentionable,
        managed: role.managed
      },
      note: "Role IDs cannot be restored. Discord will create a new role ID."
    });
  }

  for (const channel of missingChannels) {
    plannedActions.push({
      action: "create_missing_channel",
      risk: "medium",
      name: channel.name,
      type: channel.type,
      type_name: channelTypeName(channel.type),
      backup_id: channel.id,
      parent_id_from_backup: channel.parent_id || null,
      details: {
        position: channel.position,
        topic: channel.topic || null,
        nsfw: channel.nsfw || false,
        rate_limit_per_user: channel.rate_limit_per_user || 0,
        bitrate: channel.bitrate || null,
        user_limit: channel.user_limit || null,
        permission_overwrites_count: Array.isArray(channel.permission_overwrites) ? channel.permission_overwrites.length : 0
      },
      note: "Channel IDs cannot be restored. Parent/category mapping must be resolved during real restore."
    });
  }

  for (const ban of missingBans) {
    plannedActions.push({
      action: "restore_missing_ban",
      risk: "high",
      user_id: ban.user?.id || null,
      username: ban.user?.username || null,
      global_name: ban.user?.global_name || null,
      reason: ban.reason || null,
      note: "This would ban the user again if Restore Execute is later approved."
    });
  }

  for (const roleChange of changedRoles) {
    plannedActions.push({
      action: "review_changed_role",
      risk: "low",
      name: roleChange.name,
      backup_id: roleChange.backup_id,
      current_id: roleChange.current_id,
      changed_fields: roleChange.changes?.map(change => change.field) || [],
      note: "Changed roles are planned for review first, not automatic modification."
    });
  }

  for (const channelChange of changedChannels) {
    plannedActions.push({
      action: "review_changed_channel",
      risk: "low",
      name: channelChange.name,
      type: channelChange.type,
      type_name: channelTypeName(channelChange.type),
      backup_id: channelChange.backup_id,
      current_id: channelChange.current_id,
      changed_fields: channelChange.changes?.map(change => change.field) || [],
      note: "Changed channels are planned for review first, not automatic modification."
    });
  }

  const plan = {
    metadata: {
      created_at_utc: new Date().toISOString(),
      created_at_berlin: berlinTimestamp(),
      mode: "restore-plan-only",
      warning: "No Discord changes were made. This is only a plan generated from the Restore Preview report.",
      source_preview_file: RESTORE_PREVIEW_FILE
    },
    summary: {
      actions_total: plannedActions.length,
      create_missing_roles: missingRoles.length,
      create_missing_channels: missingChannels.length,
      restore_missing_bans: missingBans.length,
      review_changed_roles: changedRoles.length,
      review_changed_channels: changedChannels.length,
      extra_roles_not_planned_for_delete: extraRoles.length,
      extra_channels_not_planned_for_delete: extraChannels.length,
      extra_bans_not_planned_for_unban: extraBans.length
    },
    safety_rules: {
      deletes_are_not_planned: true,
      extra_roles_are_not_deleted: true,
      extra_channels_are_not_deleted: true,
      extra_bans_are_not_removed: true,
      changed_items_require_review_first: true,
      real_restore_requires_separate_authorization: true
    },
    planned_actions: plannedActions,
    not_planned: {
      extra_roles: extraRoles.map(role => ({
        id: role.id,
        name: role.name,
        note: "Extra role exists currently but not in backup. It will not be deleted automatically."
      })),
      extra_channels: extraChannels.map(channel => ({
        id: channel.id,
        name: channel.name,
        type: channel.type,
        type_name: channelTypeName(channel.type),
        note: "Extra channel exists currently but not in backup. It will not be deleted automatically."
      })),
      extra_bans: extraBans.map(ban => ({
        user_id: ban.user?.id || null,
        username: ban.user?.username || null,
        global_name: ban.user?.global_name || null,
        note: "Extra ban exists currently but not in backup. It will not be removed automatically."
      }))
    }
  };

  return plan;
}

function writePlan(plan) {
  fs.mkdirSync(PLAN_DIR, { recursive: true });

  const datedPath = path.join(PLAN_DIR, `restore-plan-${fileStamp()}.json`);
  const latestPath = path.join(PLAN_DIR, "restore-plan-latest.json");

  const jsonText = JSON.stringify(plan, null, 2) + "\n";

  fs.writeFileSync(datedPath, jsonText, "utf8");
  fs.writeFileSync(latestPath, jsonText, "utf8");

  return { datedPath, latestPath };
}

async function sendLog(plan, files, status, errorMessage = "") {
  if (!LOG_WEBHOOK_URL) {
    console.log("No LOG_WEBHOOK_URL set. Skipping Discord log.");
    return;
  }

  const berlinTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date());

  const content = status === "success"
    ? `📝 **Restore Plan created**\n\nNo Discord changes were made.\n\nSource preview: ${RESTORE_PREVIEW_FILE}\n\nPlanned actions: ${plan.summary.actions_total}\nCreate missing roles: ${plan.summary.create_missing_roles}\nCreate missing channels: ${plan.summary.create_missing_channels}\nRestore missing bans: ${plan.summary.restore_missing_bans}\nReview changed roles: ${plan.summary.review_changed_roles}\nReview changed channels: ${plan.summary.review_changed_channels}\n\nDeletes planned: No\nReal restore required: Separate authorization\n\nPlan: ${files.latestPath}\nTime: ${berlinTime} Europe/Berlin`
    : `❌ **Restore Plan failed**\n\n${errorMessage || "Unknown error"}\n\nTime: ${berlinTime} Europe/Berlin`;

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
    throw new Error(`Log Webhook Fehler: ${response.status} ${errorText}`);
  }

  console.log("Discord log sent.");
}

async function main() {
  try {
    const preview = readPreviewReport();
    const plan = buildRestorePlan(preview);
    const files = writePlan(plan);

    console.log(`Restore plan written: ${files.datedPath}`);
    console.log(`Latest restore plan written: ${files.latestPath}`);
    console.log(JSON.stringify(plan.summary, null, 2));

    await sendLog(plan, files, "success");
  } catch (error) {
    console.error(error);

    try {
      await sendLog(null, null, "failure", error.message);
    } catch (logError) {
      console.error("Could not send failure log:", logError);
    }

    process.exit(1);
  }
}

main();

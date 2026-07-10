const fs = require("fs");
const path = require("path");

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_GUILD_ID = process.env.DISCORD_GUILD_ID;
const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL || "";

const API_BASE = "https://discord.com/api/v10";
const BACKUP_DIR = "backups";
const BACKUP_RETENTION_COUNT = 90;

if (!DISCORD_BOT_TOKEN) {
  throw new Error("DISCORD_BOT_TOKEN fehlt. Bitte als GitHub Repository Secret anlegen.");
}

if (!DISCORD_GUILD_ID) {
  throw new Error("DISCORD_GUILD_ID fehlt. Bitte als GitHub Repository Secret anlegen.");
}

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

function backupFileTimestamp() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date()).replace(" ", "-").replace(/:/g, "-");
}

async function discordFetch(endpoint, options = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      "Authorization": `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Discord API Fehler ${response.status} bei ${endpoint}: ${errorText}`);
  }

  return response.json();
}

function sortByPositionThenName(items) {
  return [...items].sort((a, b) => {
    const posA = typeof a.position === "number" ? a.position : 0;
    const posB = typeof b.position === "number" ? b.position : 0;

    if (posA !== posB) return posA - posB;

    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function simplifyRole(role) {
  return {
    id: role.id,
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    icon: role.icon,
    unicode_emoji: role.unicode_emoji,
    position: role.position,
    permissions: role.permissions,
    managed: role.managed,
    mentionable: role.mentionable,
    tags: role.tags || null
  };
}

function simplifyChannel(channel) {
  return {
    id: channel.id,
    type: channel.type,
    name: channel.name,
    position: channel.position,
    parent_id: channel.parent_id || null,
    permission_overwrites: channel.permission_overwrites || [],
    topic: channel.topic || null,
    nsfw: channel.nsfw || false,
    rate_limit_per_user: channel.rate_limit_per_user || 0,
    bitrate: channel.bitrate || null,
    user_limit: channel.user_limit || null,
    rtc_region: channel.rtc_region || null,
    video_quality_mode: channel.video_quality_mode || null,
    default_auto_archive_duration: channel.default_auto_archive_duration || null,
    flags: channel.flags || 0,
    available_tags: channel.available_tags || null,
    default_reaction_emoji: channel.default_reaction_emoji || null,
    default_thread_rate_limit_per_user: channel.default_thread_rate_limit_per_user || null,
    default_sort_order: channel.default_sort_order || null,
    default_forum_layout: channel.default_forum_layout || null
  };
}

function simplifyBan(ban) {
  return {
    reason: ban.reason || null,
    user: {
      id: ban.user?.id || null,
      username: ban.user?.username || null,
      discriminator: ban.user?.discriminator || null,
      global_name: ban.user?.global_name || null,
      bot: ban.user?.bot || false
    }
  };
}

function getDatedBackupFiles() {
  if (!fs.existsSync(BACKUP_DIR)) {
    return [];
  }

  return fs.readdirSync(BACKUP_DIR)
    .filter(file => /^server-structure-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/.test(file))
    .sort();
}

function cleanupOldBackups() {
  const backupFiles = getDatedBackupFiles();
  const deleteCount = Math.max(0, backupFiles.length - BACKUP_RETENTION_COUNT);
  const filesToDelete = backupFiles.slice(0, deleteCount);

  for (const file of filesToDelete) {
    fs.unlinkSync(path.join(BACKUP_DIR, file));
  }

  const remainingFiles = getDatedBackupFiles();

  return {
    deletedFiles: filesToDelete,
    remainingBackupCount: remainingFiles.length
  };
}

async function fetchAllBans() {
  const allBans = [];
  let after = null;

  while (true) {
    const query = new URLSearchParams({ limit: "1000" });

    if (after) {
      query.set("after", after);
    }

    const bans = await discordFetch(`/guilds/${DISCORD_GUILD_ID}/bans?${query.toString()}`);

    allBans.push(...bans);

    if (bans.length < 1000) {
      break;
    }

    after = bans[bans.length - 1].user.id;
  }

  return allBans;
}

async function createBackup() {
  const [guild, channelsRaw, rolesRaw, bansRaw] = await Promise.all([
    discordFetch(`/guilds/${DISCORD_GUILD_ID}?with_counts=true`),
    discordFetch(`/guilds/${DISCORD_GUILD_ID}/channels`),
    discordFetch(`/guilds/${DISCORD_GUILD_ID}/roles`),
    fetchAllBans()
  ]);

  const roles = sortByPositionThenName(rolesRaw).map(simplifyRole);
  const channels = sortByPositionThenName(channelsRaw).map(simplifyChannel);
  const categories = channels.filter(channel => channel.type === 4);
  const bans = bansRaw.map(simplifyBan);

  return {
    metadata: {
      created_at_utc: new Date().toISOString(),
      created_at_berlin: berlinTimestamp(),
      source: "GitHub Actions / Bot Manager",
      backup_version: 1,
      retention_count: BACKUP_RETENTION_COUNT
    },
    guild: {
      id: guild.id,
      name: guild.name,
      description: guild.description || null,
      icon: guild.icon || null,
      banner: guild.banner || null,
      owner_id: guild.owner_id,
      preferred_locale: guild.preferred_locale || null,
      verification_level: guild.verification_level,
      default_message_notifications: guild.default_message_notifications,
      explicit_content_filter: guild.explicit_content_filter,
      mfa_level: guild.mfa_level,
      premium_tier: guild.premium_tier,
      premium_subscription_count: guild.premium_subscription_count || 0,
      approximate_member_count: guild.approximate_member_count || null,
      approximate_presence_count: guild.approximate_presence_count || null,
      system_channel_id: guild.system_channel_id || null,
      rules_channel_id: guild.rules_channel_id || null,
      public_updates_channel_id: guild.public_updates_channel_id || null,
      afk_channel_id: guild.afk_channel_id || null,
      afk_timeout: guild.afk_timeout || null,
      features: guild.features || []
    },
    counts: {
      roles: roles.length,
      channels: channels.length,
      categories: categories.length,
      bans: bans.length
    },
    roles,
    channels,
    bans
  };
}

function writeBackupFiles(backup) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const timestamp = backupFileTimestamp();
  const datedPath = path.join(BACKUP_DIR, `server-structure-${timestamp}.json`);
  const latestPath = path.join(BACKUP_DIR, "latest.json");

  const jsonText = JSON.stringify(backup, null, 2) + "\n";

  fs.writeFileSync(datedPath, jsonText, "utf8");
  fs.writeFileSync(latestPath, jsonText, "utf8");

  const cleanup = cleanupOldBackups();

  return {
    datedPath,
    latestPath,
    deletedFiles: cleanup.deletedFiles,
    remainingBackupCount: cleanup.remainingBackupCount
  };
}

function createCleanupMessage(files) {
  if (!files.deletedFiles.length) {
    return "No old backup deleted.";
  }

  if (files.deletedFiles.length === 1) {
    return `Deleted oldest backup: ${files.deletedFiles[0]}`;
  }

  return `Deleted ${files.deletedFiles.length} old backups. Oldest deleted: ${files.deletedFiles[0]}`;
}

async function sendLog(backup, status, errorMessage = "", files = null) {
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

  const isSuccess = status === "success";

  const backupCountText = files
    ? `${files.remainingBackupCount} / ${BACKUP_RETENTION_COUNT}`
    : `unknown / ${BACKUP_RETENTION_COUNT}`;

  const cleanupText = files
    ? createCleanupMessage(files)
    : "Cleanup status unknown.";

  const content = isSuccess
    ? `✅ **Discord Structure Backup completed**\n\nServer: ${backup.guild.name}\nRoles: ${backup.counts.roles}\nChannels: ${backup.counts.channels}\nCategories: ${backup.counts.categories}\nBans: ${backup.counts.bans}\n\nStored backups: ${backupCountText}\nCleanup: ${cleanupText}\n\nTime: ${berlinTime} Europe/Berlin`
    : `❌ **Discord Structure Backup failed**\n\n${errorMessage || "Unknown error"}\n\nTime: ${berlinTime} Europe/Berlin`;

  const payload = {
    username: "Bot Manager Log",
    content,
    allowed_mentions: {
      parse: []
    }
  };

  const response = await fetch(LOG_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Log Webhook Fehler: ${response.status} ${errorText}`);
  }

  console.log("Discord log sent.");
}

async function main() {
  try {
    const backup = await createBackup();
    const files = writeBackupFiles(backup);

    console.log(`Backup written: ${files.datedPath}`);
    console.log(`Latest backup written: ${files.latestPath}`);
    console.log(`Stored backup files: ${files.remainingBackupCount} / ${BACKUP_RETENTION_COUNT}`);
    console.log(`Deleted old backup files: ${files.deletedFiles.length}`);
    console.log(`Roles: ${backup.counts.roles}`);
    console.log(`Channels: ${backup.counts.channels}`);
    console.log(`Categories: ${backup.counts.categories}`);
    console.log(`Bans: ${backup.counts.bans}`);

    await sendLog(backup, "success", "", files);
  } catch (error) {
    console.error(error);

    try {
      await sendLog(
        { guild: { name: "Unknown" }, counts: { roles: 0, channels: 0, categories: 0, bans: 0 } },
        "failure",
        error.message
      );
    } catch (logError) {
      console.error("Could not send failure log:", logError);
    }

    process.exit(1);
  }
}

main();

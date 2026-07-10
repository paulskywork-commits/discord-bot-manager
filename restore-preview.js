const fs = require("fs");
const path = require("path");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const LOG_WEBHOOK_URL = process.env.LOG_WEBHOOK_URL || "";
const BACKUP_FILE = process.env.BACKUP_FILE || "backups/latest.json";

const API = "https://discord.com/api/v10";
const REPORT_DIR = "reports";

if (!TOKEN) throw new Error("DISCORD_BOT_TOKEN fehlt.");
if (!GUILD_ID) throw new Error("DISCORD_GUILD_ID fehlt.");

async function discordFetch(endpoint) {
  const res = await fetch(`${API}${endpoint}`, {
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json"
    }
  });

  if (!res.ok) {
    throw new Error(`Discord API Fehler ${res.status} bei ${endpoint}: ${await res.text()}`);
  }

  return res.json();
}

function berlinDateTime() {
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
  return berlinDateTime().replace("T", "-").replace(/:/g, "-");
}

function sortByPosition(items) {
  return [...items].sort((a, b) => {
    const pa = typeof a.position === "number" ? a.position : 0;
    const pb = typeof b.position === "number" ? b.position : 0;
    if (pa !== pb) return pa - pb;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function simplifyRole(r) {
  return {
    id: r.id,
    name: r.name,
    color: r.color,
    hoist: r.hoist,
    position: r.position,
    permissions: r.permissions,
    managed: r.managed,
    mentionable: r.mentionable
  };
}

function simplifyChannel(c) {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    position: c.position,
    parent_id: c.parent_id || null,
    permission_overwrites: c.permission_overwrites || [],
    topic: c.topic || null,
    nsfw: c.nsfw || false,
    rate_limit_per_user: c.rate_limit_per_user || 0,
    bitrate: c.bitrate || null,
    user_limit: c.user_limit || null,
    flags: c.flags || 0
  };
}

function simplifyBan(b) {
  return {
    reason: b.reason || null,
    user: {
      id: b.user?.id || null,
      username: b.user?.username || null,
      global_name: b.user?.global_name || null,
      bot: b.user?.bot || false
    }
  };
}

async function fetchAllBans() {
  const bans = [];
  let after = null;

  while (true) {
    const q = new URLSearchParams({ limit: "1000" });
    if (after) q.set("after", after);

    const page = await discordFetch(`/guilds/${GUILD_ID}/bans?${q}`);
    bans.push(...page);

    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }

  return bans;
}

async function fetchCurrentState() {
  const [guild, channelsRaw, rolesRaw, bansRaw] = await Promise.all([
    discordFetch(`/guilds/${GUILD_ID}?with_counts=true`),
    discordFetch(`/guilds/${GUILD_ID}/channels`),
    discordFetch(`/guilds/${GUILD_ID}/roles`),
    fetchAllBans()
  ]);

  const roles = sortByPosition(rolesRaw).map(simplifyRole);
  const channels = sortByPosition(channelsRaw).map(simplifyChannel);
  const bans = bansRaw.map(simplifyBan);

  return {
    metadata: {
      created_at_berlin: berlinDateTime(),
      source: "Current Discord Server State"
    },
    guild: {
      id: guild.id,
      name: guild.name
    },
    counts: {
      roles: roles.length,
      channels: channels.length,
      categories: channels.filter(c => c.type === 4).length,
      bans: bans.length
    },
    roles,
    channels,
    bans
  };
}

function readBackup() {
  if (!fs.existsSync(BACKUP_FILE)) {
    throw new Error(`Backup-Datei nicht gefunden: ${BACKUP_FILE}`);
  }

  return JSON.parse(fs.readFileSync(BACKUP_FILE, "utf8"));
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function categoryNames(channels) {
  const map = new Map();
  for (const c of channels || []) {
    if (c.type === 4) map.set(c.id, c.name);
  }
  return map;
}

function channelKey(channel, allChannels) {
  const cats = categoryNames(allChannels);
  const parent = channel.parent_id ? cats.get(channel.parent_id) || `unknown-parent:${channel.parent_id}` : "no-parent";
  return `${channel.type}::${parent}::${channel.name}`;
}

function roleKey(role) {
  return role.name;
}

function banKey(ban) {
  return ban.user?.id || "unknown-user";
}

function mapBy(items, keyFn, allItems = items) {
  const map = new Map();
  const duplicates = [];

  for (const item of items || []) {
    const key = keyFn(item, allItems);
    if (map.has(key)) {
      duplicates.push({ key, duplicate: item });
    } else {
      map.set(key, item);
    }
  }

  return { map, duplicates };
}

function changedFields(a, b, fields) {
  const changes = [];

  for (const f of fields) {
    if (stable(a[f]) !== stable(b[f])) {
      changes.push({ field: f, backup: a[f], current: b[f] });
    }
  }

  return changes;
}

function compareNamed(backupItems, currentItems, keyFn, fields, allBackup, allCurrent) {
  const b = mapBy(backupItems, keyFn, allBackup || backupItems);
  const c = mapBy(currentItems, keyFn, allCurrent || currentItems);

  const missing = [];
  const extra = [];
  const changed = [];

  for (const [key, oldItem] of b.map.entries()) {
    const newItem = c.map.get(key);
    if (!newItem) {
      missing.push(oldItem);
      continue;
    }

    const changes = changedFields(oldItem, newItem, fields);
    if (changes.length) {
      changed.push({
        key,
        name: oldItem.name || key,
        backup_id: oldItem.id || null,
        current_id: newItem.id || null,
        changes
      });
    }
  }

  for (const [key, item] of c.map.entries()) {
    if (!b.map.has(key)) extra.push(item);
  }

  return {
    missing,
    extra,
    changed,
    duplicate_keys_in_backup: b.duplicates,
    duplicate_keys_current: c.duplicates
  };
}

function buildDiff(backup, current) {
  const roleFields = ["color", "hoist", "position", "permissions", "managed", "mentionable"];
  const channelFields = ["position", "topic", "nsfw", "rate_limit_per_user", "bitrate", "user_limit", "flags", "permission_overwrites"];

  const roles = compareNamed(backup.roles || [], current.roles || [], roleKey, roleFields);
  const channels = compareNamed(backup.channels || [], current.channels || [], channelKey, channelFields, backup.channels || [], current.channels || []);

  const backupBans = mapBy(backup.bans || [], banKey);
  const currentBans = mapBy(current.bans || [], banKey);

  const missingBans = [];
  const extraBans = [];

  for (const [key, ban] of backupBans.map.entries()) {
    if (!currentBans.map.has(key)) missingBans.push(ban);
  }

  for (const [key, ban] of currentBans.map.entries()) {
    if (!backupBans.map.has(key)) extraBans.push(ban);
  }

  return {
    metadata: {
      created_at_utc: new Date().toISOString(),
      created_at_berlin: berlinDateTime(),
      mode: "restore-preview-only",
      warning: "No Discord changes were made. This report only compares backup data with the current server.",
      backup_file: BACKUP_FILE
    },
    guild: {
      backup: backup.guild || {},
      current: current.guild || {}
    },
    counts: {
      backup: backup.counts || {},
      current: current.counts || {},
      diff: {
        missing_roles: roles.missing.length,
        extra_roles: roles.extra.length,
        changed_roles: roles.changed.length,
        missing_channels: channels.missing.length,
        extra_channels: channels.extra.length,
        changed_channels: channels.changed.length,
        missing_bans: missingBans.length,
        extra_bans: extraBans.length
      }
    },
    roles,
    channels,
    bans: {
      missing: missingBans,
      extra: extraBans
    }
  };
}

function writeReport(diff) {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const datedPath = path.join(REPORT_DIR, `restore-preview-${fileStamp()}.json`);
  const latestPath = path.join(REPORT_DIR, "restore-preview-latest.json");
  const text = JSON.stringify(diff, null, 2) + "\n";

  fs.writeFileSync(datedPath, text, "utf8");
  fs.writeFileSync(latestPath, text, "utf8");

  return { datedPath, latestPath };
}

async function sendLog(diff, files, status, error = "") {
  if (!LOG_WEBHOOK_URL) {
    console.log("No LOG_WEBHOOK_URL set. Skipping Discord log.");
    return;
  }

  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date());

  const content = status === "success"
    ? `🧪 **Restore Preview completed**\n\nNo Discord changes were made.\n\nBackup file: ${BACKUP_FILE}\n\nMissing roles: ${diff.counts.diff.missing_roles}\nExtra roles: ${diff.counts.diff.extra_roles}\nChanged roles: ${diff.counts.diff.changed_roles}\n\nMissing channels: ${diff.counts.diff.missing_channels}\nExtra channels: ${diff.counts.diff.extra_channels}\nChanged channels: ${diff.counts.diff.changed_channels}\n\nMissing bans: ${diff.counts.diff.missing_bans}\nExtra bans: ${diff.counts.diff.extra_bans}\n\nReport: ${files.latestPath}\nTime: ${time} Europe/Berlin`
    : `❌ **Restore Preview failed**\n\n${error || "Unknown error"}\n\nTime: ${time} Europe/Berlin`;

  const res = await fetch(LOG_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "Bot Manager Log",
      content,
      allowed_mentions: { parse: [] }
    })
  });

  if (!res.ok) throw new Error(`Log Webhook Fehler: ${res.status} ${await res.text()}`);
}

async function main() {
  try {
    const backup = readBackup();
    const current = await fetchCurrentState();
    const diff = buildDiff(backup, current);
    const files = writeReport(diff);

    console.log(`Restore preview report written: ${files.datedPath}`);
    console.log(JSON.stringify(diff.counts.diff, null, 2));

    await sendLog(diff, files, "success");
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

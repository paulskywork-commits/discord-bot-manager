# Discord Bot Manager

Dieses Repository ist für deinen Discord **Bot Manager** gedacht.

Aktuell enthalten:

```text
Daily Discord Structure Backup
```

Der Bot muss nicht dauerhaft gehostet werden. GitHub Actions startet einmal täglich, nutzt kurz den Discord Bot Token, liest die Serverstruktur über die Discord API, speichert JSON-Backups und sendet ein Log in Discord.

## Gesichert werden aktuell

```text
Serverdaten
Channels
Kategorien
Rollen
Channel-Berechtigungen / Permission Overwrites
Bans
```

## Dateien

```text
backup-discord.js
backups/latest.json
backups/server-structure-YYYY-MM-DD.json
.github/workflows/daily-backup.yml
```

## Benötigte GitHub Secrets

Im Repository:

```text
Settings → Secrets and variables → Actions → Secrets
```

Diese Secrets müssen vorhanden sein:

```text
DISCORD_BOT_TOKEN
DISCORD_GUILD_ID
LOG_WEBHOOK_URL
```

## Zeitplan

Der Workflow läuft täglich um:

```text
02:23 UTC
```

Das ist ungefähr:

```text
04:23 Uhr deutscher Sommerzeit
03:23 Uhr deutscher Winterzeit
```

Du kannst ihn auch manuell starten:

```text
Actions → Daily Discord Structure Backup → Run workflow
```

## Wichtig

Der Bot Token darf niemals öffentlich geteilt oder in normale Dateien geschrieben werden.
Er gehört ausschließlich in GitHub Secrets.

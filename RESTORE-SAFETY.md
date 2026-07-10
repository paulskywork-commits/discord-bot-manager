# Discord Bot Manager — Restore Safety Guide

This file explains the restore safety system for the `discord-bot-manager` repository.

The goal of this system is simple:

Never restore or change Discord by accident.

At the moment, this system can backup, compare, plan, authorize, test, block re-runs, and revoke restore authorizations.

A real destructive Discord restore is not active yet.

---

## Current safety status

| System | Status | Changes Discord? |
|---|---:|---:|
| Daily Backup | Active | No |
| Restore Preview | Active | No |
| Restore Plan | Active | No |
| Restore Auth Codes | Active | No |
| Restore Execute | Safety test only | No |
| Restore Auth Revoke | Active | No |

---

## Important secrets

These secrets are stored in GitHub Actions secrets.

Never write them into Discord, GitHub files, commits, issues, or chat messages.

| Secret | Purpose |
|---|---|
| `DISCORD_BOT_TOKEN` | Discord bot token |
| `DISCORD_GUILD_ID` | Discord server ID |
| `LOG_WEBHOOK_URL` | Log/Admin channel webhook |
| `BOT_MANAGER_ACTION_PASSWORD` | Main Bot Manager action password |
| `RESTORE_DM_USER_ID` | Discord user ID for Code A DM |
| `RESTORE_MASTER_PASSWORD` | Extra restore master password from password manager |

---

## Full safety chain

A restore action must never depend on only one password or one code.

The full safety chain is:

1. Bot Manager action password
2. Code A from Discord DM
3. Code B from Admin/Log channel
4. Restore Master Password from password manager
5. Confirm text
6. Authorization expiry check
7. Authorization used-status check
8. Authorization revoked-status check
9. Authorization is marked as used before any future real restore action
10. Re-run protection

---

## Correct workflow order

Use the workflows in this order:

1. `Daily Discord Structure Backup`
2. `Restore Preview`
3. `Restore Plan`
4. `Restore Auth Codes`
5. `Restore Execute`

If you want to cancel an open authorization, use:

`Restore Auth Revoke`

---

# Workflow overview

---

## 1. Daily Discord Structure Backup

Workflow name:

`Daily Discord Structure Backup`

Purpose:

Creates a backup of the Discord server structure.

Backups include:

- Server information
- Roles
- Channels
- Categories
- Channel permission overwrites
- Bans

Output files:

- `backups/latest.json`
- `backups/server-structure-YYYY-MM-DD-HH-MM-SS.json`

Safety:

This workflow does not change Discord.

---

## 2. Restore Preview

Workflow name:

`Restore Preview`

Purpose:

Compares a backup with the current Discord server.

Default input:

`backup_file: backups/latest.json`

Output files:

- `reports/restore-preview-latest.json`
- `reports/restore-preview-YYYY-MM-DD-HH-MM-SS.json`

Shows:

- Missing roles
- Extra roles
- Changed roles
- Missing channels
- Extra channels
- Changed channels
- Missing bans
- Extra bans

Safety:

This workflow does not change Discord.  
It only creates a report.

---

## 3. Restore Plan

Workflow name:

`Restore Plan`

Purpose:

Turns the Restore Preview report into a clear restore plan.

Default input:

`restore_preview_file: reports/restore-preview-latest.json`

Modes:

- `test`
- `normal`

### Test mode

Does:

- Sends a test log message

Does not:

- Create files
- Commit files
- Change Discord

### Normal mode

Creates:

- `plans/restore-plan-latest.json`
- `plans/restore-plan-YYYY-MM-DD-HH-MM-SS.json`

Safety:

This workflow does not change Discord.  
It only creates a plan.  
It does not delete roles.  
It does not delete channels.  
It does not unban users.

---

## 4. Restore Auth Codes

Workflow name:

`Restore Auth Codes`

Purpose:

Creates a short-lived restore authorization.

Default input:

`restore_plan_file: plans/restore-plan-latest.json`

Modes:

- `test`
- `normal`

### Test mode

Does:

- Sends a test log message

Does not:

- Generate codes
- Send DM
- Create files
- Change Discord

### Normal mode

Creates two separate codes:

- Code A is sent by Discord DM
- Code B is sent to the Admin/Log channel

Creates authorization files:

- `restore-auth/restore-auth-latest.json`
- `restore-auth/restore-auth-YYYY-MM-DD-HH-MM-SS-XXXXXXXX.json`

Important:

Plaintext codes are not saved in GitHub.  
Only salted hashes are saved.

Default expiry:

`10 minutes`

Safety message:

Code A alone cannot execute a restore.  
Code B alone cannot execute a restore.

A restore also requires:

- Bot Manager action password
- Restore Master Password
- Confirm text
- Valid unused authorization

---

## 5. Restore Execute

Workflow name:

`Restore Execute`

Current status:

Safety test only.  
Real restore is not implemented yet.

Default auth file:

`restore-auth/restore-auth-latest.json`

Important:

Always use the full path:

`restore-auth/restore-auth-latest.json`

Do not use:

`restore-auth-latest.json`

Required inputs:

- `auth_file`
- `mode`
- `code_a`
- `code_b`
- `master_password`
- `confirm_text`
- `password`

Correct test confirm text:

`RESTORE_EXECUTE_TEST`

What the safety test checks:

- Bot Manager action password
- Restore Master Password
- Confirm text
- Code A
- Code B
- Authorization expiry
- Authorization used status
- Authorization revoked status

What it does after a successful safety test:

- Marks the authorization as used
- Commits the used status
- Sends a success log

Safety:

This workflow does not change Discord.  
No real restore is executed.

Important re-run protection:

After a successful Execute safety test, the authorization is marked as used.

If someone clicks `Re-run all jobs`, the workflow should fail because the authorization was already used.

This is expected and good.

---

## 6. Restore Auth Revoke

Workflow name:

`Restore Auth Revoke`

Purpose:

Invalidates an open restore authorization.

Default input:

`auth_file: restore-auth/restore-auth-latest.json`

Modes:

- `test`
- `normal`

### Test mode

Does:

- Sends a test log message

Does not:

- Change files
- Change Discord

### Normal mode

Sets:

`revoked: true`

Updates all matching authorization files with the same Auth ID.

Safety:

This workflow does not change Discord.  
It only invalidates restore authorization files.

Use this if:

- Codes were created by mistake
- Codes are no longer needed
- You suspect someone saw a code
- You want to cancel an open restore authorization

---

# What to do if a workflow is red

---

## Authorization file not found

Usually the wrong path was entered.

Wrong:

`restore-auth-latest.json`

Correct:

`restore-auth/restore-auth-latest.json`

For a specific dated auth file:

Wrong:

`restore-auth-2026-07-10-17-55-38-630c7412.json`

Correct:

`restore-auth/restore-auth-2026-07-10-17-55-38-630c7412.json`

---

## Authorization expired

Create new Auth Codes:

`Actions → Restore Auth Codes → Run workflow → mode: normal`

Then run Restore Execute again within 10 minutes.

---

## Authorization already used

This is expected after a successful Execute safety test.

It means re-run protection is working.

Create new Auth Codes if another test is needed.

---

## Authorization revoked

This means the authorization was cancelled with Restore Auth Revoke.

Create new Auth Codes if needed.

---

## Code A is wrong

Use the code from the Discord DM.

Do not use Code B in the Code A field.

---

## Code B is wrong

Use the code from the Admin/Log channel.

Do not use Code A in the Code B field.

---

## Master password is wrong

Use the Restore Master Password from the password manager.

Do not use the Bot Manager action password here.

---

## Wrong confirm text

For safety test, type exactly:

`RESTORE_EXECUTE_TEST`

No spaces before or after.

---

# Rules for future real restore

A real restore must never be added as a one-click action.

A future real restore should follow these rules:

1. Restore Execute must stay disabled unless needed.
2. Test mode must remain the default.
3. Real execute mode must require a different confirm text.
4. Authorization must be marked as used before Discord changes are made.
5. Restore must start with safe actions only.
6. No automatic delete actions at the beginning.
7. Every restore action must write a detailed log.

Recommended first real restore step:

`Restore missing roles only.`

Not recommended as first restore step:

- Delete extra roles
- Delete extra channels
- Unban users automatically
- Move many channels automatically
- Change permissions in bulk without preview

---

# Emergency checklist

If something feels wrong:

1. Stop.
2. Do not click `Re-run all jobs`.
3. Run `Restore Auth Revoke` if there is an open authorization.
4. Rotate the Bot Manager action password if needed.
5. Rotate the Restore Master Password if needed.
6. Rotate the Discord bot token if needed.
7. Disable Restore Execute if it is enabled.
8. Check the Discord log channel.
9. Check recent GitHub Actions runs.

---

# After a future real restore

After any future real restore:

1. Check Discord manually.
2. Confirm the log message.
3. Confirm the authorization is marked as used.
4. Do not re-run the workflow.
5. Delete the workflow run if desired.
6. Disable Restore Execute again if it was enabled.
7. Run a fresh Daily Backup.
8. Run Restore Preview again.

---

# Current important file paths

- `backups/latest.json`
- `reports/restore-preview-latest.json`
- `plans/restore-plan-latest.json`
- `restore-auth/restore-auth-latest.json`

---

# Final safety note

This system is built to prevent accidents and block simple replay attacks like old workflow re-runs.

It cannot fully protect against a completely compromised GitHub account with repository write access, because that person could edit workflow files.

For that reason:

- Keep GitHub protected
- Use strong passwords
- Use 2FA
- Keep secrets private
- Do not share workflow inputs
- Do not paste tokens or passwords into chats

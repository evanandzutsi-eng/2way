# 2WaY: how your data is handled

Plain-language policy for members. The same summary appears in the app under **Profile → Privacy & your data**.

## What we store

- Your username, password hash (Argon2id; your actual password is never stored), avatar seed, status message, XP and achievements.
- Messages you send in rooms and DMs, with timestamps and reactions.
- Your preferences (theme, presence visibility, read receipts, activity feed).
- When you were last active (for "recently active").
- An audit log of administrative and security events (invites, role changes, moderation, logins locked).

We don't ask for your real name, phone number, email, location or contacts. There are no ads, trackers or analytics, and avatars are generated on our server, not by a third-party service.

## Who can see what

| Data | Who |
|---|---|
| Room messages | Members who can open that room. Restricted rooms: only their members. |
| DMs | Only the two people in the conversation. The app has no way for anyone else, admins included, to open them. |
| Online status | Other members, unless you turn off "Show when I'm online"; then you appear offline to everyone. |
| "Seen" receipts | Only when both people in a DM have read receipts on. |
| Recent Activity feed | Joins, rank-ups and achievements, never message text. Opt out in Profile. |

**About admins and the server.** Admins can remove room messages (logged in the audit log), manage members and rooms, and grant XP for events. They cannot read DMs through the app. Whoever operates the server has technical access to the database and backups; that access is used only to run, back up, restore or repair the service.

## How long data is kept

- Room messages: **365 days**, then deleted automatically. DMs: **365 days**. (Admins can change these; the current values are always shown in your Profile.)
- Sessions expire after 14 days of inactivity or 60 days at most.
- Encrypted backups are kept for **14 days**, so deleted content can remain in a backup until it rotates out.

## Deleting things

- **A message:** tap it → Delete. The text is removed for everyone; a "Message removed" placeholder stays.
- **Your account:** Profile → Delete my account (password required). This removes your password, profile, XP, achievements, reactions, preferences and activity entries, blanks every message you sent in rooms and DMs, and frees your seat. A record that an account existed (id and actions, no content) remains in the audit log. Backups taken earlier still contain your data until they expire (up to 14 days).

## Notifications

2WaY doesn't send push notifications. Messages arrive while the app is open; when it's closed, you'll see them next time you open it.

SKEIN OFFLINE MAILBOX - one-time setup (about 5 minutes, free)

What this is: a tiny program that runs on Google's servers under your Google account and
keeps encrypted messages in a folder in your Google Drive until the person they are for
opens Skein. It cannot read the messages. Delivered messages are deleted; anything not
collected is deleted after 14 days. You only do this once, for everyone who chats with you.

1. Go to https://script.google.com while signed in to the Google account whose Drive you
   want to use, and click "New project".
2. Delete the sample code in the editor, open Code.gs from this folder, copy ALL of it,
   and paste it in. Click the save icon. Name the project "Skein mailbox".
3. Click "Deploy" (top right) > "New deployment". Click the gear next to "Select type"
   and choose "Web app".
      Execute as:        Me
      Who has access:    Anyone
   Click "Deploy".
4. Click "Authorize access", choose your account. Google says the app isn't verified
   (it's your own script): click "Advanced", then "Go to Skein mailbox (unsafe)", then
   "Allow". It only needs your Drive.
5. Copy the "Web app URL". It ends in /exec.
6. In Skein: Settings (cog) > Offline mailbox > "Set mailbox link", and paste it.
   Friends are offered the same link automatically the next time you are online together,
   or you can send it to them to paste in the same place. Your own other devices pick it up
   by themselves.

Later, if you ever change the code: Deploy > Manage deployments > pencil icon > Version:
"New version" > Deploy. The link stays the same.

Good to know
- Messages only travel by mailbox between people who have already added each other once
  while both were online.
- Photos and videos up to roughly 5 MB go through the mailbox. Bigger ones wait until the
  other person is online.
- Anyone who has the link can drop in or collect encrypted messages, so share it only with
  people you chat with. Stopping it: Deploy > Manage deployments > Archive.
- Apps Script has daily limits. A handful of friends is nowhere near them.

# Running the backend under a Google account

The backend is one Apps Script web app. It can live under **any** Gmail account, and
you can have several, one per account. Each tournament remembers which one it was
created on (SPEC §3.1). Nothing in the repo names an account.

Where the data goes: the account's Google Drive, folder `CHGK/<date> <name> (<TID>)`,
which holds the results Sheet and a `Photos` folder for card photos (Latin names, SPEC §3.3).

## 1. Deploy the script under an account (once per account)

1. On the laptop: `uv run chgk backend bundle`. This writes `out/apps_script/Code.gs`.
2. In the browser, be signed in to **only** the Google account you want. Apps Script
   gets confused when several accounts are signed in, so a separate Chrome profile (or
   a private window) per account is safest.
3. Open <https://script.google.com> and create a new project. Name it e.g.
   `chgk backend`.
4. Delete everything in the editor's `Code.gs`, paste the whole content of
   `out/apps_script/Code.gs`, and save (⌘S).
   Then, in the left sidebar, **Services (+) → Google Sheets API → Add**. With it a
   request reads and writes the Sheet in one go each, ~2 s faster. Without it everything
   still works, just slower, and `chgk backend check` says so.
5. **Deploy → New deployment**. Click the gear and choose **Web app**:
   - Description: `chgk`
   - Execute as: **Me**
   - Who has access: **Anyone**

   Then **Deploy**.
6. Google asks to authorize: pick the account, then **Advanced → Go to chgk backend
   (unsafe)**. On the list of permissions tick **Select all** (Sheets, Drive and
   triggers), then **Continue**. It says "unsafe" only because it's your own unverified
   script. With a permission left unticked, `chgk new` fails with "You do not have
   permission to call SpreadsheetApp.create"; `chgk backend check` warns about it, and
   running `setup` again brings the consent screen back.
7. In the toolbar's function menu (next to ▶ Run / Debug) choose **setup**. It is the
   first function, so it is usually already selected; if the menu shows anything else,
   switch it. Press **Run** and open the **Execution log**. It prints the account and a
   command with the token:
   ```
   uv run chgk backend add <name> --url <Web app URL ending in /exec> --token …
   ```
8. Run that command on the laptop. Replace `<name>` with something like `personal` or
   `club`, and the URL with the **Web app URL** from **Deploy → Manage deployments**
   (it ends in `/exec`). Don't use a URL ending in `/dev`: that is the editor's test
   link, which only you can open while signed in. It checks the backend, saves the profile in
   `~/.config/chgk/backends.json` (outside the repo, readable only by you) and makes it
   active.
9. Check: `uv run chgk backend check`.

## 2. Use it

`uv run chgk new tournaments/<slug>` creates the Sheet and Drive folder on the active backend. The rest of the
steps: [README.md](../README.md) «For the organiser»; every command: `uv run chgk --help`. The Teams tab is
hidden: «Все листы» at the bottom left. Card photos are in the owner's Drive only: to let a jury member
open the links on «Спорные», share the tournament's Drive folder with them. The public results are a separate copy
in the same folder; the real Sheet is private. `chgk delete <folder>` removes a tournament with its edit trigger, and the backend then refuses its ID for a new one (phones keep unsent marks and photos by ID); a folder
deleted by hand leaves its trigger behind (Google allows 20: script editor → Triggers).

## 3. Switch to another account

1. Repeat section 1 while signed in to the other account, e.g. as profile `club`.
2. `uv run chgk backend use club`. From now on, `chgk new` creates tournaments there.
3. Tournaments created earlier keep using their own account. Their `state.json`
   records it, and their jury sheets and phones already point there. You can switch
   back any time: `uv run chgk backend use personal`.
4. `uv run chgk backend list` shows all profiles; `*` marks the active one.

An existing tournament stays on the account it was created on: it is set up and run from
one account, and archived by hand afterwards if needed.

## 4. Update the script after code changes

`uv run chgk backend check` warns when the deployed version differs from the local
code. To update:

1. Run `uv run chgk backend bundle` and paste the file into the project as in step 1.4.
2. **Deploy → Manage deployments → ✎ (edit) → Version: New version → Deploy.**
   Editing the existing deployment keeps the same `/exec` URL, so profiles, jury
   sheets and phones keep working. (**New deployment** would create a new URL.)
3. The **Google Sheets API** service must be on (step 1.4); `chgk backend check` warns
   while it is off. Older tournaments are not upgraded: create them again.

## 5. Cleaning up Drive

A tournament you no longer need: `uv run chgk delete tournaments/<slug>` (§2). A running tournament's cards, jury
link and phones all point to its own Sheet; the TID on the jury sheet (page 3) tells which folder is current. A
folder trashed by hand can be restored from the Drive Trash (right-click → Restore), and everything keeps working.

## 6. If a token leaks

- **Admin token** (in `backends.json`): in the script's **Project Settings → Script
  properties**, delete `ADMIN_TOKEN`. Run `setup` again, then
  `uv run chgk backend add <same name> …` with the new token.
- **Jury or board token** (on the jury sheet): `uv run chgk replace-token tournaments/<slug>
  jury` (or `board`). The old link stops working at once, and `out/<slug>/jury-v2.pdf` is
  the new jury sheet with a notice of what happened; each juror's phone scans its new
  «Доступ жюри» QR once (marks and photos waiting on a phone are kept and sent).

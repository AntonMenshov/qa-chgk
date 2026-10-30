# Running the backend under a Google account

The backend is one Apps Script web app. It can live under **any** Gmail account, and
you can have several, one per account. Each tournament remembers which one it was
created on (SPEC §3.1). Nothing in the repo names an account.

Where the data goes: the account's Google Drive, folder `ЧГК/<date> <name> (<TID>)`,
which holds the results Sheet and a `Фото` folder for card photos.

## 1. Deploy the script under an account (once per account)

1. On the laptop: `uv run chgk backend bundle`. This writes `out/apps_script/Code.gs`.
2. In the browser, be signed in to **only** the Google account you want. Apps Script
   gets confused when several accounts are signed in, so a separate Chrome profile (or
   a private window) per account is safest.
3. Open <https://script.google.com> and create a new project. Name it e.g.
   `chgk backend`.
4. Delete everything in the editor's `Code.gs`, paste the whole content of
   `out/apps_script/Code.gs`, and save (⌘S).
5. **Deploy → New deployment**. Click the gear and choose **Web app**:
   - Description: `chgk`
   - Execute as: **Me**
   - Who has access: **Anyone**

   Then **Deploy**.
6. Google asks to authorize: pick the account, then **Advanced → Go to chgk backend
   (unsafe)** → **Allow**. It says "unsafe" only because it's your own unverified
   script. It needs Sheets, Drive and triggers.
7. In the editor's function menu choose **setup**, press **Run**, and open the
   **Execution log**. It prints the account and a ready command:
   ```
   uv run chgk backend add <name> --url https://script.google.com/macros/s/…/exec --token …
   ```
8. Run that command on the laptop, with `<name>` replaced by something like `personal`
   or `club`. It checks the backend, saves the profile in
   `~/.config/chgk/backends.json` (outside the repo, readable only by you) and makes it
   active.
9. Check: `uv run chgk backend check`.

## 2. Use it

```
uv run chgk new tournaments/<slug>     # Sheet + Drive folder on the active backend; writes state.json + jury sheet
uv run chgk teams tournaments/<slug>   # after editing the Teams tab in the Sheet
uv run chgk cards tournaments/<slug>   # cards + jury sheet with the secret access QR
```

## 3. Switch to another account

1. Repeat section 1 while signed in to the other account, e.g. as profile `club`.
2. `uv run chgk backend use club`. From now on, `chgk new` creates tournaments there.
3. Tournaments created earlier keep using their own account. Their `state.json`
   records it, and their jury sheets and phones already point there. You can switch
   back any time: `uv run chgk backend use personal`.
4. `uv run chgk backend list` shows all profiles; `*` marks the active one.

Moving an *existing* tournament's Sheet and photos to another account is not
supported yet.

## 4. Update the script after code changes

`uv run chgk backend check` warns when the deployed version differs from the local
code. To update:

1. Run `uv run chgk backend bundle` and paste the file into the project as in step 1.4.
2. **Deploy → Manage deployments → ✎ (edit) → Version: New version → Deploy.**
   Editing the existing deployment keeps the same `/exec` URL, so profiles, jury
   sheets and phones keep working. (**New deployment** would create a new URL.)

## 5. If a token leaks

- **Admin token** (in `backends.json`): in the script's **Project Settings → Script
  properties**, delete `ADMIN_TOKEN`. Run `setup` again, then
  `uv run chgk backend add <same name> …` with the new token.
- **Jury token** (on the jury sheet): it belongs to one tournament. For now, create a
  new tournament folder. Rotating a jury token is a later feature.

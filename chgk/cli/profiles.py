"""`chgk backend …`: one named profile per Google account (SPEC §3.1)."""

from pathlib import Path

import typer

from chgk.backend import (
    BackendClient,
    Profile,
    Profiles,
    bundle_apps_script,
    bundle_file,
    bundle_version,
    check_backend_url,
    source_version,
)
from chgk.cli.common import backend_app, warn_permissions


@backend_app.command("bundle")
def backend_bundle(
    out: Path | None = typer.Option(None, help="Where to write the bundle (default: out/apps_script/Code.gs)"),
) -> None:
    """Write the single Code.gs to paste into an Apps Script project."""
    path, version = bundle_apps_script(out or bundle_file())
    typer.echo(f"{path}: backend version {version}. Paste it into script.google.com (docs/google-account.md).")


@backend_app.command("add")
def backend_add(
    name: str = typer.Argument(..., help="Profile name, e.g. personal or club"),
    url: str = typer.Option(..., help="The web app /exec URL"),
    token: str = typer.Option(
        ..., prompt="Admin token", hide_input=True, help="Admin token printed by setup() in the script editor"
    ),
    account: str = typer.Option("", help="Label, e.g. the Gmail address (filled in from the backend if empty)"),
    check: bool = typer.Option(True, help="Ping the backend before saving"),
) -> None:
    """Add (or replace) a backend profile and make it active."""
    check_backend_url(url)  # before the token is sent anywhere
    profiles = Profiles()
    if check:
        reply = BackendClient(url, token).ping()
        account = account or reply.get("account") or ""
        warn_permissions(reply)
    profiles.add(Profile(name, url, token, account))
    profiles.save()
    typer.echo(f"Backend '{name}' saved and active{f' ({account})' if account else ''}.")


@backend_app.command("use")
def backend_use(name: str) -> None:
    """Make a profile active: new tournaments are created on it."""
    profiles = Profiles()
    profiles.use(name)
    profiles.save()
    typer.echo(f"Active backend: {name}. Existing tournaments stay on the backend they were created on.")


@backend_app.command("list")
def backend_list() -> None:
    """List profiles; * marks the active one."""
    profiles = Profiles()
    if not profiles.profiles:
        typer.echo("No backend profiles yet (docs/google-account.md).")
    for p in profiles.profiles.values():
        mark = "*" if p.name == profiles.active_name else " "
        typer.echo(f"{mark} {p.name:<12} {p.account or '-':<28} {p.url}")


@backend_app.command("remove")
def backend_remove(name: str) -> None:
    """Forget a profile (the Google side is not touched)."""
    profiles = Profiles()
    profiles.remove(name)
    profiles.save()
    now = f" Active now: '{profiles.active_name}'." if profiles.active_name else ""
    typer.echo(f"Removed backend '{name}'.{now}")


@backend_app.command("check")
def backend_check(name: str | None = typer.Argument(None, help="Profile (default: active)")) -> None:
    """Ping a backend: shows its Google account and whether its code is up to date."""
    profiles = Profiles()
    profile = profiles.get(name) if name else profiles.active()
    reply = BackendClient(profile.url, profile.admin_token).ping()
    local = source_version()
    typer.echo(
        f"Backend '{profile.name}' OK: account {reply.get('account') or '?'}, version {reply.get('version') or '?'}."
    )
    warn_permissions(reply)
    if reply.get("version") != local:
        bundled = bundle_version()
        if bundled == local:
            step = f"paste {bundle_file()} (already version {local}) into the script"
        elif bundled:
            step = f"{bundle_file()} is an old bundle (version {bundled}): run `chgk backend bundle`, then paste it"
        else:
            step = "run `chgk backend bundle` and paste it into the script"
        typer.secho(
            f"Local code is version {local}: {step}, then Deploy → Manage deployments → edit → New version.",
            fg="yellow",
        )
        raise typer.Exit(1)

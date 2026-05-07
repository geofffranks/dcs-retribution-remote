# Downstream Rollout: Fork Release + Docker Installer + Private DockerMod Image

**Date:** 2026-05-06
**Repositories touched:** `geofffranks/dcs-retribution-remote`, `geofffranks/DCS-World-Dedicated-Server-Docker`
**Status:** Design — pending implementation
**Predecessor:** UI work spec at [`2026-05-06-ui-status-and-upload-progress-design.md`](./2026-05-06-ui-status-and-upload-progress-design.md) (the "Downstream Rollout" appendix of that spec is what this document elaborates).

## Summary

Get the new UI changes from the `feat/status-label-and-upload-progress` branch on `geofffranks/dcs-retribution-remote` running inside the user's `geofffranks/DCS-World-Dedicated-Server-Docker` container so the spec's 13-item live smoke test can be exercised.

Three deliverables:

1. **A `scripts/release.sh` repack tool** in `geofffranks/dcs-retribution-remote` that downloads the upstream `omltcat/dcs-retribution-remote` latest release zip, overlays the fork's `app/static/` and `app/templates/` directories on top of it, re-zips, and pushes the result as a GitHub release on the fork.
2. **An A2a env-var swap** in the `geofffranks/DCS-World-Dedicated-Server-Docker` fork's s6 installer plus compose plumbing, so `RETRIBUTION_REMOTE_REPO` (default `omltcat/dcs-retribution-remote`) controls which fork the installer pulls from. Same edit makes `DOCKER_MODS` env-var-driven so a personal `.env` can override the hardcoded `aterfax/...` image.
3. **A patched private DockerMod image** built from the fork and pushed to the existing `gfranks/dcs-world-dedicated-server-mod-retribution:latest` repo on Docker Hub.

After all three land, the user updates their personal (uncommitted) `.env` on the server host and cycles the container. The s6 installer detects a new tag from the fork's release, downloads the repacked zip, unzips it, and Wine runs the unmodified upstream `retribution_remote.exe` against the fork's new static + template files.

## Goals

- Get the UI changes running in the user's container with no Python rebuild and no Windows host.
- Preserve a clean rollback path at every layer.
- Keep upstream-compatible: stock users running unmodified `aterfax/...` images and unset env vars are unaffected by any committed change.
- Make the iteration loop short — re-running the rollout for a future UI tweak should be one shell command.

## Non-Goals

- Building a fresh `retribution_remote.exe` from source. The upstream binary is reused as-is because no Python code changed.
- Setting up a GitHub Actions release pipeline on the fork. Tracked as a follow-up.
- Upstreaming any of these changes to `omltcat/dcs-retribution-remote` or `Aterfax/DCS-World-Dedicated-Server-Docker`. The user's prior PR to Aterfax has been open for months unaddressed and upstream coordination is explicitly out of scope.
- Touching `requirements.txt`, `pyinstaller.spec`, or any Python file in `dcs-retribution-remote`. The whole point is that no Python changed.
- Adding multi-platform image builds. Single `linux/amd64` is sufficient.

## Architecture

The rollout has three independently-deployable units, executed in a single end-to-end order so the runtime dependency chain resolves.

### Unit A — Fork release script

`geofffranks/dcs-retribution-remote/scripts/release.sh`. Standalone shell script. No new runtime deps; uses `curl`, `unzip`, `zip`, `jq`, `gh` — all already on the user's macOS dev machine.

```bash
#!/usr/bin/env bash
set -euo pipefail

if [ $# -ne 1 ]; then
    echo "usage: $0 <tag>   e.g. $0 v0.1.0-gfranks.1" >&2
    exit 64
fi
TAG="$1"

REPO_ROOT=$(git rev-parse --show-toplevel)
WORK=$(mktemp -d)
trap "rm -rf $WORK" EXIT

UPSTREAM_REPO="omltcat/dcs-retribution-remote"
UPSTREAM_URL=$(curl -sSL "https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest" \
    | jq -r '.assets[0].browser_download_url')
[ "$UPSTREAM_URL" = "null" ] && { echo "Could not resolve upstream release URL" >&2; exit 1; }

curl -sSL "$UPSTREAM_URL" -o "$WORK/upstream.zip"
mkdir "$WORK/dist"
( cd "$WORK/dist" && unzip -q "$WORK/upstream.zip" )

# Overlay fork's UI directories on top of upstream's contents.
# Anything else (resources/, retribution_remote.exe, config.yaml) is left
# from upstream.
rm -rf "$WORK/dist/app/static" "$WORK/dist/app/templates"
cp -r "$REPO_ROOT/app/static"    "$WORK/dist/app/"
cp -r "$REPO_ROOT/app/templates" "$WORK/dist/app/"

( cd "$WORK/dist" && zip -qr "$WORK/retribution_remote.zip" . )

gh release create "$TAG" "$WORK/retribution_remote.zip" \
    --title "$TAG" \
    --notes "Repack of upstream ${UPSTREAM_REPO} with fork UI updates." \
    --latest

echo "Released ${TAG}: $(gh release view "$TAG" --json url -q .url)"
```

Tagging convention: `v<upstream-version>-gfranks.<n>`. First release: `v0.1.0-gfranks.1`. Bumping `<n>` for each iteration on the same upstream base. Tag uniqueness matters because the s6 installer caches the previously-installed tag string.

### Unit B — Docker installer + compose env-var swap

Three files in `geofffranks/DCS-World-Dedicated-Server-Docker`:

**`docker/src/s6-services/s6-init-dcs-retribution-remote-auto-installer-updater-oneshot/run`** — replace the hardcoded upstream URL with an env-var-driven one. Two-line change near the top of the existing curl call:

```bash
RETRIBUTION_REMOTE_REPO="${RETRIBUTION_REMOTE_REPO:-omltcat/dcs-retribution-remote}"
echo -e "RETRIBUTION_REMOTE_REPO=$RETRIBUTION_REMOTE_REPO"
Retribution_remote_latest_release_manifest=$(curl -s "https://api.github.com/repos/${RETRIBUTION_REMOTE_REPO}/releases/latest")
```

The rest of the installer is unchanged: `assets[0].browser_download_url` lookup, version-cache compare, wget, unzip, etc.

**`docker-compose/Dedicated-Server-DockerMod-Retribution/docker-compose.yml`** — make both `DOCKER_MODS` and the new `RETRIBUTION_REMOTE_REPO` env-var-driven with the upstream defaults preserved:

```yaml
        - DOCKER_MODS=${DOCKER_MODS:-aterfax/dcs-world-dedicated-server-mod-retribution:latest}
        - RETRIBUTION_REMOTE_REPO=${RETRIBUTION_REMOTE_REPO:-omltcat/dcs-retribution-remote}
```

**`docker-compose/Dedicated-Server-DockerMod-Retribution/.env.example`** — append two commented lines documenting both overrides:

```
# Override which fork of dcs-retribution-remote to install. Defaults to upstream.
# RETRIBUTION_REMOTE_REPO=omltcat/dcs-retribution-remote

# Override the DockerMod image to use a private fork's image.
# DOCKER_MODS=aterfax/dcs-world-dedicated-server-mod-retribution:latest
```

Default behavior (no overrides set anywhere) is identical to current upstream. A stock user running unmodified compose files is unaffected.

### Unit C — Private DockerMod image

The DockerMod image is a `FROM scratch` image whose entire contents are the s6 service files. Its build command:

```bash
cd /Users/gfranks/workspace/DCS-World-Dedicated-Server-Docker
docker buildx build \
    --platform linux/amd64 \
    -f docker/Dockerfile.DockerMod.dcs-retribution \
    -t gfranks/dcs-world-dedicated-server-mod-retribution:latest \
    -t "gfranks/dcs-world-dedicated-server-mod-retribution:$(date +%Y-%m-%d).1" \
    --push \
    docker/
```

Two tags: `:latest` for the user's `.env` to reference, and a date-suffixed tag (`:2026-05-06.1`) for rollback safety.

Push expects `docker login` to Docker Hub as `gfranks` is already current. Repository: `https://hub.docker.com/r/gfranks/dcs-world-dedicated-server-mod-retribution` (already exists per user).

## Order of Operations

The runtime dependency chain forces this order:

1. **Merge `feat/status-label-and-upload-progress` into `master`** on `geofffranks/dcs-retribution-remote`.
2. **Add `scripts/release.sh` to `master`** on `geofffranks/dcs-retribution-remote`. Either committed directly to master or via a tiny `feat/release-script` branch — implementer's choice.
3. **Run `scripts/release.sh v0.1.0-gfranks.1`** to publish the first fork release.
4. **Branch `feat/configurable-retribution-remote-repo`** in `geofffranks/DCS-World-Dedicated-Server-Docker`. Apply the three Unit-B file changes. Optional: PR to fork's `master` for tracking. Not required for the rollout to function — the changes only need to exist in the local checkout used to build the image.
5. **Build + push the DockerMod image** with both `:latest` and date-stamped tags.
6. **On the server host, edit personal `.env`:**

   ```bash
   DOCKER_MODS=gfranks/dcs-world-dedicated-server-mod-retribution:latest
   RETRIBUTION_REMOTE_REPO=geofffranks/dcs-retribution-remote
   ```

7. **Cycle the container:**

   ```bash
   docker compose pull
   docker compose down
   docker compose up -d
   ```

8. **Run the spec's 13-item smoke test** in the browser at `:9099`.

Step 3 must precede step 7 — otherwise the s6 installer in the new container will fail to resolve `https://api.github.com/repos/geofffranks/dcs-retribution-remote/releases/latest` (404 — no releases yet on the fork) and the install will abort.

## Verification Milestones

1. **After step 3:** `gh release view v0.1.0-gfranks.1 -R geofffranks/dcs-retribution-remote` shows exactly one asset (`retribution_remote.zip`), marked Latest. `curl -s https://api.github.com/repos/geofffranks/dcs-retribution-remote/releases/latest | jq '.assets[0].browser_download_url'` returns a `github.com/geofffranks/...` URL.

2. **After step 5:** `docker manifest inspect gfranks/dcs-world-dedicated-server-mod-retribution:latest` succeeds. `docker pull` from a clean machine pulls the new digest.

3. **After step 7:** `docker logs <container> 2>&1 | grep -i retribution_remote` shows the install path downloading from `https://api.github.com/repos/geofffranks/...` (not omltcat). The version-cache file `~/Saved Games/dcs-retribution-remote.version.txt` inside the container reads `v0.1.0-gfranks.1`.

4. **In the browser at the configured URL:** the Server Status pill renders above the action button row, the upload button accepts a `.miz` and shows the ring overlay, the smoke checklist all 13 items pass.

## Rollback (cheapest first)

- **Roll back UI but keep DockerMod image:** in `.env`, change `RETRIBUTION_REMOTE_REPO` back to `omltcat/dcs-retribution-remote`. Cycle container. Stock UI returns; the `gfranks/...` DockerMod image is still in use but the installer pulls from upstream.
- **Roll back image swap entirely:** in `.env`, comment out both `DOCKER_MODS` and `RETRIBUTION_REMOTE_REPO`. Cycle container. Pure upstream behavior.
- **Roll back DockerMod image to a previous date tag:** in `.env`, set `DOCKER_MODS=gfranks/dcs-world-dedicated-server-mod-retribution:<previous-date-tag>`.
- **Delete the fork's GitHub release:** `gh release delete v0.1.0-gfranks.1 -R geofffranks/dcs-retribution-remote --cleanup-tag`. Only meaningful as cleanup after `RETRIBUTION_REMOTE_REPO` has already been reverted; otherwise the next install attempt will 404.

## Known Risks

1. **Version-cache stickiness.** The s6 installer writes the most-recently-installed tag to `~/Saved Games/dcs-retribution-remote.version.txt` and skips re-install when the upstream tag matches. Re-running `scripts/release.sh` with the same tag will not trigger a reinstall on the existing container. Mitigation: always bump `<n>` in the tag (`v0.1.0-gfranks.2`, `.3`, …) for each new release, or `docker exec` in and `rm` the version file before restart.

2. **Upstream zip layout assumption.** The repack script assumes upstream's release zip contains a flat root with `retribution_remote.exe`, `app/`, `resources/`, `config.yaml`. This matches `pyinstaller.spec`'s output (verified). If upstream ever ships a nested structure (e.g. `dcs-retribution-remote-X.Y.Z/...`), the script will break and need a one-line fix.

3. **GitHub API rate limits.** The unauthenticated GitHub API endpoint `releases/latest` is rate-limited (60/hr). The s6 installer hits it on every container start. Already a pre-existing concern in upstream; not worsened by this rollout. If hit, the installer falls through and the cached install persists, which is graceful behavior.

4. **`assets[0]` ordering.** GitHub's API returns assets in upload order. The release script uploads exactly one file (`retribution_remote.zip`) so `assets[0]` is unambiguous. If a future release uploads multiple assets in the wrong order, the installer will pull the wrong file.

## Files Changed

| Repository | File | Change |
|---|---|---|
| `geofffranks/dcs-retribution-remote` | `scripts/release.sh` | New file (executable) |
| `geofffranks/DCS-World-Dedicated-Server-Docker` | `docker/src/s6-services/s6-init-dcs-retribution-remote-auto-installer-updater-oneshot/run` | 2-line edit replacing the hardcoded curl URL |
| `geofffranks/DCS-World-Dedicated-Server-Docker` | `docker-compose/Dedicated-Server-DockerMod-Retribution/docker-compose.yml` | 2-line edit making `DOCKER_MODS` and `RETRIBUTION_REMOTE_REPO` env-var-driven |
| `geofffranks/DCS-World-Dedicated-Server-Docker` | `docker-compose/Dedicated-Server-DockerMod-Retribution/.env.example` | Append 4 lines (two commented overrides) |

User's personal (uncommitted) `.env` on the server host gets two new uncommented lines after the rollout.

## Out of Scope

- Test infra (no test runner exists; same posture as the predecessor UI spec).
- GitHub Actions release pipeline on the fork (deferred follow-up).
- Multi-arch DockerMod image (single linux/amd64 only).
- Upstreaming any of these changes.
- Touching `requirements.txt`, `pyinstaller.spec`, or any Python file.

# Downstream Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get the new UI changes from `feat/status-label-and-upload-progress` running inside the user's `geofffranks/DCS-World-Dedicated-Server-Docker` container so the predecessor spec's 13-item live smoke test can be exercised in a real browser.

**Architecture:** Three independently-deployable units across two repos: a `scripts/release.sh` repack tool that pushes a GitHub release on the fork, an env-var swap in the docker fork's s6 installer + compose plumbing, and a private DockerMod image rebuilt and pushed to Docker Hub. After all three land, the user updates their personal `.env` on the server host and cycles the container.

**Tech Stack:** Bash + curl + jq + zip + gh CLI for the release script, sed/Edit for the s6 + compose YAML edits, Docker buildx for the DockerMod image. No new runtime dependencies in either repo.

**Spec:** [`docs/superpowers/specs/2026-05-06-rollout-fork-release-and-docker-design.md`](../specs/2026-05-06-rollout-fork-release-and-docker-design.md)

**Repositories touched:**
- `dcs-retribution-remote` at `/Users/gfranks/workspace/dcs-retribution-remote` (master branch already includes the merged UI work as of this writing)
- `DCS-World-Dedicated-Server-Docker` at `/Users/gfranks/workspace/DCS-World-Dedicated-Server-Docker` (fork remote: `gfranks`, upstream: `origin`)

**Testing posture:** No automated tests. Each task has a concrete verification step using `gh`, `curl`, `jq`, or `docker` commands. The final 13-item smoke test runs against the user's live server post-rollout.

---

## File Structure

| Repository | File | Responsibility | Task |
|---|---|---|---|
| `dcs-retribution-remote` | `scripts/release.sh` | Repack upstream zip with fork's UI dirs and push GitHub release | Task 1 |
| `DCS-World-Dedicated-Server-Docker` | `docker/src/s6-services/s6-init-dcs-retribution-remote-auto-installer-updater-oneshot/run` | Make installer URL env-var driven | Task 3 |
| `DCS-World-Dedicated-Server-Docker` | `docker-compose/Dedicated-Server-DockerMod-Retribution/docker-compose.yml` | Make `DOCKER_MODS` and `RETRIBUTION_REMOTE_REPO` env-var driven | Task 3 |
| `DCS-World-Dedicated-Server-Docker` | `docker-compose/Dedicated-Server-DockerMod-Retribution/.env.example` | Document the two override env vars | Task 3 |
| (Docker Hub) | `gfranks/dcs-world-dedicated-server-mod-retribution:latest` + date tag | Patched DockerMod image | Task 4 |
| (server host) | personal `.env` (NOT in git) | Set `DOCKER_MODS` and `RETRIBUTION_REMOTE_REPO` | Final |
| (GitHub) | `geofffranks/dcs-retribution-remote/releases/v0.1.0-gfranks.1` | First repacked release on the fork | Task 2 |

---

## Setup (run once before Task 1)

- [ ] **Verify the UI feature branch is merged to master on `dcs-retribution-remote`.**

```bash
cd /Users/gfranks/workspace/dcs-retribution-remote
git checkout master
git log --oneline master..feat/status-label-and-upload-progress
```

Expected: empty output (i.e. all feat-branch commits are also on master). If non-empty, run `git merge feat/status-label-and-upload-progress` first.

- [ ] **Verify required tools are installed.**

```bash
command -v curl && command -v jq && command -v unzip && command -v zip && command -v gh && command -v docker
```

Expected: each prints a path. If any are missing, install via Homebrew.

- [ ] **Verify gh authentication.**

```bash
gh auth status
```

Expected: Logged in to github.com as `geofffranks` (or whatever username has write access to the fork).

- [ ] **Verify Docker Hub login.**

```bash
docker info 2>/dev/null | grep -i username
```

Expected: shows `Username: gfranks` (or however the user's Docker Hub identity is configured). If missing: `docker login` with Docker Hub credentials before Task 4.

---

## Task 1: Add `scripts/release.sh` to `dcs-retribution-remote`

**Why first:** Task 2 runs this script. It must exist and be executable before the first release can be published.

**Files:**
- Create: `/Users/gfranks/workspace/dcs-retribution-remote/scripts/release.sh`
- (Implicit: ensure `scripts/` directory exists; create with `mkdir -p` if not.)

- [ ] **Step 1: Create the `scripts/` directory if needed.**

```bash
cd /Users/gfranks/workspace/dcs-retribution-remote
mkdir -p scripts
ls -la scripts/
```

Expected: directory exists; may be empty.

- [ ] **Step 2: Write `scripts/release.sh` with the following contents.**

```bash
#!/usr/bin/env bash
# Repack upstream omltcat/dcs-retribution-remote latest release with this
# fork's app/static + app/templates and publish as a GitHub release.
#
# Usage: scripts/release.sh <tag>     e.g. scripts/release.sh v0.1.0-gfranks.1
#
# Why: the upstream retribution_remote.exe is a pyinstaller binary that loads
# app/static + app/templates from disk at runtime. Since this fork only
# changes UI files (no Python), we can reuse the upstream exe verbatim and
# just overlay our updated UI dirs on top of it.

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

echo "Resolving upstream latest release URL..."
UPSTREAM_URL=$(curl -sSL "https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest" \
    | jq -r '.assets[0].browser_download_url')
if [ -z "$UPSTREAM_URL" ] || [ "$UPSTREAM_URL" = "null" ]; then
    echo "Could not resolve upstream release URL (assets[0])" >&2
    exit 1
fi
echo "Upstream URL: $UPSTREAM_URL"

echo "Downloading upstream zip..."
curl -sSL "$UPSTREAM_URL" -o "$WORK/upstream.zip"

echo "Extracting upstream zip..."
mkdir "$WORK/dist"
( cd "$WORK/dist" && unzip -q "$WORK/upstream.zip" )

echo "Overlaying fork's app/static and app/templates..."
rm -rf "$WORK/dist/app/static" "$WORK/dist/app/templates"
cp -r "$REPO_ROOT/app/static"    "$WORK/dist/app/"
cp -r "$REPO_ROOT/app/templates" "$WORK/dist/app/"

echo "Re-zipping..."
( cd "$WORK/dist" && zip -qr "$WORK/retribution_remote.zip" . )

echo "Creating GitHub release ${TAG}..."
gh release create "$TAG" "$WORK/retribution_remote.zip" \
    --title "$TAG" \
    --notes "Repack of upstream ${UPSTREAM_REPO} with fork UI updates." \
    --latest

echo "Released ${TAG}: $(gh release view "$TAG" --json url -q .url)"
```

- [ ] **Step 3: Make it executable.**

```bash
chmod +x /Users/gfranks/workspace/dcs-retribution-remote/scripts/release.sh
ls -la scripts/release.sh
```

Expected: `-rwxr-xr-x` perms.

- [ ] **Step 4: Sanity-check the script's syntax.**

```bash
bash -n /Users/gfranks/workspace/dcs-retribution-remote/scripts/release.sh && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 5: Commit.**

```bash
cd /Users/gfranks/workspace/dcs-retribution-remote
git add scripts/release.sh
git commit -m "Add release script: repack upstream exe with fork UI

Downloads omltcat/dcs-retribution-remote's latest release zip,
overlays this fork's app/static and app/templates on top of upstream's
contents (preserving retribution_remote.exe and resources/), re-zips,
and publishes as a GitHub release on the fork via gh CLI.

Sidesteps the need for a Windows pyinstaller build host as long as
no Python in this fork changes."
```

---

## Task 2: Publish first fork release `v0.1.0-gfranks.1`

**Why second:** Task 4's DockerMod image build doesn't depend on this, but the running container in the Final step requires the release to exist. Doing it now also validates the release script end-to-end before we move into Docker work.

**Files:** none (this task only invokes git-tracked work; output is a GitHub release).

- [ ] **Step 1: Run the release script.**

```bash
cd /Users/gfranks/workspace/dcs-retribution-remote
git checkout master
./scripts/release.sh v0.1.0-gfranks.1
```

Expected output ends with: `Released v0.1.0-gfranks.1: https://github.com/geofffranks/dcs-retribution-remote/releases/tag/v0.1.0-gfranks.1`.

- [ ] **Step 2: Verify the release looks correct via the GitHub API.**

```bash
gh release view v0.1.0-gfranks.1 -R geofffranks/dcs-retribution-remote
```

Expected: shows tag, title, "Latest" badge, exactly one asset named `retribution_remote.zip`.

```bash
curl -s https://api.github.com/repos/geofffranks/dcs-retribution-remote/releases/latest \
    | jq -r '.name, .assets[0].name, .assets[0].browser_download_url'
```

Expected: prints `v0.1.0-gfranks.1`, `retribution_remote.zip`, and a URL ending in `.../v0.1.0-gfranks.1/retribution_remote.zip`.

- [ ] **Step 3: Spot-check the zip contents.**

```bash
WORK=$(mktemp -d) && cd "$WORK"
gh release download v0.1.0-gfranks.1 -R geofffranks/dcs-retribution-remote -p "retribution_remote.zip"
unzip -l retribution_remote.zip | head -20
```

Expected: zip listing shows `retribution_remote.exe` at the root, plus `app/`, `resources/`, `config.yaml` siblings — no enclosing `dist/` or `dcs-retribution-remote-X.Y.Z/` prefix.

```bash
unzip -p retribution_remote.zip app/static/script.js | grep -c "UploadRing" || true
```

Expected: a non-zero number (the new fork UI code is present in the zip).

- [ ] **Step 4: No commit for this task** — the artifact is a GitHub release, not source. Move on.

---

## Task 3: Env-var swap in `DCS-World-Dedicated-Server-Docker` fork

**Why third:** Modifies the Docker installer to point at `RETRIBUTION_REMOTE_REPO` and makes `DOCKER_MODS` overridable. Required before Task 4 builds the image — Task 4 builds from the modified s6 service files in this checkout.

**Files:**
- Modify: `docker/src/s6-services/s6-init-dcs-retribution-remote-auto-installer-updater-oneshot/run`
- Modify: `docker-compose/Dedicated-Server-DockerMod-Retribution/docker-compose.yml`
- Modify: `docker-compose/Dedicated-Server-DockerMod-Retribution/.env.example`

- [ ] **Step 1: Create a feature branch in the docker fork.**

```bash
cd /Users/gfranks/workspace/DCS-World-Dedicated-Server-Docker
git fetch gfranks
git checkout -b feat/configurable-retribution-remote-repo gfranks/master
git status
```

Expected: `On branch feat/configurable-retribution-remote-repo` and a clean working tree based on the user's fork main branch.

- [ ] **Step 2: Edit the s6 installer to use the env var.**

In `docker/src/s6-services/s6-init-dcs-retribution-remote-auto-installer-updater-oneshot/run`, find this line:

```bash
Retribution_remote_latest_release_manifest=$(curl -s https://api.github.com/repos/omltcat/dcs-retribution-remote/releases/latest)
```

Replace it with **three lines**:

```bash
RETRIBUTION_REMOTE_REPO="${RETRIBUTION_REMOTE_REPO:-omltcat/dcs-retribution-remote}"
echo -e "RETRIBUTION_REMOTE_REPO=$RETRIBUTION_REMOTE_REPO"
Retribution_remote_latest_release_manifest=$(curl -s "https://api.github.com/repos/${RETRIBUTION_REMOTE_REPO}/releases/latest")
```

Nothing else in this file changes — the `assets[0].browser_download_url` and `.name` lookups, the version-cache compare, the wget/unzip, and the desktop-shortcut creation all stay the same.

- [ ] **Step 3: Edit `docker-compose.yml` to make both env vars overridable.**

In `docker-compose/Dedicated-Server-DockerMod-Retribution/docker-compose.yml`, find the existing line:

```yaml
      - DOCKER_MODS=aterfax/dcs-world-dedicated-server-mod-retribution:latest
```

Replace it with **two lines** (the `DOCKER_MODS` becomes overridable, and a new `RETRIBUTION_REMOTE_REPO` is added immediately after):

```yaml
      - DOCKER_MODS=${DOCKER_MODS:-aterfax/dcs-world-dedicated-server-mod-retribution:latest}
      - RETRIBUTION_REMOTE_REPO=${RETRIBUTION_REMOTE_REPO:-omltcat/dcs-retribution-remote}
```

Indentation must match the surrounding `environment:` block — typically 6 spaces in this file. Confirm with `rtk read` before saving.

- [ ] **Step 4: Append override docs to `.env.example`.**

In `docker-compose/Dedicated-Server-DockerMod-Retribution/.env.example`, append the following lines at the end of the file:

```
# Override which fork of dcs-retribution-remote to install. Defaults to upstream.
# RETRIBUTION_REMOTE_REPO=omltcat/dcs-retribution-remote

# Override the DockerMod image to use a private fork's image.
# DOCKER_MODS=aterfax/dcs-world-dedicated-server-mod-retribution:latest
```

- [ ] **Step 5: Verify diffs locally.**

```bash
cd /Users/gfranks/workspace/DCS-World-Dedicated-Server-Docker
git diff
```

Expected: changes confined to the three files above. The s6 `run` file shows the 1-line removal + 3-line addition near the curl call. The compose YAML shows the 1-line removal + 2-line addition. The `.env.example` shows the 4-line append. No other files modified.

- [ ] **Step 6: Sanity-check the s6 script syntax.**

```bash
bash -n /Users/gfranks/workspace/DCS-World-Dedicated-Server-Docker/docker/src/s6-services/s6-init-dcs-retribution-remote-auto-installer-updater-oneshot/run && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 7: Sanity-check the compose YAML.**

```bash
cd /Users/gfranks/workspace/DCS-World-Dedicated-Server-Docker
docker compose -f docker-compose/Dedicated-Server-DockerMod-Retribution/docker-compose.yml config 2>&1 | head -40
```

Expected: prints a normalized compose config without YAML syntax errors. The `environment:` block should now show both `DOCKER_MODS` and `RETRIBUTION_REMOTE_REPO` resolving to the upstream defaults (because no `.env` is overriding them in the dev checkout).

- [ ] **Step 8: Commit.**

```bash
cd /Users/gfranks/workspace/DCS-World-Dedicated-Server-Docker
git add docker/src/s6-services/s6-init-dcs-retribution-remote-auto-installer-updater-oneshot/run
git add docker-compose/Dedicated-Server-DockerMod-Retribution/docker-compose.yml
git add docker-compose/Dedicated-Server-DockerMod-Retribution/.env.example
git commit -m "Make retribution-remote repo and DockerMod image overridable

Adds RETRIBUTION_REMOTE_REPO env var (default omltcat/...) so the s6
installer pulls from a configurable fork. Makes DOCKER_MODS
env-var-driven with the same aterfax/... default. Documents both in
.env.example. Stock users running unmodified compose files are
unaffected."
```

---

## Task 4: Build and push the private DockerMod image

**Why fourth:** Task 3's modified s6 files must be in the local checkout for the build to bake them into the image.

**Files:** none (output is a Docker Hub artifact).

- [ ] **Step 1: Generate the date-tag string for rollback safety.**

```bash
DATE_TAG="$(date +%Y-%m-%d).1"
echo "DATE_TAG=$DATE_TAG"
```

Expected: prints e.g. `DATE_TAG=2026-05-06.1`.

- [ ] **Step 2: Build and push with both `:latest` and the date tag.**

```bash
cd /Users/gfranks/workspace/DCS-World-Dedicated-Server-Docker
docker buildx build \
    --platform linux/amd64 \
    -f docker/Dockerfile.DockerMod.dcs-retribution \
    -t gfranks/dcs-world-dedicated-server-mod-retribution:latest \
    -t "gfranks/dcs-world-dedicated-server-mod-retribution:$DATE_TAG" \
    --push \
    docker/
```

Expected: build succeeds and pushes both tags. Final lines mention `naming to docker.io/gfranks/...:latest` and `:$DATE_TAG`. If `docker login` is missing for Docker Hub, this step fails with an auth error — log in and retry.

- [ ] **Step 3: Verify both tags are on Docker Hub.**

```bash
docker manifest inspect gfranks/dcs-world-dedicated-server-mod-retribution:latest >/dev/null && echo "latest: OK"
docker manifest inspect "gfranks/dcs-world-dedicated-server-mod-retribution:$DATE_TAG" >/dev/null && echo "date tag: OK"
```

Expected: both lines print `OK`.

- [ ] **Step 4: Verify the image actually contains the patched s6 installer.**

```bash
docker pull gfranks/dcs-world-dedicated-server-mod-retribution:latest
docker create --name retro-mod-inspect gfranks/dcs-world-dedicated-server-mod-retribution:latest 2>/dev/null || true
docker export retro-mod-inspect | tar -tf - | grep -E "s6-init-dcs-retribution-remote-auto-installer-updater-oneshot/run$"
docker rm retro-mod-inspect >/dev/null
```

Expected: prints the s6 service `run` file path. (The `FROM scratch` image has no shell, so `docker run ... cat` doesn't work; `docker export | tar` is the workaround.)

If you want to verify the env-var line is actually inside the image:

```bash
docker create --name retro-mod-inspect gfranks/dcs-world-dedicated-server-mod-retribution:latest 2>/dev/null || true
docker export retro-mod-inspect | tar -xOf - etc/s6-overlay/s6-rc.d/init-dcs-retribution-remote-auto-installer-updater-oneshot/run | grep RETRIBUTION_REMOTE_REPO
docker rm retro-mod-inspect >/dev/null
```

Expected: prints two lines containing `RETRIBUTION_REMOTE_REPO=` — confirming the patched script is inside the image.

- [ ] **Step 5: No commit** — the artifact is on Docker Hub. Optionally push the docker fork branch for tracking:

```bash
cd /Users/gfranks/workspace/DCS-World-Dedicated-Server-Docker
git push gfranks feat/configurable-retribution-remote-repo
```

Optional. Not required for the rollout to function.

---

## Final: Wire up the server host and run the smoke test

**Files:** none in git.

This step happens on the user's actual dedicated server host, not in the dev workspace.

- [ ] **Step 1: SSH into the server host (or open a terminal there).**

```bash
ssh <server-host>
cd <path-to-docker-compose-dir>
```

The path is whichever directory contains the user's working `docker-compose.yml` and `.env`.

- [ ] **Step 2: Edit the personal `.env` file.**

Append (or update) these two lines:

```bash
DOCKER_MODS=gfranks/dcs-world-dedicated-server-mod-retribution:latest
RETRIBUTION_REMOTE_REPO=geofffranks/dcs-retribution-remote
```

If those keys already exist with different values, change them; do not duplicate.

- [ ] **Step 3: Pull the new DockerMod image and cycle the container.**

```bash
docker compose pull
docker compose down
docker compose up -d
```

Expected: pull fetches the new `gfranks/...` image. `up -d` starts a fresh container.

- [ ] **Step 4: Watch the s6 installer log to confirm the env var landed.**

```bash
docker compose logs -f --tail=200 dcs-world-dedicated-server | grep -E "RETRIBUTION_REMOTE_REPO|Downloading|Retribution Remote"
```

Expected within the first ~30 seconds: a line `RETRIBUTION_REMOTE_REPO=geofffranks/dcs-retribution-remote`, a `Downloading https://github.com/geofffranks/...` line for the zip, and "DCS Retribution Remote installation complete." Press Ctrl+C to stop tailing.

If you instead see `RETRIBUTION_REMOTE_REPO=omltcat/...` or a download URL pointing at omltcat, the env var didn't propagate — check the personal `.env` file path and the compose file's environment section.

- [ ] **Step 5: Run the spec's 13-item smoke test in a browser at the configured host/port.**

The 13 manual scenarios are listed in `docs/superpowers/specs/2026-05-06-ui-status-and-upload-progress-design.md` ("Manual Test Checklist") and re-summarised in the predecessor plan's "Final Integration Smoke Test" section. Walk through each scenario; note any regressions.

- [ ] **Step 6: If smoke test passes, capture the rollout state for the record.**

(Optional) note in a personal log:

- Tag of fork release used: `v0.1.0-gfranks.1`
- DockerMod date tag in use: `gfranks/dcs-world-dedicated-server-mod-retribution:<DATE_TAG>` from Task 4 Step 1
- Date of rollout
- Any smoke-test deltas to chase in a follow-up branch

---

## Iteration: Re-running the rollout for a future UI tweak

After the initial rollout works, the fast loop for a subsequent UI change is:

1. Make UI edits in `dcs-retribution-remote`. Commit to master.
2. `./scripts/release.sh v0.1.0-gfranks.<N+1>` — bumping the suffix.
3. On the server host: `docker compose down && docker compose up -d` (no need to re-pull the DockerMod image).

The s6 installer hits the GitHub API on container start, sees a tag it hasn't installed yet (different from the cached version string), downloads, unzips, and the new UI is live.

If the DockerMod image itself ever needs a change (e.g. another s6 tweak), repeat Tasks 3–4.

---

## Out of scope (per spec)

- Building a fresh `retribution_remote.exe` from source (no Python changed).
- GitHub Actions release pipeline on the fork (deferred follow-up).
- Multi-arch DockerMod image (single linux/amd64 only).
- Upstreaming any of these changes (Aterfax PR has been open for months; explicitly out of scope).
- Editing `requirements.txt`, `pyinstaller.spec`, or any Python file in `dcs-retribution-remote`.

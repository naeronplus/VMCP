# Git hosting, remote, and branch protection (L-11)

In-repo CI is ready: `.github/workflows/ci.yml` runs on **`push`** to `main`/`master` and on **`pull_request`**.

Operator steps below complete **L-11** on the hosting provider (GitHub assumed).

## 1. Add `origin` and push `main`

```bash
# From monorepo root — replace with your empty GitHub repo URL
export PGOS_GIT_ORIGIN='https://github.com/<org>/<repo>.git'
bash scripts/configure-git-remote.sh

# Or manually:
# git remote add origin "$PGOS_GIT_ORIGIN"
# git push -u origin main
```

`scripts/configure-git-remote.sh` refuses to overwrite an existing `origin` unless
`PGOS_GIT_FORCE_REMOTE=1`. It does **not** force-push.

## 2. Branch protection on `main` (required)

Using [GitHub CLI](https://cli.github.com/) (authenticated as admin of the repo):

```bash
# Replace OWNER/REPO
OWNER=myorg
REPO=vmcp

# Require status checks from the CI workflow (job names as reported by Actions).
# After first green run on main, adjust contexts to match the Checks UI if needed.
gh api -X PUT "repos/${OWNER}/${REPO}/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  -f required_status_checks='{"strict":true,"contexts":["node","Worker smokes (TEST-03)","commit-agent"]}' \
  -F enforce_admins=true \
  -F required_pull_request_reviews='{"required_approving_review_count":0}' \
  -F restrictions='' \
  -F allow_force_pushes=false \
  -F allow_deletions=false
```

If the API rejects empty reviews, enable protection in the UI:

| Setting | Value |
|---------|--------|
| Require a pull request before merging | Optional for solo; recommended for teams |
| Require status checks to pass | **On** — select the **CI** workflow jobs |
| Require branches to be up to date | **On** (strict) |
| Allow force pushes | **Off** |
| Allow deletions | **Off** |

## 3. Verify

```bash
git remote -v
git status -sb
# After push: Actions tab shows CI on the main branch commit
npm run verify:r5   # in-repo L-11 checks (CI triggers + docs + script)
```

## Clone URL

Document the public clone URL in the root **README** once `origin` is set (see “Repository” section). Until then, local path is the source of truth.

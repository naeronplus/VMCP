# Git hosting, remote, and branch protection (L-11)

In-repo CI is ready: `.github/workflows/ci.yml` runs on **`push`** to `main`/`master` and on **`pull_request`**.

Operator steps below complete **L-11** on the hosting provider (GitHub assumed).

## 1. Add `origin` and push `main`

**Hosted origin (L-11, 2026-07-12):** `https://github.com/naeronplus/VMCP.git`  
Evidence: [`docs/remediation/L11-branch-protection.txt`](../remediation/L11-branch-protection.txt).

```bash
# From monorepo root
export PGOS_GIT_ORIGIN='https://github.com/naeronplus/VMCP.git'
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
OWNER=naeronplus
REPO=VMCP

# Payload file checked in for re-apply after temporary relax:
# docs/remediation/L11-protection-payload.json
gh api -X PUT "repos/${OWNER}/${REPO}/branches/main/protection" \
  -H "Accept: application/vnd.github+json" \
  --input docs/remediation/L11-protection-payload.json
```

**Note:** Classic branch protection on **private** free-tier repos requires GitHub Pro;
this project uses a **public** repo so protection applies without Pro. Hosted Actions
must not be billing-locked or required checks never turn green.

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

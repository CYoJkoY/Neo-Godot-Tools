#!/usr/bin/env bash
#
# Publishes the regenerated CHANGELOG.md produced by `npm run changelog`.
#
# Preferred path: push the change to a bot branch and open/update a pull
# request, so the changelog is reviewed like any other change.
#
# Fallback path: some repositories disable "Allow GitHub Actions to create and
# approve pull requests". In that case `gh pr create` fails with a policy error
# and the generated changelog would never reach the default branch. When the
# policy is the reason (or when CHANGELOG_DIRECT_PUSH=true is set explicitly),
# the change is committed directly to the default branch instead, so tag-driven
# release notes cannot break automation.
#
# Usage: bash tools/publish_changelog.sh
#
# Environment:
#   GH_TOKEN               token used by `gh` (defaults to the workflow token)
#   DEFAULT_BRANCH         branch receiving the changelog (required)
#   CHANGELOG_PR_BRANCH    bot branch name (default automation/changelog)
#   CHANGELOG_DIRECT_PUSH  "true" to skip pull requests entirely
#   GITHUB_OUTPUT          optional step output file (operation=<...>)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEFAULT_BRANCH="${DEFAULT_BRANCH:-}"
BOT_BRANCH="${CHANGELOG_PR_BRANCH:-automation/changelog}"
DIRECT_PUSH="${CHANGELOG_DIRECT_PUSH:-false}"
COMMIT_MESSAGE="docs(changelog): refresh tag-based release notes"
TITLE="docs(changelog): synchronize live release tags"
BODY="Rebuilds only the generated release-note block from the current Git tags.
Manual history and Unreleased notes are preserved.

Deleted or moved tags are recomputed; stable releases include all commits since
the previous reachable stable tag."

if [ ! -f CHANGELOG.md ]; then
  echo "CHANGELOG.md is missing; nothing to publish." >&2
  exit 1
fi

if [ -z "$DEFAULT_BRANCH" ]; then
  echo "DEFAULT_BRANCH is required." >&2
  exit 1
fi

write_operation() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "operation=$1" >> "$GITHUB_OUTPUT"
    echo "pull-request-operation=$1" >> "$GITHUB_OUTPUT"
  fi
}

if git diff --quiet -- CHANGELOG.md && git diff --cached --quiet -- CHANGELOG.md; then
  echo "CHANGELOG.md is already up to date."
  write_operation none
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

git checkout -B "$BOT_BRANCH"
git add CHANGELOG.md
git commit -m "$COMMIT_MESSAGE"
# The bot branch is disposable: rewrite it every run so an obsolete changelog
# never survives a moved or deleted tag.
git fetch --force origin "+refs/heads/$BOT_BRANCH:refs/remotes/origin/$BOT_BRANCH" 2>/dev/null || true
git push --force-with-lease="refs/heads/$BOT_BRANCH:refs/remotes/origin/$BOT_BRANCH" origin "$BOT_BRANCH" 2>/dev/null \
  || git push --force origin "$BOT_BRANCH"

publish_directly() {
  local reason="$1"
  echo "::warning::${reason}"
  echo "::warning::Committing the generated changelog directly to ${DEFAULT_BRANCH}."
  git checkout -B "$DEFAULT_BRANCH" "origin/$DEFAULT_BRANCH"
  git checkout "$BOT_BRANCH" -- CHANGELOG.md
  git add CHANGELOG.md
  if git diff --cached --quiet; then
    echo "The generated changelog matches ${DEFAULT_BRANCH} already."
    write_operation none
    return 0
  fi
  git commit -m "$COMMIT_MESSAGE"
  git push origin "$DEFAULT_BRANCH"
  write_operation direct
}

if [ "$DIRECT_PUSH" = "true" ]; then
  publish_directly "CHANGELOG_DIRECT_PUSH is enabled."
  exit 0
fi

existing_pr="$(gh pr list --head "$BOT_BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || true)"
if [ -n "$existing_pr" ]; then
  echo "Updated existing changelog pull request #${existing_pr}."
  write_operation updated
  exit 0
fi

if pr_output="$(gh pr create --base "$DEFAULT_BRANCH" --head "$BOT_BRANCH" --title "$TITLE" --body "$BODY" 2>&1)"; then
  echo "$pr_output"
  write_operation created
  exit 0
fi

echo "$pr_output" >&2
if printf '%s' "$pr_output" | grep -qiE 'not permitted to create|create or approve pull requests|not allowed to (create|approve)|Resource not accessible'; then
  publish_directly "GitHub Actions may not open pull requests in this repository."
  exit 0
fi

echo "Unable to publish the changelog and the failure was not a pull-request policy error." >&2
exit 1

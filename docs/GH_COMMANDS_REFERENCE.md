# GitHub CLI (gh) - Comprehensive Command Reference

**Current Date:** 2026-04-15

---

## Overview

```
USAGE
  gh <command> <subcommand> [flags]
```

### Main Help Topics
- `accessibility` — Learn about GitHub CLI's accessibility experiences
- `actions` — Learn about working with GitHub Actions
- `environment` — Environment variables that can be used with gh
- `exit-codes` — Exit codes used by gh
- `formatting` — Formatting options for JSON data exported from gh
- `mintty` — Information about using gh with MinTTY
- `reference` — A comprehensive reference of all gh commands

---

## CORE COMMANDS

### gh auth — Authenticate gh and git with GitHub

**Subcommands:**
- `login` — Log in to a GitHub account
- `logout` — Log out of a GitHub account
- `refresh` — Refresh stored authentication credentials
- `setup-git` — Setup git with GitHub CLI
- `status` — Display active account and authentication state on each known GitHub host
- `switch` — Switch active GitHub account
- `token` — Print the authentication token gh uses for a hostname and account

---

### gh browse — Open in browser

Open repositories, issues, pull requests, and more in the browser.

**Flags:**
- `-a, --actions` — Open repository actions
- `--blame` — Open blame view for a file
- `-b, --branch string` — Select another branch by passing in the branch name
- `-c, --commit string[="last"]` — Select another commit by passing in the commit SHA, default is the last commit
- `-n, --no-browser` — Print destination URL instead of opening the browser
- `-p, --projects` — Open repository projects
- `-r, --releases` — Open repository releases
- `-R, --repo [HOST/]OWNER/REPO` — Select another repository
- `-s, --settings` — Open repository settings
- `-w, --wiki` — Open repository wiki

**Arguments:**
- `<number>` — Issue or pull request number (e.g., "123")
- `<path>` — Path for opening folders and files (e.g., "cmd/gh/main.go")
- `<commit-sha>` — Commit SHA

**Examples:**
```bash
gh browse                                          # Open repo home page
gh browse script/                                  # Open script directory
gh browse 217                                      # Open issue/PR 217
gh browse 77507cd...                               # Open commit page
gh browse --settings                               # Open repo settings
gh browse main.go:312                              # Open file at line 312
gh browse main.go:312 --blame                      # Open blame view at line 312
gh browse main.go --branch bug-fix                 # Open on different branch
gh browse main.go --commit=775007cd...             # Open at specific commit
```

---

### gh codespace — Connect to and manage codespaces

**Aliases:** `gh cs`

**Subcommands:**
- `code` — Open a codespace in Visual Studio Code
- `cp` — Copy files between local and remote file systems
- `create` — Create a codespace
- `delete` — Delete codespaces
- `edit` — Edit a codespace
- `jupyter` — Open a codespace in JupyterLab
- `list` — List codespaces
- `logs` — Access codespace logs
- `ports` — List ports in a codespace
- `rebuild` — Rebuild a codespace
- `ssh` — SSH into a codespace
- `stop` — Stop a running codespace
- `view` — View details about a codespace

---

### gh gist — Manage gists

**Subcommands:**
- `clone` — Clone a gist locally
- `create` — Create a new gist
- `delete` — Delete a gist
- `edit` — Edit one of your gists
- `list` — List your gists
- `rename` — Rename a file in a gist
- `view` — View a gist

**Arguments:**
- `<id>` — Gist ID (e.g., `5b0e0062eb8e9654adad7bb1d81cc75f`)
- `<url>` — Gist URL (e.g., `https://gist.github.com/OWNER/5b0e0062eb8e9654adad7bb1d81cc75f`)

---

### gh issue — Manage issues

**General Commands:**
- `create` — Create a new issue
- `list` — List issues in a repository
- `status` — Show status of relevant issues

**Targeted Commands:**
- `close` — Close issue
- `comment` — Add a comment to an issue
- `delete` — Delete issue
- `develop` — Manage linked branches for an issue
- `edit` — Edit issues
- `lock` — Lock issue conversation
- `pin` — Pin a issue
- `reopen` — Reopen issue
- `transfer` — Transfer issue to another repository
- `unlock` — Unlock issue conversation
- `unpin` — Unpin a issue
- `view` — View an issue

**Flags:**
- `-R, --repo [HOST/]OWNER/REPO` — Select another repository

**Arguments:**
- `<number>` — Issue number (e.g., "123")
- `<url>` — Issue URL (e.g., "https://github.com/OWNER/REPO/issues/123")

**Examples:**
```bash
gh issue list
gh issue create --label bug
gh issue view 123 --web
```

---

### gh org — Manage organizations

**Subcommands:**
- `list` — List organizations for the authenticated user

**Examples:**
```bash
gh org list
```

---

### gh pr — Manage pull requests

**General Commands:**
- `create` — Create a pull request
- `list` — List pull requests in a repository
- `status` — Show status of relevant pull requests

**Targeted Commands:**
- `checkout` — Check out a pull request in git
- `checks` — Show CI status for a single pull request
- `close` — Close a pull request
- `comment` — Add a comment to a pull request
- `diff` — View changes in a pull request
- `edit` — Edit a pull request
- `lock` — Lock pull request conversation
- `merge` — Merge a pull request
- `ready` — Mark a pull request as ready for review
- `reopen` — Reopen a pull request
- `revert` — Revert a pull request
- `review` — Add a review to a pull request
- `unlock` — Unlock pull request conversation
- `update-branch` — Update a pull request branch
- `view` — View a pull request

**Flags:**
- `-R, --repo [HOST/]OWNER/REPO` — Select another repository

**Arguments:**
- `<number>` — PR number (e.g., "123")
- `<url>` — PR URL (e.g., "https://github.com/OWNER/REPO/pull/123")
- `<branch>` — PR head branch (e.g., "patch-1" or "OWNER:patch-1")

**Examples:**
```bash
gh pr checkout 353
gh pr create --fill
gh pr view --web
```

---

### gh project — Work with GitHub Projects

**Note:** Minimum required scope for token is `project`. Verify with `gh auth status` and add scope with `gh auth refresh -s project`.

**Subcommands:**
- `close` — Close a project
- `copy` — Copy a project
- `create` — Create a project
- `delete` — Delete a project
- `edit` — Edit a project
- `field-create` — Create a field in a project
- `field-delete` — Delete a field in a project
- `field-list` — List the fields in a project
- `item-add` — Add a pull request or an issue to a project
- `item-archive` — Archive an item in a project
- `item-create` — Create a draft issue item in a project
- `item-delete` — Delete an item from a project by ID
- `item-edit` — Edit an item in a project
- `item-list` — List the items in a project
- `link` — Link a project to a repository or a team
- `list` — List the projects for an owner
- `mark-template` — Mark a project as a template
- `unlink` — Unlink a project from a repository or a team
- `view` — View a project

**Examples:**
```bash
gh project create --owner monalisa --title "Roadmap"
gh project view 1 --owner cli --web
gh project field-list 1 --owner cli
gh project item-list 1 --owner cli
```

---

### gh release — Manage releases

**General Commands:**
- `create` — Create a new release
- `list` — List releases in a repository

**Targeted Commands:**
- `delete` — Delete a release
- `delete-asset` — Delete an asset from a release
- `download` — Download release assets
- `edit` — Edit a release
- `upload` — Upload assets to a release
- `verify` — Verify the attestation for a release
- `verify-asset` — Verify that a given asset originated from a release
- `view` — View information about a release

**Flags:**
- `-R, --repo [HOST/]OWNER/REPO` — Select another repository

---

### gh repo — Manage repositories

**General Commands:**
- `create` — Create a new repository
- `list` — List repositories owned by user or organization

**Targeted Commands:**
- `archive` — Archive a repository
- `autolink` — Manage autolink references
- `clone` — Clone a repository locally
- `delete` — Delete a repository
- `deploy-key` — Manage deploy keys in a repository
- `edit` — Edit repository settings
- `fork` — Create a fork of a repository
- `gitignore` — List and view available repository gitignore templates
- `license` — Explore repository licenses
- `rename` — Rename a repository
- `set-default` — Configure default repository for this directory
- `sync` — Sync a repository
- `unarchive` — Unarchive a repository
- `view` — View a repository

**Arguments:**
- `OWNER/REPO` — Repository identifier
- `<url>` — Repository URL (e.g., "https://github.com/OWNER/REPO")

**Examples:**
```bash
gh repo create
gh repo clone cli/cli
gh repo view --web
```

---

## GITHUB ACTIONS COMMANDS

### gh cache — Manage GitHub Actions caches

**Subcommands:**
- `delete` — Delete GitHub Actions caches
- `list` — List GitHub Actions caches

**Flags:**
- `-R, --repo [HOST/]OWNER/REPO` — Select another repository

**Examples:**
```bash
gh cache list
gh cache delete --all
```

---

### gh run — View details about workflow runs

**Subcommands:**
- `cancel` — Cancel a workflow run
- `delete` — Delete a workflow run
- `download` — Download artifacts generated by a workflow run
- `list` — List recent workflow runs
- `rerun` — Rerun a run
- `view` — View a summary of a workflow run
- `watch` — Watch a run until it completes, showing its progress

**Flags:**
- `-R, --repo [HOST/]OWNER/REPO` — Select another repository

---

### gh workflow — View details about GitHub Actions workflows

**Subcommands:**
- `disable` — Disable a workflow
- `enable` — Enable a workflow
- `list` — List workflows
- `run` — Run a workflow by creating a workflow_dispatch event
- `view` — View the summary of a workflow

**Flags:**
- `-R, --repo [HOST/]OWNER/REPO` — Select another repository

---

## ADDITIONAL COMMANDS

### gh agent-task — Work with agent tasks (preview)

**Aliases:** `gh agent-tasks`, `gh agent`, `gh agents`

**Note:** Working with agent tasks is in preview and subject to change without notice.

**Subcommands:**
- `create` — Create an agent task (preview)
- `list` — List agent tasks (preview)
- `view` — View an agent task session (preview)

**Arguments:**
- `<number>` — Pull request number (e.g., "123")
- `<id>` — Session ID (e.g., "12345abc-12345-12345-12345-12345abc")
- `<url>` — URL (e.g., "https://github.com/OWNER/REPO/pull/123/agent-sessions/12345abc-12345-12345-12345-12345abc")

**Examples:**
```bash
gh agent-task list                         # List your most recent agent tasks
gh agent-task create "Improve performance" # Create a new agent task
gh agent-task view 123                     # View details about a PR's tasks
gh agent-task view 12345abc...             # View details about a specific task
```

---

### gh alias — Create command shortcuts

**Note:** Aliases can be used to make shortcuts for gh commands or to compose multiple commands.

**Subcommands:**
- `delete` — Delete set aliases
- `import` — Import aliases from a YAML file
- `list` — List your aliases
- `set` — Create a shortcut for a gh command

---

### gh api — Make authenticated GitHub API requests

Makes an authenticated HTTP request to the GitHub API and prints the response.

**Endpoint Types:**
- GitHub API v3 endpoints (path)
- `graphql` — GitHub API v4

**Placeholder Values:**
- `{owner}` — Repository owner
- `{repo}` — Repository name
- `{branch}` — Branch name

**Flags:**
- `--cache duration` — Cache the response (e.g., "3600s", "60m", "1h")
- `-F, --field key=value` — Add a typed parameter (use "@<path>" or "@-" for file/stdin)
- `-H, --header key:value` — Add an HTTP request header
- `--hostname string` — GitHub hostname for request (default "github.com")
- `-i, --include` — Include HTTP response status line and headers
- `--input file` — File to use as body (use "-" for stdin)
- `-q, --jq string` — Query values using jq syntax
- `-X, --method string` — HTTP method (default "GET")
- `--paginate` — Fetch all pages of results
- `-p, --preview strings` — Opt into API previews
- `-f, --raw-field key=value` — Add a string parameter
- `--silent` — Do not print response body
- `--slurp` — Return array of all pages with `--paginate`
- `-t, --template string` — Format JSON using Go template
- `--verbose` — Include full HTTP request and response

**Field Syntax:**
- Literal values `true`, `false`, `null`, and integers get converted to JSON types
- Placeholder values `{owner}`, `{repo}`, `{branch}` get populated from repo
- Values starting with `@` are interpreted as filenames

**Nested Parameters:**
- `key[subkey]=value` — Nested parameters
- `key[]=value1`, `key[]=value2` — Arrays
- `key[]` — Empty array

**Examples:**
```bash
# List releases in current repo
gh api repos/{owner}/{repo}/releases

# Post an issue comment
gh api repos/{owner}/{repo}/issues/123/comments -f body='Hi from CLI'

# Post nested parameter from file
gh api gists -F 'files[myfile.txt][content]=@myfile.txt'

# Add parameters to GET request
gh api -X GET search/issues -f q='repo:cli/cli is:open remote'

# Use JSON file as request body
gh api repos/{owner}/{repo}/rulesets --input file.json

# Set custom HTTP header
gh api -H 'Accept: application/vnd.github.v3.raw+json' ...

# Opt into API previews
gh api --preview baptiste,nebula ...

# Print specific fields from response
gh api repos/{owner}/{repo}/issues --jq '.[].title'

# Use template for output
gh api repos/{owner}/{repo}/issues --template \
  '{{range .}}{{.title}} ({{.labels | pluck "name" | join ", " | color "yellow"}}){{"\n"}}{{end}}'

# GraphQL query
gh api graphql -F owner='{owner}' -F name='{repo}' -f query='
  query($name: String!, $owner: String!) {
    repository(owner: $owner, name: $name) {
      releases(last: 3) {
        nodes { tagName }
      }
    }
  }
'

# GraphQL with pagination
gh api graphql --paginate -f query='
  query($endCursor: String) {
    viewer {
      repositories(first: 100, after: $endCursor) {
        nodes { nameWithOwner }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
'
```

**Environment Variables:**
- `GH_TOKEN`, `GITHUB_TOKEN` — Authentication token for github.com API
- `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` — Token for GitHub Enterprise
- `GH_HOST` — GitHub host other than github.com

---

### gh attestation — Download and verify artifact attestations

**Aliases:** `gh at`

**Subcommands:**
- `download` — Download an artifact's attestations for offline use
- `trusted-root` — Output trusted_root.jsonl contents for offline verification
- `verify` — Verify an artifact's integrity using attestations

---

### gh completion — Generate shell completion scripts

**Supported Shells:** bash, zsh, fish, powershell

**Flags:**
- `-s, --shell string` — Shell type: {bash|zsh|fish|powershell}

**Setup Instructions:**

**bash:**
```bash
eval "$(gh completion -s bash)"
```

**zsh:**
```bash
gh completion -s zsh > /usr/local/share/zsh/site-functions/_gh
# Ensure in ~/.zshrc:
# autoload -U compinit
# compinit -i
```

**fish:**
```bash
gh completion -s fish > ~/.config/fish/completions/gh.fish
```

**PowerShell:**
```powershell
mkdir -Path (Split-Path -Parent $profile) -ErrorAction SilentlyContinue
notepad $profile
# Add: Invoke-Expression -Command $(gh completion -s powershell | Out-String)
```

---

### gh config — Manage configuration for gh

**Subcommands:**
- `clear-cache` — Clear the cli cache
- `get` — Print the value of a given configuration key
- `list` — Print a list of configuration keys and values
- `set` — Update configuration with a value for the given key

**Configuration Settings:**
- `git_protocol` — Protocol for git operations: `{https | ssh}` (default: `https`)
- `editor` — Text editor program for authoring text
- `prompt` — Interactive prompting: `{enabled | disabled}` (default: `enabled`)
- `prefer_editor_prompt` — Editor-based prompting: `{enabled | disabled}` (default: `disabled`)
- `pager` — Terminal pager program
- `http_unix_socket` — Path to Unix socket for HTTP connection
- `browser` — Web browser for opening URLs
- `color_labels` — Display labels with RGB hex colors: `{enabled | disabled}` (default: `disabled`)
- `accessible_colors` — 4-bit accessible colors: `{enabled | disabled}` (default: `disabled`)
- `accessible_prompter` — Accessible prompter: `{enabled | disabled}` (default: `disabled`)
- `spinner` — Animated spinner for progress: `{enabled | disabled}` (default: `enabled`)

---

### gh copilot — Run the GitHub Copilot CLI (preview)

**Note:** Copilot CLI execution through `gh` is in preview and subject to change.

**Behavior:**
- If installed, executes Copilot CLI from PATH
- If not installed, downloads to `/Users/dustin/.local/share/gh/copilot`
- Supported on Windows, Linux, and Darwin (amd64/x64 or arm64)

**Flags:**
- `--remove` — Remove the downloaded Copilot CLI

**Note:** Use `--` before Copilot flags to prevent `gh` from interpreting them.

**Examples:**
```bash
gh copilot                                   # Download and run Copilot CLI
gh copilot -p "Summarize this week's commits" --allow-tool 'shell(git)'
gh copilot --remove                          # Remove downloaded Copilot
gh copilot -- --help                         # Run Copilot help command
```

---

### gh extension — Manage gh extensions

**Aliases:** `gh extensions`, `gh ext`

**Subcommands:**
- `browse` — Enter a UI for browsing, adding, and removing extensions
- `create` — Create a new extension
- `exec` — Execute an installed extension
- `install` — Install a gh extension from a repository
- `list` — List installed extension commands
- `remove` — Remove an installed extension
- `search` — Search extensions to the GitHub CLI
- `upgrade` — Upgrade installed extensions

**Extension Requirements:**
- Repository name must start with `gh-`
- Must contain an executable of the same name
- Cannot override core gh commands

**Extension Behavior:**
- Checks for new versions once every 24 hours
- Use `gh extension exec <extname>` if name conflicts with core command

---

### gh gpg-key — Manage GPG keys

**Subcommands:**
- `add` — Add a GPG key to your GitHub account
- `delete` — Delete a GPG key from your GitHub account
- `list` — Lists GPG keys in your GitHub account

---

### gh label — Manage labels

**Subcommands:**
- `clone` — Clones labels from one repository to another
- `create` — Create a new label
- `delete` — Delete a label from a repository
- `edit` — Edit a label
- `list` — List labels in a repository

**Flags:**
- `-R, --repo [HOST/]OWNER/REPO` — Select another repository

---

### gh licenses — View third-party license information

View license information for third-party libraries used in this build of the GitHub CLI.

---

### gh preview — Execute previews for gh features

**Note:** Preview commands are for testing, demonstrative, and development purposes only. They should be considered unstable and can change at any time.

**Subcommands:**
- `prompter` — Execute a test program to preview the prompter

---

### gh ruleset — View info about repo rulesets

**Aliases:** `gh rs`

Repository rulesets are a way to define a set of rules that apply to a repository.

**Subcommands:**
- `check` — View rules that would apply to a given branch
- `list` — List rulesets for a repository or organization
- `view` — View information about a ruleset

**Flags:**
- `-R, --repo [HOST/]OWNER/REPO` — Select another repository

**Examples:**
```bash
gh ruleset list
gh ruleset view --repo OWNER/REPO --web
gh ruleset check branch-name
```

---

### gh search — Search across all of GitHub

**Subcommands:**
- `code` — Search within code
- `commits` — Search for commits
- `issues` — Search for issues
- `prs` — Search for pull requests
- `repos` — Search for repositories

**Search Syntax Notes:**
- Excluding results: Use `-label:bug` to exclude results matching a qualifier
- On Unix: Use `--` to prevent hyphen being interpreted as flag:
  ```bash
  gh search issues -- "my-search-query -label:bug"
  ```
- On PowerShell: Use `--%` and `--`:
  ```powershell
  gh --% search issues -- "my search query -label:bug"
  ```

---

### gh secret — Manage GitHub secrets

Secrets can be set at repository, organization, user, or environment level for GitHub Actions, Dependabot, or Codespaces.

**Subcommands:**
- `delete` — Delete secrets
- `list` — List secrets
- `set` — Create or update secrets

**Flags:**
- `-R, --repo [HOST/]OWNER/REPO` — Select another repository

---

### gh ssh-key — Manage SSH keys

**Subcommands:**
- `add` — Add an SSH key to your GitHub account
- `delete` — Delete an SSH key from your GitHub account
- `list` — Lists SSH keys in your GitHub account

---

### gh status — Print information about relevant items

The status command prints information about your work on GitHub across all repositories you're subscribed to:

- Assigned Issues
- Assigned Pull Requests
- Review Requests
- Mentions
- Repository Activity (new issues/pull requests, comments)

**Flags:**
- `-e, --exclude strings` — Comma separated list of repos to exclude (owner/name format)
- `-o, --org string` — Report status within an organization

**Examples:**
```bash
gh status -e cli/cli -e cli/go-gh     # Exclude multiple repositories
gh status -o cli                      # Limit results to single organization
```

---

### gh variable — Manage GitHub Actions variables

Variables can be set at repository, environment, or organization level for GitHub Actions or Dependabot.

**Subcommands:**
- `delete` — Delete variables
- `get` — Get variables
- `list` — List variables
- `set` — Create or update variables

**Flags:**
- `-R, --repo [HOST/]OWNER/REPO` — Select another repository

---

## COMMON FLAGS

- `--help` — Show help for command
- `--version` — Show gh version (main only)

---

## ENVIRONMENT VARIABLES

- `GH_TOKEN` — Authentication token for GitHub API
- `GITHUB_TOKEN` — Alternative authentication token
- `GH_ENTERPRISE_TOKEN` — Token for GitHub Enterprise API
- `GITHUB_ENTERPRISE_TOKEN` — Alternative enterprise token
- `GH_HOST` — GitHub host (default: github.com)
- `BROWSER` — Web browser to use for opening URLs

---

## LEARNING MORE

- Official Manual: https://cli.github.com/manual
- Comprehensive Reference: `gh help reference`
- Exit Codes: `gh help exit-codes`
- Accessibility: `gh help accessibility`
- Formatting: `gh help formatting`
- Environment: `gh help environment`

---

**Generated:** 2026-04-15

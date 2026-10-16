# Factory tools

Some agents need to do more than talk: build and test code, publish a repo, list a product. These tools are switched on
per agent in the **Groups** tab → Agents table (`sandbox`, `publish`) or with `POST /api/groups/agent {aid, tools}`.

## `sandbox`: build and test inside a project folder

| Tool | What it does |
|---|---|
| `project_files` | list files in `data/projects/<project>/` |
| `read_file` / `write_file` | read or write a text file in the project folder |
| `run_command` | run a shell command in the project folder |

- Projects live in `data/projects/<slug>/` (not committed; `data/` is git-ignored).
- Paths are resolved inside the project folder; `..`, absolute paths and symlinks that leave it are refused.
- Commands run in **bubblewrap** (`bwrap`): the project folder is mounted at `/work`, the rest of the system is read-only
  `/usr` only, there is **no network**, no home folder and an empty environment (no API keys). Timeout 5–300 s (default 60).
- Commands that need the network (`npm install`, `pip install`, `npx`, `git clone/fetch/pull/push`, `curl`, `wget`…) are not
  run directly: they become an **approval**, and run with network on only after the owner approves the task.
- `sudo`, package managers, `docker`/`podman`, `ssh` are refused. Docker is not offered: the sandbox has no Docker socket.
- Without `bwrap` installed (`apt install bubblewrap`), every command waits for approval.

## `publish`: GitHub and Gumroad (env-gated, always approval)

| Tool | Needs | On approval |
|---|---|---|
| `github_publish` | `GITHUB_TOKEN` (fine-grained: Administration + Contents read/write), optional `GITHUB_OWNER` (org or user, e.g. `aidendify`) | creates the repo (or reuses it) and pushes the project to `main`. The token is passed as a one-off header, never written to the remote URL or git config. Refuses projects containing `.env`, `.pem` or `id_rsa*` files. |
| `gumroad_create_draft` | `GUMROAD_ACCESS_TOKEN` (scope `edit_products`) | creates the product as an **unpublished draft** (`draft=true`). Descriptions with GitHub/GitLab/Bitbucket links or `git clone` are refused. Attach files and publish in Gumroad. |

Without the token a publish tool is simply not offered to the agent; the Publisher then writes the listing as a draft in its answer.

Code: `lib/factory.js`; approvals run through `decideApproval()` in `lib/orchestrator.js`.

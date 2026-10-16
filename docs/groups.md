# Groups, task boards and routines

Groups turn a set of agents into a team with a lead, a kanban board and a worker loop.

## Concepts

| Thing | What it is | Stored in |
|---|---|---|
| Group | name, lead agent, members, how many tasks run at once (1–2), and groups it orchestrates (`over`) | `as_groups:<email>` |
| Task | title, details, assignee, status, parent goal, `after` (runs after another task), `gate` (next step waits for approval) | `as_board:<email>` |
| Routine | a scheduled job; can be **paused** and resumed without losing its schedule | `as_rt:<email>` (`paused: true`) |

Board columns: `todo → running → review → done`, plus `blocked`.

- **Goals.** Send a goal to a group (Groups tab or `POST /api/groups/goal`). The group's lead plans it into 1–5 tasks, assigns members, and chains them with `after`. The goal itself becomes a parent card that moves to review once all its tasks are in review or done.
- **Worker loop.** Every 20 seconds `server.js` runs `runBoardWorker()`: per group it starts up to `limit` todo tasks whose `after` task is in review (or done, if that task is gated). Each task runs through the normal orchestrator (`runAgent`) and lands in **review** with its result.
- **Nothing goes out without approval.** If a task wants to send, post, publish or run a risky command, the tool creates an approval instead. Approving the task in review runs those approvals; rejecting declines them and moves the task to blocked.
- **First run.** Groups are created automatically from the agents' `group` field (set it in the Agents table at the bottom of the Groups tab).
- **Per-agent model.** An agent's `model` (e.g. `deepseek/deepseek-v4-flash`) overrides `OPENROUTER_MODEL` for that agent.

## API (signed-in customer)

| Method | Path | Body |
|---|---|---|
| GET | `/api/groups` | — returns groups, board, routines, agents, pending approvals |
| POST | `/api/groups` | `{id?, name, desc, lead, members:[ids], limit, over:[groupIds]}` |
| POST | `/api/groups/delete` | `{id}` |
| POST | `/api/groups/goal` | `{gid, goal}` (`gid` can be a group id or name) |
| POST | `/api/groups/agent` | `{aid, group?, model?, tools?:['sandbox','publish']}` |
| POST | `/api/board/task` | create `{gid, title, body, aid, status?}` or update `{id, title?, body?, aid?, status?}` |
| POST | `/api/board/delete` | `{id}` |
| POST | `/api/board/decide` | `{id, decision:'approve'|'reject', note?}` |
| POST | `/api/routines/pause` | `{id, paused:true|false}` |

Code: `lib/groups.js` (model, board, worker), routes in `lib/backend.js` (`groupRoutes`), UI in `board.html` (embedded in the **Groups** tab).

## Limits

- On Vercel there is no long-running worker; call `runBoardWorker()` from a cron route if you deploy there.
- Board state is one JSON list per customer (fine for hundreds of tasks, not for thousands).

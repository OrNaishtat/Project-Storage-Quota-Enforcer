# Project Storage Quota Enforcer

Two JFrog Workers that **enforce project storage quota** on JFrog Cloud: a scheduled worker that computes usage and sets a blocked flag, and a BEFORE_UPLOAD worker that blocks uploads when a project is over quota.

On JFrog Cloud, project storage limits (`storage_quota_bytes`) only send notifications; they do not block uploads. These workers add **actual blocking**: when a project exceeds its quota, uploads to any repo in that project are rejected.

## Repository layout

```
.
├── README.md           (this file)
├── DEEP-DIVE.md        (technical deep dive)
├── project-storage-quota-check-scheduled/   ← scheduled worker
│   ├── manifest.json
│   ├── worker.ts
│   └── jfrog-workers.d.ts
└── project-storage-protector/               ← BEFORE_UPLOAD worker
    ├── manifest.json
    ├── worker.ts
    ├── types.ts
    └── jfrog-workers.d.ts
```

Deploy each worker from its own directory. Only these files are required; no test binaries or secrets belong in the repo.

## Overview

| Worker | Type | Role |
|--------|------|------|
| **project-storage-quota-check-scheduled** | SCHEDULED_EVENT | Runs on a cron (e.g. every 30 min). For each project with `storage_quota_bytes` set, computes used storage and writes a **blocked** flag into a tracking repo. |
| **project-storage-protector** | BEFORE_UPLOAD | On every upload: resolves the repo’s project, reads the **blocked** flag, and returns UPLOAD_STOP if the project is over quota. |

Heavy work (storage computation) runs only on the schedule; the protector does two light API calls per upload.

## Prerequisites

- JFrog CLI configured (`jf config add`).
- JFrog Workers enabled on your platform.
- **JFrog Advanced Security (JAS)** license if you want the platform to enforce UPLOAD_STOP (otherwise the worker runs but uploads may not be blocked).
- A **local** Generic repository for block flags. Create one with key **quota-tracking-default**, or set the Worker Property **trackingRepo** to another key. The quota-check worker can auto-create it if it does not exist.
- Projects with **storage_quota_bytes** set where you want enforcement; repos assigned to those projects.

## Worker properties

Configure in the JFrog UI: **Workers → [worker name] → Settings → Properties**.

| Property | Worker | Default | Description |
|----------|--------|---------|-------------|
| `trackingRepo` | both | `quota-tracking-default` | Local repo that stores per-project `blocked` flags. |
| `excludedProjectKeys` | quota-check only | (none) | Comma-separated project keys to never block. The key `default` is always excluded in code. |
| `debug` | quota-check only | — | Set to `true` or `false` to control debug logging. |

Quota is read from each project’s **storage_quota_bytes** (JFrog Access API). A value of **0** means no limit; only positive values are enforced.

## Deployment

Deploy **both** workers from the repo root:

```bash
jf worker deploy ./project-storage-quota-check-scheduled
jf worker deploy ./project-storage-protector
```

With a specific server:

```bash
jf worker deploy ./project-storage-quota-check-scheduled --server-id YOUR_SERVER_ID
jf worker deploy ./project-storage-protector --server-id YOUR_SERVER_ID
```

## Attach the protector to all repositories

So that **any** project that reaches quota is covered (including future projects):

1. In the JFrog UI go to **Administration → Workers → Edit worker (project-storage-protector) → Select Filters**.
2. Under **Repositories**, check **Any Local**, **Any Federated**, and **Any Remote**. Save.

The worker then runs on every upload to any repo. It resolves the repo’s project and checks the blocked flag; when a new project hits quota, you do **not** need to add repos manually. Optionally you can limit to specific repos by selecting only those in the filters.

## Schedule (quota-check)

Set how often the quota is recomputed:

```bash
jf worker edit-schedule project-storage-quota-check-scheduled --cron "0 * * * *"
```

**Best practice — schedule interval:** Each run of the scheduled worker triggers Artifactory’s **Refresh Storage Summary** API (`POST /api/storageinfo/calculate`) so that quota decisions use up-to-date storage data instead of cached values. That refresh can be resource-intensive on large instances. **Do not run the scheduled worker more frequently than once per hour in production** - prefer an interval of one hour or longer to avoid unnecessary load on the platform. Use a shorter interval only for testing.


## Enable workers

1. Deploy both workers (see above).
2. Set **Select Filters** for the protector to Any Local / Any Federated / Any Remote (see above).
3. Set Worker Properties if needed (e.g. `trackingRepo`, `excludedProjectKeys`).
4. Set the schedule for the quota-check worker.
5. Enable both workers in the JFrog UI (**Workers → Enable**).

## Live testing

1. **Create the tracking repo** (if needed): In Artifactory, create a **local** Generic repository with key **quota-tracking-default**. The quota-check worker may also create it automatically.

2. **Use a project with a quota:** Pick a project that has **storage_quota_bytes** set (e.g. 1 GB). Ensure at least one repo is assigned to that project.

3. **Exceed the quota:** Upload artifacts until total storage for that project is at or over the quota (UI, REST API, or `jf rt u`).

4. **Wait for the next quota-check run:** The scheduled worker will set `blocked=true` in **quota-tracking-default** for that project key.

5. **Trigger the protector:** Upload again to any repo in that project. The protector should return UPLOAD_STOP and the upload should fail with a quota message.

6. **Check the flag (optional):**  
   `GET /artifactory/api/storage/quota-tracking-default/<projectKey>?properties`  
   should show `blocked: ["true"]` when the project is over quota.

7. **Unblock:** Delete or move artifacts so the project is under quota. After the next scheduled run, the quota-check sets `blocked=false` and uploads succeed again.

**CLI upload test (after exceeding quota):**

```bash
jf rt u some-file.txt my-repo/ --server-id YOUR_SERVER_ID
# If the project is blocked, the upload fails with a quota message.
```

## Default project excluded

Repositories **not** assigned to a project belong to JFrog’s global project (key **`default`**). That project is **always excluded** from blocking so that unassigned repos are not affected. Additional projects can be excluded via **excludedProjectKeys** on the quota-check worker.

## Remote cache

When artifacts are downloaded from a remote repo, JFrog may write to a **remote cache** repo. That write is an upload and triggers BEFORE_UPLOAD. If that cache repo is in a project that is over quota and blocked, cache writes are blocked too. There is no special handling for cache vs normal uploads.

## Data transfer

This repo addresses **storage** quota only. Data transfer (egress) is separate; a different worker could be added later to enforce data transfer limits per project.

## See also

- [**DEEP-DIVE.md**](https://github.com/OrNaishtat/Project-Storage-Quota-Enforcer/blob/main/DEEP-DIVE.md) — Architecture, APIs, and implementation details.
- [JFrog Workers](https://jfrog.com/help/r/jfrog-platform-administration-documentation/workers)
- [Get Project (storage_quota_bytes)](https://jfrog.com/help/r/jfrog-rest-apis/get-project)

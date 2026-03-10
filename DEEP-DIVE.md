# Project Storage Quota Enforcer — Technical Deep Dive

This document describes the architecture, APIs, and implementation details of the two JFrog Workers that enforce project storage quota on JFrog Cloud.

## Overview

On JFrog Cloud, project-level **storage_quota_bytes** triggers notifications only; it does not block uploads. These workers add enforcement:

1. **project-storage-quota-check-scheduled** (SCHEDULED_EVENT) — Runs on a cron. For each project with a positive quota, it computes total storage used by repos in that project and writes a **blocked** flag (true/false) into a tracking repository.
2. **project-storage-protector** (BEFORE_UPLOAD) — Runs on every upload. It resolves the upload’s repo to a project, reads that project’s **blocked** flag, and returns UPLOAD_STOP if the project is over quota.


## Architecture

```
                    ┌─────────────────────────────────────┐
                    │  JFrog Platform (Artifactory +      │
                    │  Access, Workers runtime)            │
                    └─────────────────────────────────────┘
                                      │
     ┌────────────────────────────────┼────────────────────────────────┐
     │                                │                                │
     ▼                                ▼                                ▼
┌─────────────┐              ┌──────────────────┐              ┌─────────────────┐
│ Cron        │              │ Artifactory       │              │ BEFORE_UPLOAD   │
│ Scheduler   │              │ Storage +        │              │ (every upload)  │
│             │              │ Access API       │              │                 │
└──────┬──────┘              └────────┬─────────┘              └────────┬─────────┘
       │                               │                                │
       │ trigger                       │ read/write                    │ read
       ▼                               ▼                                ▼
┌─────────────────────────┐   ┌─────────────────────────┐   ┌─────────────────────────┐
│ project-storage-quota-   │   │ quota-tracking-default  │   │ project-storage-         │
│ check-scheduled          │   │ (local repo)            │   │ protector               │
│                          │   │                          │   │                         │
│ • List projects (Access) │   │ Path: <projectKey>       │   │ • Get repo → project     │
│ • Get quota per project  │   │ Property: blocked=true  │   │ • Get blocked flag       │
│ • Get storage used       │   │         /false          │   │ • UPLOAD_PROCEED or     │
│ • Set blocked flag       │   │                          │   │   UPLOAD_STOP           │
└─────────────────────────┘   └─────────────────────────┘   └─────────────────────────┘
```

- **Tracking repo:** One local Generic repo (default key: `quota-tracking-default`) holds one path per project key. Each path has a property `blocked` set to `"true"` or `"false"` by the scheduled worker. The protector only reads this property.
- **Default project:** The project key `default` (repos not assigned to any project) is always excluded: the quota-check never sets it blocked, and the protector allows uploads when the repo’s project is `default`.

## Configuration — Worker Properties

All configuration is in the JFrog Platform; there are no local config files.

| Property | Worker | Default | Description |
|----------|--------|---------|-------------|
| `trackingRepo` | both | `quota-tracking-default` | Local repo key where per-project `blocked` flags are stored. |
| `excludedProjectKeys` | quota-check only | (none) | Comma-separated project keys to never mark as blocked. `default` is always excluded in code. |
| `debug` | quota-check only | — | `true` / `false` to enable or disable debug logging. |

Quota values come only from the JFrog Access API (project’s **storage_quota_bytes**). A value of 0 means unlimited; only positive values are enforced.

## APIs used

### Quota-check worker (scheduled)

| Purpose | API | Notes |
|---------|-----|--------|
| List projects | `GET /access/api/v1/projects` | Iterate over all projects. |
| Project details (quota) | `GET /access/api/v1/projects/{projectKey}` | Read `storage_quota_bytes`. |
| Storage per repo | `GET /artifactory/api/storageinfo` | Response includes `repositoriesSummaryList` with `projectKey` / `project_key` and `usedSpaceInBytes` / `used_space_in_bytes`. |
| Ensure tracking repo exists | `GET /artifactory/api/repositories/{trackingRepo}` | If 404/400, worker may create it. |
| Create tracking repo | `PUT /artifactory/api/repositories/{trackingRepo}` | Body: `{ key, rclass: 'local', packageType: 'generic' }`. |
| Write blocked flag | `PUT /artifactory/{trackingRepo}/{projectKey}` (empty body), then `PUT .../api/storage/...?properties=blocked=true|false` | First ensures path exists; second sets property. |

Storage used per project is computed by summing `usedSpaceInBytes` (or `used_space_in_bytes`) over all entries in `storageinfo.repositoriesSummaryList` whose `projectKey` (or `project_key`) equals the project.

### Protector worker (BEFORE_UPLOAD)

| Purpose | API | Notes |
|---------|-----|--------|
| Repo → project | `GET /artifactory/api/repositories/{repoKey}` | Read `projectKey`. |
| Is project blocked? | `GET /artifactory/api/storage/{trackingRepo}/{projectKey}?properties` | Read `properties.blocked`; may be string or array (e.g. `["true"]`). |

The worker receives the upload request (including repo path). It derives the repo key from the request, then performs the two calls above. No storage computation is done in the protector.

## Schedule (quota-check)

Defined in **project-storage-quota-check-scheduled/manifest.json**:

```json
"filterCriteria": {
  "schedule": {
    "cron": "* * * * *",
    "timezone": "UTC"
  }
}
```

Change the schedule after deployment with:

```bash
jf worker edit-schedule project-storage-quota-check-scheduled --cron "0 */30 * * *"
jf worker edit-schedule project-storage-quota-check-scheduled --cron "0 */30 * * *" --timezone "America/New_York"
```

Cron format: minute, hour, day-of-month, month, day-of-week. Redeploy the worker after changing the schedule so the platform picks it up.

## Protector filters (BEFORE_UPLOAD)

The protector must be **attached** to repositories so it runs on uploads. In the UI:

**Workers → project-storage-protector → Edit → Select Filters → Repositories**

- For “all repos”: check **Any Local**, **Any Federated**, **Any Remote**. Then every upload triggers the worker; it resolves the repo’s project and checks the blocked flag. New projects are covered automatically.
- For a subset: select only the desired repos.

The manifest may contain `repoKeys: ["*"]`; the actual attachment is controlled by the UI filters above. If the worker is not attached to any repo, it will not run on uploads.

## Blocking behavior

- When the protector decides the project is over quota, it returns **UPLOAD_STOP** with a message. The JFrog platform aborts the upload and returns an error to the client; the artifact is not stored.
- **JFrog Advanced Security (JAS)** is required for the platform to enforce UPLOAD_STOP. Without JAS, the worker may run but the platform might not block the upload.
- On any uncaught error, the protector returns UPLOAD_STOP (fail-closed) with an error message so that failures in the check result in blocking rather than allowing.

## Deployment steps

1. **Deploy both workers** (from repo root):
   ```bash
   jf worker deploy ./project-storage-quota-check-scheduled
   jf worker deploy ./project-storage-protector
   ```

2. **Create or confirm tracking repo:** In Artifactory, create a local Generic repo with key `quota-tracking-default`, or set the Worker Property `trackingRepo` to an existing local repo. The quota-check worker may create it if it has permissions.

3. **Set protector filters:** In the UI, attach the protector to **Any Local**, **Any Federated**, **Any Remote** (or to the desired repos).

4. **Set schedule:** e.g. `jf worker edit-schedule project-storage-quota-check-scheduled --cron "0 */30 * * *"`, then redeploy the quota-check worker.

5. **Enable both workers** in the JFrog UI.

## Testing via UI

You can trigger the quota-check worker manually from **Workers → project-storage-quota-check-scheduled → Run**. The result includes a message and optional details (per-project used bytes, quota, blocked flag).

For the protector, use **Workers → project-storage-protector → Test** with a payload that includes the repo key and path (e.g. `metadata.repoPath.key`, `metadata.repoPath.path`). The response will show UPLOAD_PROCEED or UPLOAD_STOP and the message.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|--------|-----|
| Uploads not blocked although project is over quota | Protector not attached to repos | In UI, set Select Filters to Any Local / Any Federated / Any Remote (or add the specific repos). |
| Uploads not blocked | No JAS license | Confirm JAS is enabled so the platform enforces UPLOAD_STOP. |
| Blocked flag not updating | Quota-check not running or wrong schedule | Check Workers execution history; set schedule and redeploy. |
| Wrong project or no project | Repo not assigned to project | Assign the repo to the correct project in Artifactory. |
| Tracking repo errors | Repo missing or wrong key | Create local repo with key from `trackingRepo` property, or fix the property. |

## File layout (what to commit)

Only the following are needed for the workers; do not commit test binaries or secrets:

- **Root:** `README.md`, `DEEP-DIVE.md`, `.gitignore`
- **project-storage-quota-check-scheduled:** `manifest.json`, `worker.ts`, `jfrog-workers.d.ts`
- **project-storage-protector:** `manifest.json`, `worker.ts`, `types.ts`, `jfrog-workers.d.ts`

Exclude from version control: `*.bin`, test data, `.env`, credentials, and any customer- or environment-specific config.

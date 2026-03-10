/// <reference path="./jfrog-workers.d.ts" />
import { PlatformContext } from 'jfrog-workers';

/**
 * Project Storage Quota Check (scheduled)
 *
 * Runs on a schedule (e.g. every 30 minutes). For each JFrog Project that has
 * storage_quota_bytes set, computes current storage usage and writes a
 * "blocked" flag into the tracking repo. The BEFORE_UPLOAD worker (project-storage-protector)
 * only reads that flag, so the heavy work is not done on every upload.
 *
 * Worker Properties:
 *   trackingRepo  — local repo for blocked flags (default: quota-tracking-default)
 *   excludedProjectKeys — comma-separated project keys to never block (in addition to "default"; "default" is always excluded and cannot be overridden)
 */

const DEFAULT_TRACKING_REPO = 'quota-tracking-default';

/**
 * JFrog's global project key. Hardcoded — cannot be changed or removed by Worker Properties.
 * The excludedProjectKeys property only adds more keys; this one is always excluded.
 */
const GLOBAL_PROJECT_KEY = 'default';

function isDebug(context: PlatformContext): boolean {
    try {
        const v = (context.properties.get('debug') ?? '').toString().toLowerCase();
        return v !== 'false' && (v === 'true' || v === ''); // default on for debugging
    } catch {
        return true;
    }
}

export default async (context: PlatformContext, _data: unknown): Promise<{ message: string; updated?: number; details?: Array<{ projectKey: string; usedBytes: number; quotaBytes: number; blocked: boolean }> }> => {
    const trackingRepo = getProp(context, 'trackingRepo') || DEFAULT_TRACKING_REPO;
    const debug = isDebug(context);
    if (debug) console.log(`[storage-quota-check] DEBUG trackingRepo=${trackingRepo}`);

    await ensureTrackingRepoExists(context, trackingRepo);

    const excludedStr = getProp(context, 'excludedProjectKeys');
    const fromProperty = excludedStr.split(',').map((s) => s.trim()).filter(Boolean);
    const excluded = new Set([GLOBAL_PROJECT_KEY, ...fromProperty]);

    let projects: Array<{ project_key?: string; projectKey?: string }>;
    try {
        const res = await context.clients.platformHttp.get('/access/api/v1/projects');
        const raw = res.data;
        projects = Array.isArray(raw) ? raw : raw?.projects ?? [];
    } catch (error: any) {
        console.error(`[storage-quota-check] Failed to list projects: ${error.message}`);
        return { message: `Failed to list projects: ${error.message}` };
    }

    if (debug) console.log(`[storage-quota-check] DEBUG projects count=${projects.length}, keys=${projects.map((p) => p.project_key ?? p.projectKey).filter(Boolean).join(',')}`);

    let updated = 0;
    const details: Array<{ projectKey: string; usedBytes: number; quotaBytes: number; blocked: boolean }> = [];
    for (const p of projects) {
        const projectKey = p.project_key ?? p.projectKey;
        if (!projectKey || excluded.has(projectKey)) continue;

        const quotaBytes = await getProjectStorageQuota(context, projectKey);
        if (debug) console.log(`[storage-quota-check] DEBUG project="${projectKey}" quotaBytes=${quotaBytes}`);

        if (quotaBytes <= 0) {
            await setProjectBlocked(context, trackingRepo, projectKey, false, debug);
            details.push({ projectKey, usedBytes: 0, quotaBytes: 0, blocked: false });
            updated++;
            continue;
        }

        const usedBytes = await getProjectStorageUsed(context, projectKey, debug);
        if (usedBytes < 0) continue;

        const blocked = usedBytes >= quotaBytes;
        if (debug) console.log(`[storage-quota-check] DEBUG project="${projectKey}" usedBytes=${usedBytes} quotaBytes=${quotaBytes} => blocked=${blocked}`);

        await setProjectBlocked(context, trackingRepo, projectKey, blocked, debug);
        details.push({ projectKey, usedBytes, quotaBytes, blocked });
        if (blocked) {
            console.log(`[storage-quota-check] Blocked project "${projectKey}" (used ${usedBytes} >= quota ${quotaBytes}).`);
        }
        updated++;
    }

    return { message: `Checked ${projects.length} project(s), updated ${updated} block flags.`, details };
};

function getProp(context: PlatformContext, key: string): string {
    try {
        return context.properties.get(key) || '';
    } catch {
        return '';
    }
}

/**
 * If the tracking repo does not exist, create it (generic local).
 * repoKey is the Worker Property "trackingRepo" or default "quota-tracking-default".
 */
async function ensureTrackingRepoExists(context: PlatformContext, repoKey: string): Promise<void> {
    try {
        await context.clients.platformHttp.get(`/artifactory/api/repositories/${repoKey}`);
        return; // repo exists
    } catch (error: any) {
        const status = error?.status ?? error?.response?.status;
        if (status !== 404 && status !== 400) {
            console.error(`[storage-quota-check] Could not check tracking repo "${repoKey}": ${error.message}`);
            return;
        }
        // 404 or 400 = repo does not exist → create it
    }
    // key must match the chosen repo name (property or default). Use packageType (camelCase) so Artifactory sets generic.
    const repoConfig = {
        key: repoKey,
        rclass: 'local',
        packageType: 'generic',
    };
    try {
        await context.clients.platformHttp.put(`/artifactory/api/repositories/${repoKey}`, repoConfig);
        console.log(`[storage-quota-check] Created tracking repo "${repoKey}".`);
    } catch (error: any) {
        console.error(`[storage-quota-check] Failed to create tracking repo "${repoKey}": ${error.message}`);
    }
}

/** Returns quota in bytes. 0 means no limit (unlimited); only positive values are enforced. */
async function getProjectStorageQuota(context: PlatformContext, projectKey: string): Promise<number> {
    try {
        const res = await context.clients.platformHttp.get(`/access/api/v1/projects/${projectKey}`);
        const bytes = res.data?.storage_quota_bytes;
        return typeof bytes === 'number' && bytes > 0 ? bytes : 0;
    } catch {
        return 0;
    }
}

async function getProjectStorageUsed(context: PlatformContext, projectKey: string, debug?: boolean): Promise<number> {
    try {
        const storageRes = await context.clients.platformHttp.get('/artifactory/api/storageinfo');
        const storageData = storageRes.data;
        const summaries: Array<{ repoKey?: string; key?: string; projectKey?: string; project_key?: string; usedSpaceInBytes?: number }> =
            storageData?.repositoriesSummaryList ?? storageData?.repositories_summary_list ?? [];
        if (debug) {
            console.log(`[storage-quota-check] DEBUG storage summaries.length=${summaries.length}`);
        }
        let total = 0;
        for (const s of summaries) {
            const repoProjectKey = (s as any).projectKey ?? (s as any).project_key;
            if (repoProjectKey !== projectKey) continue;
            const used = (s as any).usedSpaceInBytes ?? (s as any).used_space_in_bytes;
            if (typeof used === 'number') total += used;
        }
        if (debug) console.log(`[storage-quota-check] DEBUG getProjectStorageUsed("${projectKey}") => total=${total}`);
        return total;
    } catch (error: any) {
        console.error(`[storage-quota-check] Failed to get storage for "${projectKey}": ${error.message}`);
        return -1;
    }
}

async function setProjectBlocked(
    context: PlatformContext,
    trackingRepo: string,
    projectKey: string,
    blocked: boolean,
    debug?: boolean,
): Promise<void> {
    const path = encodeURIComponent(projectKey);
    try {
        await context.clients.platformHttp.put(
            `/artifactory/${trackingRepo}/${path}`,
            '',
        );
    } catch {
        // path may already exist
    }
    const propValue = blocked ? 'true' : 'false';
    const propsUrl = `/artifactory/api/storage/${trackingRepo}/${path}?properties=blocked=${propValue}`;
    try {
        await context.clients.platformHttp.put(propsUrl);
        if (debug) console.log(`[storage-quota-check] DEBUG setProjectBlocked("${projectKey}", ${blocked}) PUT success`);
    } catch (error: any) {
        const status = error?.status ?? error?.response?.status;
        const body = error?.response?.data ?? error?.message;
        console.error(`[storage-quota-check] Failed to set blocked for "${projectKey}" (${blocked}): status=${status} ${JSON.stringify(body)}`);
    }
}

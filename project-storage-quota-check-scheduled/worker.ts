/// <reference path="./jfrog-workers.d.ts" />
import { PlatformContext } from 'jfrog-workers';

/**
 * Project Storage Quota Check (scheduled)
 *
 * Runs on a schedule (e.g. every 30 minutes). For each JFrog Project that has
 * storage_quota_bytes set, we re-check current storage (quota + used) and write
 * only a "blocked" flag (true/false) into the tracking repo. We do NOT store
 * used bytes anywhere; every run re-queries the APIs and then sets blocked
 * from that fresh check. The BEFORE_UPLOAD worker only reads the blocked flag.
 *
 * Flow per project: GET quota → GET storageinfo (used) → blocked = (used >= quota) → PUT/PATCH blocked.
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

    await refreshStorageSummary(context, debug);

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

        const result = await setProjectBlockedFromCurrentStorage(context, trackingRepo, projectKey, debug);
        if (result === null) continue;
        details.push({ projectKey, usedBytes: result.usedBytes, quotaBytes: result.quotaBytes, blocked: result.blocked });
        if (result.blocked) {
            console.log(`[storage-quota-check] Blocked project "${projectKey}" (used ${result.usedBytes} >= quota ${result.quotaBytes}).`);
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

/**
 * Trigger a full refresh of the storage summary so GET storageinfo returns current data.
 * By default Artifactory caches the summary (e.g. hourly); this ensures we use fresh numbers.
 * POST /artifactory/api/storageinfo/calculate (Admin only). If it fails (e.g. 403), we continue and use cached data.
 */
async function refreshStorageSummary(context: PlatformContext, debug?: boolean): Promise<void> {
    try {
        await context.clients.platformHttp.post('/artifactory/api/storageinfo/calculate', undefined);
        if (debug) console.log('[storage-quota-check] DEBUG refreshStorageSummary: POST storageinfo/calculate succeeded');
    } catch (error: any) {
        const status = error?.status ?? error?.response?.status;
        console.warn(`[storage-quota-check] Could not refresh storage summary (status=${status}); using cached data. ${error?.message ?? error}`);
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

/** Fetches current used storage for a project from Artifactory. No caching — we do not persist this; we only persist the derived "blocked" flag. */
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

/**
 * Re-checks storage every time: GET quota (Access API), GET used (storageinfo), then
 * set blocked = (used >= quota). We never reuse a stored used value; we always
 * re-run this check and write only the boolean "blocked". Returns the values we
 * used so the run result can show them, or null if storage could not be read.
 */
async function setProjectBlockedFromCurrentStorage(
    context: PlatformContext,
    trackingRepo: string,
    projectKey: string,
    debug?: boolean,
): Promise<{ usedBytes: number; quotaBytes: number; blocked: boolean } | null> {
    const quotaBytes = await getProjectStorageQuota(context, projectKey);
    if (debug) console.log(`[storage-quota-check] DEBUG project="${projectKey}" quotaBytes=${quotaBytes}`);

    if (quotaBytes <= 0) {
        await writeBlockedFlag(context, trackingRepo, projectKey, false, debug);
        return { usedBytes: 0, quotaBytes: 0, blocked: false };
    }

    const usedBytes = await getProjectStorageUsed(context, projectKey, debug);
    if (usedBytes < 0) return null;

    const blocked = usedBytes >= quotaBytes;
    if (debug) console.log(`[storage-quota-check] DEBUG project="${projectKey}" usedBytes=${usedBytes} quotaBytes=${quotaBytes} => blocked=${blocked}`);

    await writeBlockedFlag(context, trackingRepo, projectKey, blocked, debug);
    return { usedBytes, quotaBytes, blocked };
}

/** Writes the blocked property (PUT first time, PATCH when props already exist). */
async function writeBlockedFlag(
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
    const hasExistingProps = await itemHasProperties(context, trackingRepo, path);
    try {
        if (hasExistingProps) {
            const metadataUrl = `/artifactory/api/metadata/${trackingRepo}/${path}?recursiveProperties=0&atomicProperties=0`;
            await context.clients.platformHttp.patch(metadataUrl, { props: { blocked: propValue } });
            if (debug) console.log(`[storage-quota-check] DEBUG writeBlockedFlag("${projectKey}", ${blocked}) PATCH success`);
        } else {
            const storageUrl = `/artifactory/api/storage/${trackingRepo}/${path}?properties=blocked=${propValue}`;
            await context.clients.platformHttp.put(storageUrl);
            if (debug) console.log(`[storage-quota-check] DEBUG writeBlockedFlag("${projectKey}", ${blocked}) PUT success`);
        }
    } catch (error: any) {
        const status = error?.status ?? error?.response?.status;
        const errBody = error?.response?.data ?? error?.message;
        console.error(`[storage-quota-check] Failed to set blocked for "${projectKey}" (${blocked}): status=${status} ${JSON.stringify(errBody)}`);
    }
}

/** Returns true if the item already has at least one property (so we use PATCH to update; otherwise PUT to set). */
async function itemHasProperties(
    context: PlatformContext,
    trackingRepo: string,
    encodedPath: string,
): Promise<boolean> {
    try {
        const res = await context.clients.platformHttp.get(
            `/artifactory/api/storage/${trackingRepo}/${encodedPath}?properties`,
        );
        const props = res.data?.properties;
        return typeof props === 'object' && props !== null && Object.keys(props).length > 0;
    } catch {
        return false;
    }
}

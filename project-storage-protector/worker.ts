/// <reference path="./jfrog-workers.d.ts" />
import { PlatformContext } from 'jfrog-workers';
import { BeforeUploadRequest, BeforeUploadResponse, UploadStatus } from './types';

/**
 * Project Storage Protector (BEFORE_UPLOAD)
 *
 * Lightweight check on every upload: resolves the repo's project, skips the
 * default/global project, and reads the "blocked" flag set by the scheduled
 * worker (project-storage-quota-check). No storage computation here — that
 * runs only on the schedule (e.g. every 30 minutes) to avoid heavy work on
 * every upload.
 *
 * How uploads are actually stopped: this worker returns UPLOAD_STOP. The
 * JFrog platform then aborts the upload request and returns an error to the
 * client; the artifact is never written.
 *
 * Applies to all repositories: leave filterCriteria.artifactFilterCriteria.repoKeys
 * empty so the worker runs for every upload. There is no option to limit by
 * repository.
 */

const DEFAULT_TRACKING_REPO = 'quota-tracking-default';

/**
 * JFrog's global project key for repos not assigned to a project.
 * Hardcoded — cannot be changed or overridden by Worker Properties.
 */
const GLOBAL_PROJECT_KEY = 'default';

export default async (
    context: PlatformContext,
    data: BeforeUploadRequest,
): Promise<Partial<BeforeUploadResponse>> => {
    try {
        const rawKey = data.metadata?.repoPath?.key;
        // key is repo key; if platform sends "repoKey/path", take the repo key only
        const repoKey = typeof rawKey === 'string' && rawKey.includes('/') ? rawKey.split('/')[0] : rawKey;

        if (!repoKey) {
            console.log('[storage-protector] Allowing: no repo key on request');
            return allow('No repo key on request');
        }

        const projectKey = await getProjectKey(context, repoKey);
        if (!projectKey) {
            console.log(`[storage-protector] Allowing: repo "${repoKey}" not assigned to a project`);
            return allow(`Repo "${repoKey}" is not assigned to a project — skipping`);
        }

        if (projectKey === GLOBAL_PROJECT_KEY) {
            return allow('Global project (default) — excluded from quota enforcement');
        }

        const trackingRepo = getProp(context, 'trackingRepo') || DEFAULT_TRACKING_REPO;
        const blocked = await isProjectBlocked(context, trackingRepo, projectKey);
        if (blocked) {
            console.log(`[storage-protector] Blocking upload to repo "${repoKey}" (project "${projectKey}" over quota)`);
            return block(
                `Project "${projectKey}" has reached its storage quota and is suspended. ` +
                    `Contact your Artifactory administrator.`,
            );
        }

        return allow('OK');
    } catch (error: any) {
        // Align with doc: uncaught errors → stop and log (platform may overwrite message)
        const status = error?.status ?? error?.response?.status;
        console.error(`[storage-protector] Request failed: status=${status} ${error?.message ?? error}`);
        return block(
            `Storage quota check failed: ${error?.message ?? 'Unknown error'}. Contact your Artifactory administrator.`,
        );
    }
};

/**
 * Resolves the project key for a repo. Remote cache repos (e.g. my-remote-cache) often
 * return 400 from GET /repositories/{key}; in that case we use the parent remote repo
 * (e.g. my-remote) to get the project, since cache inherits from the remote.
 */
async function getProjectKey(context: PlatformContext, repoKey: string): Promise<string | null> {
    const project = await getProjectKeyFromRepo(context, repoKey);
    if (project) return project;
    // Fallback: if repo key ends with "-cache", try the parent remote repo (Artifactory convention)
    if (repoKey.endsWith('-cache')) {
        const parentKey = repoKey.slice(0, -6); // remove "-cache"
        return getProjectKeyFromRepo(context, parentKey);
    }
    return null;
}

async function getProjectKeyFromRepo(
    context: PlatformContext,
    repoKey: string,
): Promise<string | null> {
    try {
        const res = await context.clients.platformHttp.get(`/artifactory/api/repositories/${repoKey}`);
        const data = res.data as { projectKey?: string; project_key?: string } | undefined;
        return data?.projectKey ?? data?.project_key ?? null;
    } catch (error: any) {
        const status = error?.status ?? error?.response?.status;
        if (status === 404 || status === 400) return null;
        console.error(`[storage-protector] Failed to get project for repo "${repoKey}": ${error.message}`);
        return null;
    }
}

async function isProjectBlocked(context: PlatformContext, trackingRepo: string, projectKey: string): Promise<boolean> {
    try {
        const path = encodeURIComponent(projectKey);
        const res = await context.clients.platformHttp.get(
            `/artifactory/api/storage/${trackingRepo}/${path}?properties`,
        );
        const blockedVal = res.data?.properties?.blocked;
        // Artifactory can return array ["true"] or single value
        const isBlocked =
            (Array.isArray(blockedVal) && blockedVal[0] === 'true') ||
            blockedVal === 'true';
        return !!isBlocked;
    } catch (error: any) {
        const status = error?.status ?? error?.response?.status;
        if (status === 404) return false;
        console.error(`[storage-protector] Failed to read block status for project "${projectKey}" (status=${status}): ${error.message}`);
        return false;
    }
}

function getProp(context: PlatformContext, key: string): string {
    try {
        return context.properties.get(key) || '';
    } catch {
        return '';
    }
}

function allow(message: string): Partial<BeforeUploadResponse> {
    return { status: UploadStatus.UPLOAD_PROCEED, message };
}

function block(message: string): Partial<BeforeUploadResponse> {
    return { status: UploadStatus.UPLOAD_STOP, message };
}

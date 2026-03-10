export interface BeforeUploadRequest {
    metadata: UploadMetadata | undefined;
    headers: { [key: string]: Header };
    userContext: UserContext | undefined;
    artifactProperties: { [key: string]: ArtifactProperties };
}

export interface BeforeUploadResponse {
    status: UploadStatus;
    message: string;
    modifiedRepoPath: RepoPath | undefined;
}

export interface ArtifactProperties {
    value: string[];
}

export interface UploadMetadata {
    repoPath: RepoPath | undefined;
    contentLength: number;
    lastModified: number;
    trustServerChecksums: boolean;
    servletContextUrl: string;
    skipJarIndexing: boolean;
    disableRedirect: boolean;
    repoType: RepoType;
}

export interface RepoPath {
    key: string;
    path: string;
    id: string;
    isRoot: boolean;
    isFolder: boolean;
}

export interface Header {
    value: string[];
}

export interface UserContext {
    id: string;
    isToken: boolean;
    realm: string;
}

export enum RepoType {
    REPO_TYPE_UNSPECIFIED = 0,
    REPO_TYPE_LOCAL = 1,
    REPO_TYPE_REMOTE = 2,
    REPO_TYPE_FEDERATED = 3,
    UNRECOGNIZED = -1,
}

export enum UploadStatus {
    UPLOAD_UNSPECIFIED = 0,
    UPLOAD_PROCEED = 1,
    UPLOAD_STOP = 2,
    UPLOAD_WARN = 3,
}

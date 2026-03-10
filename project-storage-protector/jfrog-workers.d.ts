declare module 'jfrog-workers' {
    export interface PlatformContext {
        readonly clients: {
            platformHttp: {
                get(url: string): Promise<{ data?: any; status?: number }>;
                put(url: string, body?: any): Promise<{ data?: any; status?: number }>;
            };
        };
        readonly properties: {
            get(key: string): string;
        };
    }
}

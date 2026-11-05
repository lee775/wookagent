export function sourceFiles(dir: string): string[];
export function invokedMethods(source: string, filename?: string): string[];
export function rendererInvocations(root: string): { path: string; method: string }[];

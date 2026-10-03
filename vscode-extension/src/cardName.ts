import * as os from 'os';
import * as path from 'path';

// Card filename for a project. Mirror of cardFileName() in src/sidecar.js,
// which is the source of truth: keep the two in step. The extension is a
// separate TypeScript package, so it cannot import the server module.
export function cardFileName(projectName: string): string {
  const slug = String(projectName ?? '')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/^[.\s-]+/, '')
    .slice(0, 100)
    .trim();
  return `${slug || 'project'}.md`;
}

export function cardPath(projectName: string): string {
  return path.join(os.homedir(), '.whatnext', 'agents', cardFileName(projectName));
}

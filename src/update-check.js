import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

function parseSemver(version) {
  const match = String(version).trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isUpdateAvailable(localVersion, latestTag) {
  const local = parseSemver(localVersion);
  const latest = parseSemver(latestTag);
  if (!local || !latest) return false;

  for (let i = 0; i < 3; i += 1) {
    if (latest[i] > local[i]) return true;
    if (latest[i] < local[i]) return false;
  }
  return false;
}

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The update command for how this copy was installed: a git checkout or the npm package. */
export function updateCommand(root = PACKAGE_ROOT) {
  return existsSync(join(root, '.git'))
    ? `cd ${root.replace(/\/$/, '')} && git pull && npm install`
    : 'npm install -g whatnext-ai@latest';
}

export function buildUpdateNotice(localVersion, latestTag, root = PACKAGE_ROOT) {
  if (!latestTag || !isUpdateAvailable(localVersion, latestTag)) return null;
  return (
    `[what-next] Update available: ${latestTag} (you have v${localVersion}). ` +
    `Run: ${updateCommand(root)}\n`
  );
}

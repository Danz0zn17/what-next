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

export function buildUpdateNotice(localVersion, latestTag) {
  if (!latestTag || !isUpdateAvailable(localVersion, latestTag)) return null;
  return (
    `[what-next] Update available: ${latestTag} (you have v${localVersion}). ` +
    'Run: cd ~/what-next && git pull && npm install\n'
  );
}

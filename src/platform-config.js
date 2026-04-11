import path from 'path';

const SUPPORTED_CLIENTS = new Set(['claude', 'vscode', 'copilot', 'cursor', 'windsurf']);

export function isSupportedClient(client) {
  return SUPPORTED_CLIENTS.has(client);
}

export function isVscodeLikeClient(client) {
  return client === 'vscode' || client === 'copilot';
}

function joinForPlatform(platform, ...parts) {
  if (platform === 'win32') {
    return path.win32.join(...parts);
  }
  return path.posix.join(...parts);
}

export function resolveConfigPath(client, platform, homeDir, appDataEnv, xdgConfigHomeEnv) {
  if (!isSupportedClient(client)) return null;

  const appData = appDataEnv ?? joinForPlatform('win32', homeDir, 'AppData', 'Roaming');
  // Respect XDG_CONFIG_HOME on Linux (and anywhere it's set)
  const xdgConfig = xdgConfigHomeEnv ?? joinForPlatform('linux', homeDir, '.config');

  const configPaths = {
    claude: {
      darwin: joinForPlatform('darwin', homeDir, 'Library/Application Support/Claude/claude_desktop_config.json'),
      linux: joinForPlatform('linux', xdgConfig, 'Claude/claude_desktop_config.json'),
      win32: joinForPlatform('win32', appData, 'Claude/claude_desktop_config.json'),
    },
    vscode: {
      darwin: joinForPlatform('darwin', homeDir, 'Library/Application Support/Code/User/mcp.json'),
      linux: joinForPlatform('linux', xdgConfig, 'Code/User/mcp.json'),
      win32: joinForPlatform('win32', appData, 'Code/User/mcp.json'),
    },
    copilot: {
      darwin: joinForPlatform('darwin', homeDir, 'Library/Application Support/Code/User/mcp.json'),
      linux: joinForPlatform('linux', xdgConfig, 'Code/User/mcp.json'),
      win32: joinForPlatform('win32', appData, 'Code/User/mcp.json'),
    },
    cursor: {
      darwin: joinForPlatform('darwin', homeDir, '.cursor/mcp.json'),
      linux: joinForPlatform('linux', homeDir, '.cursor/mcp.json'),
      win32: joinForPlatform('win32', homeDir, '.cursor/mcp.json'),
    },
    windsurf: {
      darwin: joinForPlatform('darwin', homeDir, '.codeium/windsurf/mcp_config.json'),
      linux: joinForPlatform('linux', homeDir, '.codeium/windsurf/mcp_config.json'),
      win32: joinForPlatform('win32', homeDir, '.codeium/windsurf/mcp_config.json'),
    },
  };

  const paths = configPaths[client];
  return paths[platform] ?? paths.linux;
}

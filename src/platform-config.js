import { join } from 'path';

const SUPPORTED_CLIENTS = new Set(['claude', 'vscode', 'copilot', 'cursor', 'windsurf']);

export function isSupportedClient(client) {
  return SUPPORTED_CLIENTS.has(client);
}

export function isVscodeLikeClient(client) {
  return client === 'vscode' || client === 'copilot';
}

export function resolveConfigPath(client, platform, homeDir, appDataEnv) {
  if (!isSupportedClient(client)) return null;

  const appData = appDataEnv ?? join(homeDir, 'AppData', 'Roaming');

  const configPaths = {
    claude: {
      darwin: join(homeDir, 'Library/Application Support/Claude/claude_desktop_config.json'),
      linux: join(homeDir, '.config/Claude/claude_desktop_config.json'),
      win32: join(appData, 'Claude/claude_desktop_config.json'),
    },
    vscode: {
      darwin: join(homeDir, 'Library/Application Support/Code/User/mcp.json'),
      linux: join(homeDir, '.config/Code/User/mcp.json'),
      win32: join(appData, 'Code/User/mcp.json'),
    },
    copilot: {
      darwin: join(homeDir, 'Library/Application Support/Code/User/mcp.json'),
      linux: join(homeDir, '.config/Code/User/mcp.json'),
      win32: join(appData, 'Code/User/mcp.json'),
    },
    cursor: {
      darwin: join(homeDir, '.cursor/mcp.json'),
      linux: join(homeDir, '.cursor/mcp.json'),
      win32: join(homeDir, '.cursor/mcp.json'),
    },
    windsurf: {
      darwin: join(homeDir, '.codeium/windsurf/mcp_config.json'),
      linux: join(homeDir, '.codeium/windsurf/mcp_config.json'),
      win32: join(homeDir, '.codeium/windsurf/mcp_config.json'),
    },
  };

  const paths = configPaths[client];
  return paths[platform] ?? paths.linux;
}

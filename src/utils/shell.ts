import { execa } from 'execa';
import os from 'node:os';
import { spawn } from 'node:child_process';

/**
 * Get the real user's home directory, even when running under sudo.
 * When `sudo node ...` is used, os.homedir() returns /var/root.
 * This checks SUDO_USER to resolve the actual user's home.
 */
export function realHome(): string {
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && process.getuid?.() === 0) {
    return `/Users/${sudoUser}`;
  }
  return os.homedir();
}

/**
 * Get the real (non-root) username when running under sudo.
 */
export function realUser(): string | undefined {
  return process.env.SUDO_USER;
}

/**
 * Run a command as the real user (not root) when under sudo.
 * For commands like `defaults` that target user-level preferences.
 */
export async function runAsUser(
  cmd: string,
  args: string[],
  opts: { dryRun?: boolean; continueOnError?: boolean; timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const sudoUser = process.env.SUDO_USER;
  if (sudoUser && process.getuid?.() === 0) {
    const escaped = args.map(a => a.replace(/'/g, "'\\''"));
    const fullCmd = `${cmd} ${escaped.map(a => `'${a}'`).join(' ')}`;
    return runCommand('su', ['-l', sudoUser, '-c', fullCmd], { ...opts, continueOnError: opts.continueOnError ?? true });
  }
  return runCommand(cmd, args, { ...opts, continueOnError: opts.continueOnError ?? true });
}

export interface CommandOptions {
  dryRun?: boolean;
  cwd?: string;
  continueOnError?: boolean;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface StreamCommandOptions extends CommandOptions {
  /** Called with the latest line from stdout/stderr for progress updates */
  onProgress?: (line: string) => void;
}

/**
 * Run a command with streaming output, calling onProgress with each line.
 * Useful for long-running installs (brew, mas) where we want live progress.
 */
export async function runStreamedCommand(
  cmd: string,
  args: string[] = [],
  opts: StreamCommandOptions = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (opts.dryRun) {
    return { ok: true, stdout: `[dry-run] ${cmd} ${args.join(' ')}`.trim(), stderr: '' };
  }

  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    const processChunk = (text: string): void => {
      if (!opts.onProgress) return;
      // Split on both \n and \r to capture download progress bars (which use \r)
      const lines = text.split(/[\r\n]+/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) opts.onProgress(trimmed);
      }
    };

    child.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      processChunk(text);
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      processChunk(text);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true, stdout, stderr });
      } else if (opts.continueOnError) {
        resolve({ ok: false, stdout, stderr });
      } else {
        resolve({ ok: false, stdout, stderr });
      }
    });

    child.on('error', (err) => {
      if (opts.continueOnError) {
        resolve({ ok: false, stdout: '', stderr: err.message });
      } else {
        resolve({ ok: false, stdout: '', stderr: err.message });
      }
    });
  });
}

export async function runCommand(
  cmd: string,
  args: string[] = [],
  opts: CommandOptions = {},
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  if (opts.dryRun) {
    return { ok: true, stdout: `[dry-run] ${cmd} ${args.join(' ')}`.trim(), stderr: '' };
  }

  try {
    const result = await execa(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs } : {}),
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (opts.continueOnError) {
      const msg = error instanceof Error ? error.message : String(error);
      return { ok: false, stdout: '', stderr: msg };
    }
    throw error;
  }
}

/** Run a command with full stdio inheritance — for interactive prompts (e.g. 2FA).
 *  Clears the current terminal line first (in case a spinner is active). */
export async function runInteractive(
  cmd: string,
  args: string[] = [],
  opts: { dryRun?: boolean; env?: Record<string, string> } = {},
): Promise<{ ok: boolean }> {
  if (opts.dryRun) {
    console.log(`[dry-run] ${cmd} ${args.join(' ')}`);
    return { ok: true };
  }
  // Clear any active spinner line so the interactive command gets a clean terminal
  process.stderr.write('\x1b[2K\r');
  process.stdout.write('\x1b[2K\r');
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env: { ...process.env, ...opts.env },
    });
    child.on('close', (code) => resolve({ ok: code === 0 }));
    child.on('error', () => resolve({ ok: false }));
  });
}

export async function runCapture(cmd: string, args: string[] = [], cwd?: string): Promise<string> {
  const result = await execa(cmd, args, { cwd, shell: false });
  return result.stdout;
}

export async function commandExists(name: string): Promise<boolean> {
  const result = await runAsUser('which', [name], { continueOnError: true });
  return result.ok;
}

export async function brewFormulaInstalled(name: string): Promise<boolean> {
  const result = await runAsUser('brew', ['list', name], { continueOnError: true });
  return result.ok;
}

export async function brewCaskInstalled(name: string): Promise<boolean> {
  const result = await runAsUser('brew', ['list', '--cask', name], { continueOnError: true });
  return result.ok;
}

export async function masAppInstalled(id: number): Promise<boolean> {
  const result = await runAsUser('mas', ['list'], { continueOnError: true });
  if (!result.ok) return false;
  return result.stdout
    .split('\n')
    .some((line) => line.trim().startsWith(String(id)));
}

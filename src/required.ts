import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isCancel, log, spinner, text } from '@clack/prompts';
import type { InstallOptions } from './types';
import { commandExists, realHome, runCommand } from './utils/shell';

// Core dotfiles that are always safe to symlink (no external dependencies)
const alwaysSafeDotfiles = ['.aliases', '.exports', '.paths', '.gemrc', '.ruby-version'];
// Dotfiles that depend on optional modules — only symlink if deps are met or .zshrc is defensive
const conditionalDotfiles = ['.zshrc'];

async function ensureXcodeCliTools(opts: InstallOptions): Promise<void> {
  const selected = await runCommand('xcode-select', ['-p'], { continueOnError: true });
  if (selected.ok) return;

  if (opts.dryRun) {
    log.info('[dry-run] xcode-select --install');
    return;
  }

  // Trigger the install dialog
  await runCommand('xcode-select', ['--install'], { continueOnError: true });

  // Wait for it to actually complete (GUI installer runs in background)
  log.info('Waiting for Xcode Command Line Tools installation...');
  const maxWaitMs = 30 * 60 * 1000; // 30 minutes max
  const pollMs = 5000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    const check = await runCommand('xcode-select', ['-p'], { continueOnError: true });
    if (check.ok) {
      log.info('Xcode Command Line Tools installed.');
      return;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error('Xcode Command Line Tools installation timed out after 30 minutes.');
}

async function ensureHomebrew(opts: InstallOptions): Promise<void> {
  const hasBrew = await commandExists('brew');
  if (hasBrew) {
    await runCommand('brew', ['update'], { dryRun: opts.dryRun, continueOnError: true });
    return;
  }

  await runCommand(
    '/bin/bash',
    ['-c', '$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)'],
    { dryRun: opts.dryRun, continueOnError: true },
  );
  await runCommand('brew', ['update'], { dryRun: opts.dryRun, continueOnError: true });
}

async function ensureNode(opts: InstallOptions): Promise<void> {
  const hasNode = await commandExists('node');
  const hasNpm = await commandExists('npm');
  if (hasNode && hasNpm) return;

  await runCommand('brew', ['install', 'node'], { dryRun: opts.dryRun, continueOnError: true });
}

async function ensureSshKey(opts: InstallOptions): Promise<void> {
  const sshDir = path.join(realHome(), '.ssh');
  const pubPath = path.join(sshDir, 'id_rsa.pub');

  if (!opts.dryRun) {
    await fs.mkdir(sshDir, { recursive: true });
  }

  // Generate key if it doesn't exist
  const pubExists = await runCommand('test', ['-f', pubPath], { continueOnError: true });
  if (!pubExists.ok) {
    const email = opts.profile.config.git?.user_email ?? 'user@example.com';
    await runCommand('ssh-keygen', ['-t', 'rsa', '-b', '4096', '-C', email, '-f', path.join(sshDir, 'id_rsa'), '-N', ''], {
      dryRun: opts.dryRun,
      continueOnError: true,
    });
    await runCommand('bash', ['-lc', 'eval "$(ssh-agent -s)" && ssh-add -K ~/.ssh/id_rsa'], {
      dryRun: opts.dryRun,
      continueOnError: true,
    });
  }

  // Always ensure the key is on GitHub (handles re-runs where key exists but wasn't added)
  await addSshKeyToGitHub(pubPath, opts);

  // Pre-trust github.com so SSH clone doesn't hang on host verification
  const knownHostsPath = path.join(sshDir, 'known_hosts');
  const alreadyKnown = await runCommand('grep', ['-q', 'github.com', knownHostsPath], { continueOnError: true });
  if (!alreadyKnown.ok) {
    if (opts.dryRun) {
      log.info('[dry-run] ssh-keyscan github.com >> ~/.ssh/known_hosts');
    } else {
      const scan = await runCommand('ssh-keyscan', ['-t', 'ed25519,rsa', 'github.com'], { continueOnError: true });
      if (scan.ok && scan.stdout) {
        await fs.appendFile(knownHostsPath, scan.stdout + '\n');
        log.info('✅ github.com added to known_hosts');
      }
    }
  }
}

async function addSshKeyToGitHub(pubPath: string, opts: InstallOptions): Promise<void> {
  // Try gh CLI first (if available and authenticated)
  const hasGh = await commandExists('gh');
  if (hasGh) {
    const authStatus = await runCommand('gh', ['auth', 'status'], { continueOnError: true });
    if (authStatus.ok) {
      // Check if this key is already on GitHub
      const existingKeys = await runCommand('gh', ['ssh-key', 'list'], { continueOnError: true });
      if (existingKeys.ok) {
        const pubKey = (await fs.readFile(pubPath, 'utf8')).trim();
        const keyFingerprint = pubKey.split(' ')[1] ?? '';
        if (keyFingerprint && existingKeys.stdout.includes(keyFingerprint)) {
          return; // already registered
        }
      }

      const hostname = await runCommand('scutil', ['--get', 'ComputerName'], { continueOnError: true });
      const keyTitle = hostname.ok ? hostname.stdout.trim() : 'macsetup';

      if (opts.dryRun) {
        log.info(`[dry-run] gh ssh-key add ${pubPath} --title "${keyTitle}"`);
        return;
      }

      const result = await runCommand('gh', ['ssh-key', 'add', pubPath, '--title', keyTitle], { continueOnError: true });
      if (result.ok) {
        log.info(`SSH key added to GitHub as "${keyTitle}"`);
        return;
      }
    }
  }

  // Fallback: copy key to clipboard and open GitHub in Safari
  if (opts.dryRun) {
    log.info('[dry-run] Would copy SSH key to clipboard and open GitHub SSH settings in Safari');
    return;
  }

  const pubKey = (await fs.readFile(pubPath, 'utf8')).trim();
  try {
    execSync('pbcopy', { input: pubKey });
    log.info('📋 SSH public key copied to clipboard');
  } catch {
    log.info(`📋 SSH public key:\n${pubKey}`);
  }

  log.info('🌐 Opening GitHub SSH settings in Safari...');
  log.info('   Paste the key (already in your clipboard), give it a name, and click "Add SSH Key".');
  try {
    execSync('open -a Safari https://github.com/settings/ssh/new');
  } catch {
    log.info('   Go to: https://github.com/settings/ssh/new');
  }

  // Wait for user to confirm they've added the key
  const confirmed = await text({
    message: 'Press Enter once you\'ve added the SSH key to GitHub...',
    defaultValue: '',
  });
  if (isCancel(confirmed)) return;
}

async function ensureGitConfig(opts: InstallOptions): Promise<void> {
  const git = opts.profile.config.git;
  if (!git) return;

  if (git.user_name) {
    await runCommand('git', ['config', '--global', 'user.name', git.user_name], {
      dryRun: opts.dryRun,
      continueOnError: true,
    });
  }
  if (git.user_email) {
    await runCommand('git', ['config', '--global', 'user.email', git.user_email], {
      dryRun: opts.dryRun,
      continueOnError: true,
    });
  }
  if (git.global_gitignore) {
    await runCommand('git', ['config', '--global', 'core.excludesfile', git.global_gitignore], {
      dryRun: opts.dryRun,
      continueOnError: true,
    });
  }
}

async function ensureDotfiles(opts: InstallOptions): Promise<void> {
  const { REPO_DIR } = await import('./paths');
  const repoSrc = path.join(REPO_DIR, 'dotfiles');
  // Prefer repo clone dotfiles if available, else use bundled
  let srcDir: string;
  try {
    await fs.access(repoSrc);
    srcDir = repoSrc;
  } catch {
    srcDir = path.join(opts.rootDir, 'dotfiles');
  }
  const home = realHome();
  const { DOTFILES_DIR: dotfilesDir } = await import('./paths');
  const sudoUser = process.env.SUDO_USER;

  if (opts.dryRun) return;

  // Migrate old files from ~/ to ~/.dotfiles/config/ if they exist
  const { CONFIG_DIR } = await import('./paths');
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  for (const oldFile of ['.macsetup-state.json', '.macsetup-state.previous.json', '.macsetup-defaults-backup.json']) {
    const oldPath = path.join(home, oldFile);
    const newName = oldFile.replace('.macsetup-', '').replace('.macsetup-defaults-', 'defaults-');
    const newPath = path.join(CONFIG_DIR, oldFile === '.macsetup-state.json' ? 'state.json' : oldFile === '.macsetup-state.previous.json' ? 'state.previous.json' : 'defaults-backup.json');
    try {
      await fs.access(oldPath);
      await fs.rename(oldPath, newPath);
    } catch { /* doesn't exist, skip */ }
  }

  // Migrate old ~/.dotfiles flat files to ~/.dotfiles/files/
  const oldDotfiles = path.join(home, '.dotfiles');
  try {
    const stat = await fs.lstat(path.join(oldDotfiles, '.zshrc'));
    if (stat.isFile()) {
      // Old layout — files directly in ~/.dotfiles/, move to ~/.dotfiles/files/
      await fs.mkdir(dotfilesDir, { recursive: true });
      for (const file of [...alwaysSafeDotfiles, ...conditionalDotfiles]) {
        const src = path.join(oldDotfiles, file);
        try {
          await fs.access(src);
          await fs.rename(src, path.join(dotfilesDir, file));
        } catch { /* skip */ }
      }
    }
  } catch { /* no old layout */ }

  // Copy dotfiles/ to ~/.dotfiles/files/ (persistent location)
  await fs.mkdir(dotfilesDir, { recursive: true });
  const allFiles = [...alwaysSafeDotfiles, ...conditionalDotfiles];
  for (const file of allFiles) {
    const src = path.join(srcDir, file);
    const srcExists = await runCommand('test', ['-e', src], { continueOnError: true });
    if (!srcExists.ok) continue;
    await fs.copyFile(src, path.join(dotfilesDir, file));
  }

  // Ensure real user owns ~/.dotfiles
  const { DOTFILES_ROOT } = await import('./paths');
  if (sudoUser && process.getuid?.() === 0) {
    await runCommand('chown', ['-R', sudoUser, DOTFILES_ROOT], { continueOnError: true });
  }

  // Symlink ~/.<file> → ~/.dotfiles/files/<file>
  for (const file of allFiles) {
    const src = path.join(dotfilesDir, file);
    const dst = path.join(home, file);
    const srcExists = await runCommand('test', ['-e', src], { continueOnError: true });
    if (!srcExists.ok) continue;

    // Skip if already pointing to the right place
    try {
      const existing = await fs.readlink(dst);
      if (existing === src) continue;
    } catch { /* not a symlink or doesn't exist */ }

    await fs.rm(dst, { recursive: true, force: true });
    await fs.symlink(src, dst);
    if (sudoUser && process.getuid?.() === 0) {
      await runCommand('chown', ['-h', sudoUser, dst], { continueOnError: true });
    }
  }
}

async function ensureHostname(opts: InstallOptions): Promise<void> {
  const current = await runCommand('scutil', ['--get', 'ComputerName'], { continueOnError: true });
  const currentName = current.ok ? current.stdout.trim() : 'unknown';

  const name = await text({
    message: `Set machine name (current: ${currentName})`,
    placeholder: currentName,
    defaultValue: currentName,
  });

  if (isCancel(name) || !name || name === currentName) return;
  if (opts.dryRun) return;

  await runCommand('scutil', ['--set', 'ComputerName', name], { continueOnError: true });
  await runCommand('scutil', ['--set', 'LocalHostName', name], { continueOnError: true });
  await runCommand('scutil', ['--set', 'HostName', name], { continueOnError: true });
}

async function ensureWorkspace(opts: InstallOptions): Promise<void> {
  const { WORKSPACE_DIR } = await import('./paths');
  if (opts.dryRun) {
    log.info(`[dry-run] mkdir -p ${WORKSPACE_DIR}`);
    return;
  }
  await fs.mkdir(WORKSPACE_DIR, { recursive: true });
}

async function acquireSudo(dryRun: boolean): Promise<void> {
  if (dryRun) return;
  // Request sudo upfront and validate — some modules need it (openjdk symlink, pmset, app removal)
  const check = await runCommand('sudo', ['-v'], { continueOnError: true });
  if (!check.ok) {
    log.warn('Could not acquire sudo. Some operations may be skipped.');
  }
}

export async function runRequiredPhase(opts: InstallOptions): Promise<void> {
  // Acquire sudo before spinner — the password prompt needs visible terminal
  await acquireSudo(opts.dryRun);
  const s = spinner();
  s.start('Running required setup phase');
  try {
    await ensureXcodeCliTools(opts);
    await ensureHomebrew(opts);
    await ensureNode(opts);
    await ensureSshKey(opts);
    await ensureGitConfig(opts);
    await ensureDotfiles(opts);
    await ensureWorkspace(opts);
    s.stop('Required phase complete');
    // Clone repo for sync support (after spinner, may need network)
    const { cloneRepo } = await import('./sync');
    await cloneRepo(opts.dryRun);
    // Hostname prompt needs visible terminal — run after spinner
    await ensureHostname(opts);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    s.stop('Required phase failed');
    log.error(`required phase failed: ${message}`);
    throw error;
  }
}

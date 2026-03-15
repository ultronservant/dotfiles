import { log, spinner } from '@clack/prompts';
import type { InstallOptions, ModuleV2, StateFile } from './types';

function resolveExecutionOrder(modules: ModuleV2[], selected: string[]): ModuleV2[] {
  const byName = new Map(modules.map((m) => [m.name, m]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const output: ModuleV2[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Dependency cycle detected at module: ${name}`);
    const mod = byName.get(name);
    if (!mod) throw new Error(`Unknown module: ${name}`);
    visiting.add(name);
    for (const dep of mod.dependencies ?? []) visit(dep);
    visiting.delete(name);
    visited.add(name);
    output.push(mod);
  };

  for (const name of selected) visit(name);
  return output;
}

export async function runModules(
  modules: ModuleV2[],
  selected: Record<string, string[]>,
  opts: InstallOptions,
): Promise<{ failures: string[]; state: StateFile }> {
  const selectedModules = Object.keys(selected).filter((name) => (selected[name] ?? []).length > 0);
  const order = resolveExecutionOrder(modules, selectedModules);
  const failures: string[] = [];

  const machine = (await opts.state.load())?.machine ?? {
    chip: 'unknown',
    ram: 'unknown',
    os: 'unknown',
  };

  const nextState: StateFile = {
    lastRun: new Date().toISOString(),
    profile: opts.profile.name,
    machine,
    modules: {},
  };

  for (const module of order) {
    const selectedItems = selected[module.name] ?? [];
    if (selectedItems.length === 0) continue;

    const s = spinner();
    let spinnerActive = false;
    s.start(`Running module: ${module.label}`);
    spinnerActive = true;

    try {
      const detect = await module.detect(selectedItems, opts);
      const totalItems = selectedItems.length;
      const alreadyDone = detect.installed.length;
      const toInstall = detect.missing;

      if (toInstall.length === 0 && alreadyDone > 0) {
        s.stop(`${module.label}: already installed (${alreadyDone}/${totalItems})`);
        spinnerActive = false;
      } else {
        // Install with per-item progress if module supports it
        if (module.installItem && toInstall.length > 0) {
          for (let i = 0; i < toInstall.length; i++) {
            const item = toInstall[i];
            const itemLabel = module.items.find((it) => it.id === item)?.label ?? item;
            const prefix = `${module.label}: [${alreadyDone + i + 1}/${totalItems}] ${itemLabel}`;
            s.message(prefix);
            await module.installItem(item, {
              ...opts,
              onProgress(line) {
                const short = line.length > 60 ? `${line.slice(0, 57)}...` : line;
                s.message(`${prefix} — ${short}`);
              },
              pauseSpinner() {
                s.stop(prefix);
                spinnerActive = false;
              },
              resumeSpinner(msg?: string) {
                s.start(msg ?? prefix);
                spinnerActive = true;
              },
            });
          }
          s.stop(`${module.label}: complete (${totalItems}/${totalItems})`);
          spinnerActive = false;
        } else {
          // No per-item support — stop spinner, show items, run bulk
          s.stop(`${module.label}: installing ${toInstall.length} item${toInstall.length === 1 ? '' : 's'}...`);
          spinnerActive = false;
          for (const item of toInstall) {
            const itemLabel = module.items.find((it) => it.id === item)?.label ?? item;
            log.info(`  → ${itemLabel}`);
          }
          await module.install(selectedItems, opts);
          log.success(`${module.label}: complete (${totalItems}/${totalItems})`);
        }

        // Verify critical items actually installed
        const criticalItems = toInstall.filter((id) => module.items.find((it) => it.id === id)?.critical);
        if (criticalItems.length > 0) {
          const verify = await module.detect(criticalItems, opts);
          if (verify.missing.length > 0) {
            const failedLabels = verify.missing
              .map((id) => module.items.find((it) => it.id === id)?.label ?? id)
              .join(', ');
            throw new Error(`Critical item(s) failed to install: ${failedLabels}`);
          }
        }
      }

      // Track what actually installed (re-detect to be accurate)
      const finalDetect = await module.detect(selectedItems, opts);
      nextState.modules[module.name] = {
        installed: finalDetect.installed,
        version: '2.0.0',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${module.name}: ${message}`);
      if (spinnerActive) {
        s.stop(`${module.label}: failed`);
      } else {
        log.error(`${module.label}: failed`);
      }
      log.error(`${module.name} failed: ${message}`);
    }
  }

  return { failures, state: nextState };
}

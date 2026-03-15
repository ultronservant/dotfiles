export interface DetectResult {
  installed: string[];
  missing: string[];
  partial: boolean;
}

export interface StateModuleRecord {
  installed: string[];
  version: string;
}

export interface MachineInfo {
  chip: string;
  ram: string;
  os: string;
}

export interface StateFile {
  lastRun: string;
  profile: string;
  modules: Record<string, StateModuleRecord>;
  machine: MachineInfo;
}

export interface MasAppSelection {
  id: number;
  name: string;
}

export interface ProfileConfig {
  name: string;
  description: string;
  modules?: string[];
  core?: string[];
  terminal?: string[];
  languages?: string[];
  ios?: string[];
  android?: string[];
  cloud?: string[];
  apps?: string[];
  comms?: string[];
  productivity?: string[];
  ai?: string[];
  media?: string[];
  mas?: MasAppSelection[];
  macos?: string[];
  macos_complex?: string[];
  cleanup?: string[];
  encryption?: boolean;
  xcode?: boolean;
  config: {
    git?: {
      user_name?: string;
      user_email?: string;
      global_gitignore?: string;
    };
    apps?: { casks?: string[] };
    comms?: { casks?: string[] };
    productivity?: { casks?: string[] };
    ai?: { casks?: string[]; npm?: string[] };
    core?: { formulas?: string[] };
    ios?: { formulas?: string[] };
    cloud?: { formulas?: string[]; casks?: string[] };
    cleanup?: { remove?: string[] };
    mas?: { apps?: MasAppSelection[] };
    terminal?: { enable_powerline?: boolean; theme?: string };
    encryption?: { keychain_service?: string; keychain_account?: string };
    node?: { version?: string };
    python?: { versions?: string[] };
    ruby?: { version?: string };
    python_versions?: string[];
    ruby_version?: string;
    macos?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface RunContext {
  dryRun: boolean;
  verbose: boolean;
  nonInteractive?: boolean;
}

export interface InstallOptions extends RunContext {
  profile: ProfileConfig;
  state: StateManager;
  rootDir: string;
  encryptionPassword?: string;
}

export interface StateManager {
  load(): Promise<StateFile | null>;
  save(state: StateFile): Promise<void>;
  diff(next: StateFile): Promise<string[]>;
}

export interface ModuleItem {
  id: string;
  label: string;
  description?: string;
  /** If true, installation failure is a hard error (not silently skipped) */
  critical?: boolean;
}

export interface ModuleV2 {
  name: string;
  label: string;
  description: string;
  items: ModuleItem[];
  defaultItems: string[];
  dependencies?: string[];
  detect(items: string[], opts: InstallOptions): Promise<DetectResult>;
  install(items: string[], opts: InstallOptions): Promise<void>;
  /** Optional per-item installer for granular progress reporting */
  installItem?(item: string, opts: InstallOptions & { onProgress?: (line: string) => void; pauseSpinner?: () => void; resumeSpinner?: (msg?: string) => void }): Promise<void>;
}

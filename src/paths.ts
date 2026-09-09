import { homedir } from "node:os";
import { join } from "node:path";

export const HOME = homedir();
export const PROJECTS_ROOT = join(HOME, ".claude", "projects");
export const SKILLS_DIR = join(HOME, ".claude", "skills");

// Data lives outside the code path so moving the code never moves the records.
export const DATA_ROOT = join(HOME, ".claude-reflect");
export const DEFAULT_DB = join(DATA_ROOT, "reflect.db");
export const PROPOSALS_DIR = join(DATA_ROOT, "proposals");
export const ROLLBACK_DIR = join(DATA_ROOT, "rollback");
export const CONFIG_PATH = join(DATA_ROOT, "config.json");
export const LEARNED_RULES_PATH = join(DATA_ROOT, "learned-rules.md");
export const CLAUDE_MD_PATH = join(HOME, ".claude", "CLAUDE.md");

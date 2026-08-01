import fs from "node:fs/promises";
import path from "node:path";
import { normalizePath } from "../../shared/path";

interface WorkspaceMember {
  /** Dependency name used in Rust code (e.g., "shared" from `use shared::...`) */
  depName: string;
  /** Package name from Cargo.toml (e.g., "shared-lint-arwaky") */
  packageName: string;
  /** Absolute path to the member's src/ directory */
  srcPath: string;
}

/**
 * Resolves Rust workspace member crate names to their local paths.
 *
 * Parses the workspace Cargo.toml to:
 * 1. Discover member paths from [workspace] members
 * 2. Map dependency names to paths from [workspace.dependencies]
 *
 * The key insight: Rust code uses dependency names (e.g., `use shared::...`),
 * not package names (e.g., `shared-lint-arwaky`). The mapping is in
 * `[workspace.dependencies]`:
 *   shared = { package = "shared-lint-arwaky", path = "crates/shared" }
 *
 * Usage:
 *   const resolver = new WorkspaceResolver("/path/to/workspace/root");
 *   await resolver.init();
 *   const srcPath = resolver.resolveCrate("shared"); // → "/path/to/workspace/crates/shared/src"
 */
export class WorkspaceResolver {
  private readonly workspaceRoot: string;
  private readonly members = new Map<string, WorkspaceMember>();
  private initialized = false;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      // Step 1: Parse [workspace.dependencies] to get dep name → path mapping
      await this.parseWorkspaceDependencies();

      // Step 2: Parse [workspace] members to discover all member directories
      const memberPaths = await this.parseWorkspaceMembers();
      for (const memberRelPath of memberPaths) {
        const memberRoot = path.resolve(this.workspaceRoot, memberRelPath);
        const member = await this.parseMember(memberRoot);
        if (member) {
          this.members.set(member.depName, member);
        }
      }
    } catch {
      // If parsing fails, leave members empty — fallback to no-op
    }

    this.initialized = true;
  }

  resolveCrate(crateName: string): string | null {
    const member = this.members.get(crateName);
    return member?.srcPath ?? null;
  }

  isLocalCrate(crateName: string): boolean {
    return this.members.has(crateName);
  }

  getLocalCrateNames(): string[] {
    return Array.from(this.members.keys());
  }

  getMembers(): WorkspaceMember[] {
    return Array.from(this.members.values());
  }

  /**
   * Parse [workspace.dependencies] to build dep name → path mapping.
   *
   * Example:
   *   [workspace.dependencies]
   *   shared = { package = "shared-lint-arwaky", path = "crates/shared", version = "1.11.0" }
   *   filesystem = { package = "filesystem-lint-arwaky", path = "crates/filesystem", version = "1.11.0" }
   */
  private async parseWorkspaceDependencies(): Promise<void> {
    const cargoPath = path.join(this.workspaceRoot, "Cargo.toml");
    const content = await this.readFileSafe(cargoPath);
    if (!content) return;

    // Extract [workspace.dependencies] section
    const depsMatch = content.match(
      /\[workspace\.dependencies\]([\s\S]*?)(?=\n\[|$)/,
    );
    if (!depsMatch) return;

    const depsSection = depsMatch[1];

    // Parse each dependency line:
    //   shared = { package = "shared-lint-arwaky", path = "crates/shared", version = "1.11.0" }
    //   serde = "1.0"  (external — skip)
    const depRegex = /^([a-z_][a-z0-9_]*)\s*=\s*\{([^}]+)\}/gm;
    let match: RegExpExecArray | null;

    while ((match = depRegex.exec(depsSection)) !== null) {
      const depName = match[1];
      const depBody = match[2];

      // Extract path from the dependency body
      const pathMatch = depBody.match(/path\s*=\s*"([^"]+)"/);
      if (!pathMatch) continue; // External crate (no path) — skip

      const memberPath = pathMatch[1];
      const memberRoot = path.resolve(this.workspaceRoot, memberPath);
      const srcPath = path.join(memberRoot, "src");

      // Verify src/ exists
      try {
        await fs.access(srcPath);
      } catch {
        continue;
      }

      // Extract package name if present
      const packageMatch = depBody.match(/package\s*=\s*"([^"]+)"/);
      const packageName = packageMatch?.[1] ?? depName;

      this.members.set(depName, {
        depName,
        packageName,
        srcPath: normalizePath(srcPath),
      });
    }
  }

  /**
   * Parse [workspace] members to get member directory paths.
   */
  private async parseWorkspaceMembers(): Promise<string[]> {
    const cargoPath = path.join(this.workspaceRoot, "Cargo.toml");
    const content = await this.readFileSafe(cargoPath);
    if (!content) return [];

    const membersMatch = content.match(
      /\[workspace\][\s\S]*?members\s*=\s*\[([\s\S]*?)\]/,
    );
    if (!membersMatch) return [];

    const membersStr = membersMatch[1];
    const members: string[] = [];

    const entryRegex = /"([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = entryRegex.exec(membersStr)) !== null) {
      const entry = match[1];
      if (entry.includes("*")) {
        const expanded = await this.expandGlob(entry);
        members.push(...expanded);
      } else {
        members.push(entry);
      }
    }

    return members;
  }

  private async parseMember(
    memberRoot: string,
  ): Promise<WorkspaceMember | null> {
    const cargoPath = path.join(memberRoot, "Cargo.toml");
    const content = await this.readFileSafe(cargoPath);
    if (!content) return null;

    const nameMatch = content.match(/\[package\][\s\S]*?name\s*=\s*"([^"]+)"/);
    if (!nameMatch) return null;

    const packageName = nameMatch[1];
    const srcPath = path.join(memberRoot, "src");
    try {
      await fs.access(srcPath);
    } catch {
      return null;
    }

    // Derive dep name from package name: "shared-lint-arwaky" → check workspace.dependencies
    // If not found in dependencies, use package name with hyphens → underscores
    const depName = packageName.replace(/-/g, "_");

    return {
      depName,
      packageName,
      rootPath: normalizePath(memberRoot),
      srcPath: normalizePath(srcPath),
    } as WorkspaceMember;
  }

  private async expandGlob(pattern: string): Promise<string[]> {
    const parts = pattern.split("*");
    if (parts.length !== 2) return [pattern];

    const dir = path.resolve(this.workspaceRoot, parts[0]);
    const suffix = parts[1];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const results: string[] = [];
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = path.join(parts[0], e.name + suffix);
        const cargoPath = path.resolve(this.workspaceRoot, p, "Cargo.toml");
        try {
          await fs.access(cargoPath);
          results.push(p);
        } catch {
          // skip
        }
      }
      return results;
    } catch {
      return [];
    }
  }

  private async readFileSafe(filePath: string): Promise<string | null> {
    try {
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }
}

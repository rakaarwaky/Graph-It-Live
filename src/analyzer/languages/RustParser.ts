import fs from "node:fs/promises";
import path from "node:path";
import { Node, Parser } from "web-tree-sitter";
import { normalizePath } from "../../shared/path";
import { FileReader } from "../FileReader";
import { Dependency, ILanguageAnalyzer, SpiderError } from "../types";
import { extractFilePath } from "../utils/PathExtractor";
import { WasmParserFactory } from "./WasmParserFactory";
import { WorkspaceResolver } from "./WorkspaceResolver";

/**
 * Rust import parser backed by tree-sitter WASM.
 * Requires `extensionPath` to locate `dist/wasm`.
 * In unit tests, mock `WasmParserFactory` directly to avoid WASM initialization.
 */
export class RustParser implements ILanguageAnalyzer {
  private parser: Parser | null = null;
  private readonly fileReader: FileReader;
  private readonly rootDir: string;
  private readonly extensionPath?: string;
  private initPromise: Promise<void> | null = null;
  private workspaceResolver: WorkspaceResolver | null = null;

  constructor(rootDir?: string, extensionPath?: string) {
    this.fileReader = new FileReader();
    this.rootDir = rootDir || process.cwd();
    this.extensionPath = extensionPath;
    // Initialize workspace resolver for cross-crate imports
    this.workspaceResolver = new WorkspaceResolver(this.rootDir);
  }

  /** Lazily initializes the WASM parser and reuses a single init promise. */
  private async ensureInitialized(): Promise<void> {
    // If parser is already initialized, return immediately
    if (this.parser) {
      return;
    }

    // Start initialization if not already in progress
    this.initPromise ??= (async () => {
      const extensionPath = await this.resolveExtensionPath();
      if (!extensionPath) {
        throw new Error(
          "Extension path required for WASM parser initialization. " +
          "Ensure RustParser is constructed with extensionPath parameter."
        );
      }

      try {
        const factory = WasmParserFactory.getInstance();

        // Initialize web-tree-sitter with core WASM file
        const treeSitterWasmPath = path.join(
          extensionPath,
          "dist",
          "wasm",
          "tree-sitter.wasm"
        );
        await factory.init(treeSitterWasmPath);

        // Load Rust language WASM and get parser
        const rustWasmPath = path.join(
          extensionPath,
          "dist",
          "wasm",
          "tree-sitter-rust.wasm"
        );
        this.parser = await factory.getParser("rust", rustWasmPath);
      } catch (error) {
        // Clear the promise so retry is possible
        this.initPromise = null;
        
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to initialize Rust WASM parser: ${errorMessage}`,
          { cause: error }
        );
      }
    })();

    await this.initPromise;
  }

  private async resolveExtensionPath(): Promise<string | undefined> {
    if (this.extensionPath) {
      return this.extensionPath;
    }

    // Test/dev fallback: if running from repository root, use local dist/wasm.
    const cwdExtensionPath = process.cwd();
    const fallbackWasmPath = path.join(cwdExtensionPath, "dist", "wasm", "tree-sitter.wasm");

    try {
      await fs.access(fallbackWasmPath);
      return cwdExtensionPath;
    } catch {
      return undefined;
    }
  }

  /**
   * Parse Rust imports from a file
   */
  async parseImports(filePath: string): Promise<Dependency[]> {
    try {
      // Ensure WASM parser is initialized
      await this.ensureInitialized();

      // Extract file path from potential symbol ID
      const actualPath = extractFilePath(filePath);
      const content = await this.fileReader.readFile(actualPath);
      const tree = this.parser?.parse(content);
      if (!tree) {
        throw new Error(`Failed to parse Rust file: ${actualPath}`);
      }
      const dependencies: Dependency[] = [];
      const seen = new Set<string>();

      this.traverseTree(tree.rootNode, (node) => {
        // Handle: use path::to::module;
        if (node.type === "use_declaration") {
          this.extractUseDeclaration(node, dependencies, seen, content);
        }
        // Handle: mod module_name;
        else if (node.type === "mod_item") {
          this.extractModItem(node, dependencies, seen, content, filePath);
        }
        // Handle: extern crate crate_name;
        else if (node.type === "extern_crate_declaration") {
          this.extractExternCrate(node, dependencies, seen, content);
        }
      });

      return dependencies;
    } catch (error) {
      throw SpiderError.fromError(error, filePath);
    }
  }

  /**
   * Resolve Rust module path to absolute file path
   * IMPORTANT: Filters out external crates (std, serde, rustpython_vm, etc.)
   * Only resolves local modules to prevent false cycles
   */
  async resolvePath(
    fromFile: string,
    moduleSpecifier: string,
  ): Promise<string | null> {
    try {
      // Ensure WASM parser is initialized
      await this.ensureInitialized();

      // Initialize workspace resolver lazily
      if (this.workspaceResolver && !this.workspaceResolver['initialized']) {
        await this.workspaceResolver.init();
      }

      const actualFromFile = extractFilePath(fromFile);
      const fromDir = path.dirname(actualFromFile);

      // 1. Handle relative modules (self, super, crate) — always try first
      if (
        moduleSpecifier.startsWith("self::") ||
        moduleSpecifier.startsWith("super::") ||
        moduleSpecifier.startsWith("crate::")
      ) {
        return await this.resolveRelativeModule(fromFile, moduleSpecifier);
      }

      // 2. Try local module resolution FIRST (from current crate's directory)
      // This handles: mod filesystem; in shared/src/lib.rs → shared/src/filesystem/
      const localResult = await this.resolveModDeclaration(fromDir, moduleSpecifier);
      if (localResult) {
        // Type lookup: if result is barrel and last segment is a type, find the actual file
        const lastSegOrig = moduleSpecifier.split("::").pop()?.split("/").pop() ?? "";
        const isType = lastSegOrig.length > 0 && lastSegOrig[0] === lastSegOrig[0].toUpperCase();
        if (isType && (localResult.endsWith("/mod.rs") || localResult.endsWith("/lib.rs"))) {
          const lookup = await this.findTypeDefinitionFile(path.dirname(localResult), [lastSegOrig]);
          if (lookup) return lookup;
        }
        return localResult;
      }

      // 3. Check hardcoded external crates (quick skip)
      const firstComponent = moduleSpecifier.split("::")[0];
      const externalCrates = new Set([
        "std", "core", "alloc", "proc_macro", "test",
        "serde", "tokio", "async_std", "futures",
        "vm", "rustpython_vm", "rustpython",
        "rustpython_parser", "rustpython_compiler",
        "num_traits", "enum_dispatch", "dashmap",
      ]);
      if (externalCrates.has(firstComponent)) {
        return null;
      }

      // 4. Check workspace crates (only if not found locally)
      // This handles: use shared::filesystem::... from naming-rules crate
      if (this.workspaceResolver?.isLocalCrate(firstComponent)) {
        const crateSrcPath = this.workspaceResolver.resolveCrate(firstComponent);
        if (crateSrcPath) {
          const remainingPath = moduleSpecifier
            .split("::")
            .slice(1)
            .join("/");
          
          // Try resolving the remaining path
          const resolved = await this.resolveModDeclaration(crateSrcPath, remainingPath);
          if (resolved) {
            // Type lookup: if result is mod.rs/lib.rs and last segment is a type, find the actual file
            const lastSegOrig = moduleSpecifier.split("::").pop() ?? "";
            const isType = lastSegOrig.length > 0 && lastSegOrig[0] === lastSegOrig[0].toUpperCase();
            if (isType && (resolved.endsWith("/mod.rs") || resolved.endsWith("/lib.rs"))) {
              const barrelDir = path.dirname(resolved);
              try {
                const barrelContent = await fs.readFile(resolved, "utf-8");
                const pubModRe = /pub\s+mod\s+([a-z_][a-z0-9_]*)\s*;/g;
                let mm;
                while ((mm = pubModRe.exec(barrelContent)) !== null) {
                  for (const mf of [path.join(barrelDir, mm[1] + ".rs"), path.join(barrelDir, mm[1], "mod.rs")]) {
                    try {
                      const mc = await fs.readFile(mf, "utf-8");
                      const tr = new RegExp("(?:pub\\s+(?:struct|enum|trait|type)\\s+|pub\\s+use\\s+[^;]*\\b)" + lastSegOrig + "\\b");
                      if (tr.test(mc)) return normalizePath(mf);
                    } catch {}
                  }
                }
              } catch {}
            }
            return resolved;
          }
          
          // Fallback: if remaining path is a type (uppercase), return crate's lib.rs
          const lastSegment = remainingPath.split("/").pop() ?? "";
          if (lastSegment && lastSegment[0] === lastSegment[0].toUpperCase()) {
            const libRs = path.join(crateSrcPath, "lib.rs");
            if (await this.fileExists(libRs)) {
              return normalizePath(libRs);
            }
          }
        }
      }

      return null;
    } catch {
      // Resolution failures are not critical - return null
      return null;
    }
  }

  /**
   * Extract use declaration: use path::to::module;
   */
  private extractUseDeclaration(
    node: Node,
    dependencies: Dependency[],
    seen: Set<string>,
    content: string,
  ): void {
    // Find scoped_identifier or identifier nodes
    const identifiers = this.collectIdentifiers(node, content);

    // Hardcoded external crates (quick skip for common ones)
    const externalCrates = new Set([
      "std", "core", "alloc", "proc_macro", "test",
      "serde", "tokio", "async_std", "futures",
      "vm", "rustpython_vm", "rustpython",
      "rustpython_parser", "rustpython_compiler",
      "num_traits", "enum_dispatch", "dashmap",
    ]);

    for (const module of identifiers) {
      if (!module) continue;
      
      const firstComponent = module.split("::")[0];
      
      // Skip hardcoded external crates
      if (externalCrates.has(firstComponent)) {
        continue;
      }
      
      // Include everything else — workspace resolver handles resolution, not filtering
      // Keep original case for type detection (uppercase = type name)
      // resolveModDeclaration handles lowercase conversion internally
      const normalizedModule = module.toLowerCase();
      
      if (!seen.has(normalizedModule)) {
        seen.add(normalizedModule);
        dependencies.push({
          path: "",
          type: "import",
          line: node.startPosition.row + 1,
          module: module, // Keep original case for type detection
        });
      }
    }
  }

  /**
   * Extract mod item: mod module_name;
   */
  private extractModItem(
    node: Node,
    dependencies: Dependency[],
    seen: Set<string>,
    content: string,
    _filePath: string,
  ): void {
    // Check if this is a mod declaration (not an inline mod { ... })
    const hasBody = this.findChildByType(node, "declaration_list");
    if (hasBody) {
      return; // Inline module, not an import
    }

    // Find the module name
    const nameNode = this.findChildByType(node, "identifier");
    if (nameNode) {
      let module = this.getNodeText(nameNode, content);
      // Keep original case for type detection — resolveModDeclaration handles lowercase internally
      
      if (module && !seen.has(module)) {
        seen.add(module);
        dependencies.push({
          path: "",
          type: "import",
          line: node.startPosition.row + 1,
          module,
        });
      }
    }
  }

  /**
   * Extract extern crate declaration: extern crate crate_name;
   * IMPORTANT: External crates are not file dependencies, skip them
   */
  private extractExternCrate(
    node: Node,
    dependencies: Dependency[],
    seen: Set<string>,
    content: string,
  ): void {
    const nameNode = this.findChildByType(node, "identifier");
    if (nameNode) {
      const module = this.getNodeText(nameNode, content);
      if (!module) return;

      // Skip hardcoded external crates
      const externalCrates = new Set([
        "std", "core", "alloc", "proc_macro", "test",
        "serde", "tokio", "async_std", "futures",
        "vm", "rustpython_vm", "rustpython",
        "rustpython_parser", "rustpython_compiler",
        "num_traits", "enum_dispatch", "dashmap",
      ]);
      if (externalCrates.has(module)) {
        return;
      }

      // Include everything else — workspace resolver handles resolution, not filtering
      if (!seen.has(module)) {
        seen.add(module);
        dependencies.push({
          path: "",
          type: "import",
          line: node.startPosition.row + 1,
          module: module,
        });
      }
    }
  }

  /**
   * Collect all identifiers from use declaration
   * IMPORTANT: Only collect module paths (snake_case), not type names (PascalCase)
   */
  /**
   * Expand use_list syntax: use path::{A, B, C} → ["path::A", "path::B", "path::C"]
   * This ensures each type import gets its own resolvePath call.
   */
  private expandUseLists(
    node: Node,
    content: string,
    identifiers: string[],
    seen: Set<string>,
  ): void {
    const scopedUseLists = this.findAllByType(node, "scoped_use_list");
    for (const scopedUseList of scopedUseLists) {
      // Get the base path (e.g., "shared::code_analysis")
      const basePathNode = this.findChildByType(scopedUseList, "scoped_identifier");
      if (!basePathNode) continue;
      const basePath = this.getNodeText(basePathNode, content);
      if (!basePath) continue;

      // Get the use_list node (e.g., "{A, B, C}")
      const useListNode = this.findChildByType(scopedUseList, "use_list");
      if (!useListNode) continue;

      // Extract individual identifiers from use_list
      for (const child of useListNode.children) {
        if (child.type === "identifier") {
          const name = this.getNodeText(child, content);
          if (!name || name === "*") continue;
          const fullPath = `${basePath}::${name}`;
          if (!seen.has(fullPath)) {
            seen.add(fullPath);
            identifiers.push(fullPath);
          }
        }
      }
    }
  }

  private collectIdentifiers(
    node: Node,
    content: string,
  ): string[] {
    const identifiers: string[] = [];
    const seen = new Set<string>();

    // Expand use_list: use path::{A, B, C} → ["path::A", "path::B", "path::C"]
    // This ensures each type gets its own resolvePath call
    this.expandUseLists(node, content, identifiers, seen);

    // Find scoped_identifier (e.g., std::collections::HashMap or crate::interpreter::func)
    // Only collect OUTERMOST scoped_identifiers (skip nested prefixes)
    const scopedIds = this.findAllByType(node, "scoped_identifier");
    for (const scopedId of scopedIds) {
      const text = this.getNodeText(scopedId, content);
      if (!text) continue;

      // Check if this scoped_identifier is a child of another scoped_identifier
      // If so, skip it — we only want the full path
      let isNested = false;
      let parent = scopedId.parent;
      while (parent) {
        if (parent.type === "scoped_identifier") {
          isNested = true;
          break;
        }
        parent = parent.parent;
      }
      if (isNested) continue;

      // Deduplicate
      if (!seen.has(text)) {
        seen.add(text);
        identifiers.push(text);
      }
    }

    // Also collect simple identifiers, but ONLY if they're snake_case (module names)
    // CRITICAL: Skip identifiers that are children of scoped_identifier nodes
    const simpleIds = this.findAllByType(node, "identifier");
    for (const id of simpleIds) {
      const text = this.getNodeText(id, content);
      if (!text || text === "self" || text === "super" || text === "crate") {
        continue;
      }

      // Reject PascalCase identifiers (types/symbols, not modules)
      const firstChar = text.charAt(0);
      if (firstChar === firstChar.toUpperCase() && firstChar !== firstChar.toLowerCase()) {
        continue;
      }

      // Skip if already seen as part of a scoped_identifier
      if (seen.has(text)) continue;

      // Skip if this identifier is a child of a scoped_identifier
      // (e.g., "shared" inside "shared::common::taxonomy_path_vo")
      let parent = id.parent;
      let isInsideScoped = false;
      while (parent) {
        if (parent.type === "scoped_identifier") {
          isInsideScoped = true;
          break;
        }
        parent = parent.parent;
      }
      if (isInsideScoped) continue;

      identifiers.push(text);
    }

    return identifiers;
  }

  /**
   * Resolve relative module (self::, super::, crate::)
   */
  private async resolveRelativeModule(
    fromFile: string,
    moduleSpecifier: string,
  ): Promise<string | null> {
    const fromDir = path.dirname(fromFile);

    // Handle crate::module -> resolve from crate root (find lib.rs/src/)
    if (moduleSpecifier.startsWith("crate::")) {
      const relativePath = moduleSpecifier.slice(7).replaceAll("::", "/");
      // Find crate root by walking up from current file to find lib.rs or src/
      let crateRoot = path.dirname(fromFile);
      while (crateRoot !== path.dirname(crateRoot)) {
        if (await this.fileExists(path.join(crateRoot, "lib.rs")) ||
            await this.fileExists(path.join(crateRoot, "src", "lib.rs"))) {
          // Found crate root
          const srcDir = await this.fileExists(path.join(crateRoot, "src", "lib.rs"))
            ? path.join(crateRoot, "src")
            : crateRoot;
          return await this.resolveModDeclaration(srcDir, relativePath);
        }
        crateRoot = path.dirname(crateRoot);
      }
      // Fallback to workspace root
      return await this.resolveModDeclaration(this.rootDir, relativePath);
    }

    // Handle super::module -> go up one directory
    if (moduleSpecifier.startsWith("super::")) {
      const parentDir = path.dirname(fromDir);
      const relativePath = moduleSpecifier.slice(7).replaceAll("::", "/");
      return await this.resolveModDeclaration(parentDir, relativePath);
    }

    // Handle self::module -> same directory
    if (moduleSpecifier.startsWith("self::")) {
      const relativePath = moduleSpecifier.slice(6).replaceAll("::", "/");
      return await this.resolveModDeclaration(fromDir, relativePath);
    }

    // Handle cross-crate imports via workspace resolver
    // e.g., in naming-rules: use shared::filesystem::...
    // The first component might be a workspace member crate
    if (this.workspaceResolver) {
      const firstComponent = moduleSpecifier.split("::")[0];
      if (this.workspaceResolver.isLocalCrate(firstComponent)) {
        const crateSrcPath = this.workspaceResolver.resolveCrate(firstComponent);
        if (crateSrcPath) {
          const remainingPath = moduleSpecifier
            .split("::")
            .slice(1)
            .join("/");
          return await this.resolveModDeclaration(crateSrcPath, remainingPath);
        }
      }
    }

    return null;
  }

  /**
   * Resolve mod declaration (module_name)
   * IMPORTANT: Rust file names are always lowercase, regardless of how they're referenced
   * If the module name has uppercase letters, it's likely a type/symbol name from an external crate
   */
  private async resolveModDeclaration(
    fromDir: string,
    moduleName: string,
  ): Promise<string | null> {
    // Reject empty or invalid module names
    if (!moduleName || moduleName.trim().length === 0) {
      return null;
    }

    // Reject clearly invalid paths (starts with /, contains .., etc.)
    if (moduleName.startsWith("/") || moduleName.includes("..")) {
      return null;
    }

    // Convert :: to / for path resolution
    let modulePath = moduleName.replaceAll("::", "/");
    modulePath = modulePath.toLowerCase();

    // Reject empty path after normalization
    if (!modulePath || modulePath === "/") {
      return null;
    }

    const segments = modulePath.split("/").filter(Boolean);
    if (segments.length === 0) return null;

    // Strategy 0: Progressive resolution (handle type imports)
    const progressiveResult = await this.resolveProgressive(fromDir, segments);
    if (progressiveResult) {
      // If result is a mod.rs/lib.rs AND last segment is a type (uppercase),
      // check re-exports to find the actual definition file
      // IMPORTANT: Check ORIGINAL moduleName, not lowercased segments
      const lastSegOriginal = moduleName.split("::").pop()?.split("/").pop() ?? "";
      const isTypeImport = lastSegOriginal.length > 0 && lastSegOriginal[0] === lastSegOriginal[0].toUpperCase();
      
      if (isTypeImport && (progressiveResult.endsWith("/mod.rs") || progressiveResult.endsWith("/lib.rs"))) {
        // Inline: scan pub mod declarations to find which module defines the type
        const barrelDir = path.dirname(progressiveResult);
        let barrelContent: string | null = null;
        try { barrelContent = await fs.readFile(progressiveResult, "utf-8"); } catch {}
                if (barrelContent) {
          const pubModRe = /pub\s+mod\s+([a-z_][a-z0-9_]*)\s*;/g;
          let mm: RegExpExecArray | null;
          while ((mm = pubModRe.exec(barrelContent)) !== null) {
            const mName = mm[1];
            for (const mFile of [path.join(barrelDir, mName + ".rs"), path.join(barrelDir, mName, "mod.rs")]) {
              try {
                const mContent = await fs.readFile(mFile, "utf-8");
                const typeRe = new RegExp("(?:pub\\s+(?:struct|enum|trait|type)\\s+|pub\\s+use\\s+[^;]*\\b)" + lastSegOriginal + "\\b");
                const matched = typeRe.test(mContent);
                if (mName === "taxonomy_path_vo") console.log("SCAN_DB: mFile=" + mFile + " contentLen=" + mContent.length + " matched=" + matched + " hasPubStruct=" + mContent.includes("pub struct FilePath") + " regexSource=" + typeRe.source);
                if (matched) return normalizePath(mFile);
              } catch(e) {}
            }
          }
        }
      }
            return progressiveResult;
    }

    // Strategy 0b: If last segment is not a file, try parent path
    if (segments.length > 1) {
      const parentSegments = segments.slice(0, -1);
      const parentResult = await this.resolveModChain(fromDir, parentSegments);
      if (parentResult) return parentResult;
    }

    // Strategy 1: Direct file/directory lookup
    const directResult = await this.resolveDirectPath(fromDir, modulePath);
    if (directResult) return directResult;

    // Strategy 2: Recursive mod chain resolution
    const recursiveResult = await this.resolveModChain(fromDir, segments);
    if (recursiveResult) return recursiveResult;

    // Strategy 3: Re-export resolution (pub use)
    const reexportResult = await this.findTypeDefinitionFile(fromDir, segments);
    if (reexportResult) return reexportResult;

    // Strategy 4: Workspace crate resolution
    if (this.workspaceResolver) {
      const firstSegment = segments[0];
      if (this.workspaceResolver.isLocalCrate(firstSegment)) {
        const crateSrcPath = this.workspaceResolver.resolveCrate(firstSegment);
        if (crateSrcPath) {
          const remainingPath = segments.slice(1).join("/");
          if (remainingPath) {
            return await this.resolveModDeclaration(crateSrcPath, remainingPath);
          }
          const libRs = path.join(crateSrcPath, "lib.rs");
          if (await this.fileExists(libRs)) {
            return normalizePath(libRs);
          }
        }
      }
    }

    return null;
  }

  /**
   * Strategy 0: Progressive resolution.
   * Try the full path, then progressively shorter prefixes.
   * This handles type imports like `use shared::common::taxonomy_path_vo::FilePath`
   * where FilePath is a TYPE, not a module.
   *
   * Returns the deepest MODULE file that resolves (not a type file).
   */
  private async resolveProgressive(
    fromDir: string,
    segments: string[],
  ): Promise<string | null> {
    // Try from full path down to single segment
    for (let len = segments.length; len >= 1; len--) {
      const partialPath = segments.slice(0, len).join("/");
      const result = await this.resolveDirectPath(fromDir, partialPath);
      if (result) return result;

      // Also try mod chain for this prefix
      const chainResult = await this.resolveModChain(fromDir, segments.slice(0, len));
      if (chainResult) return chainResult;
    }
    return null;
  }

  /**
   * Strategy 1: Direct file/directory lookup.
   * Try module.rs, module/mod.rs for the full path.
   */
  private async resolveDirectPath(
    fromDir: string,
    modulePath: string,
  ): Promise<string | null> {
    const candidates = [
      path.join(fromDir, modulePath + ".rs"),
      path.join(fromDir, modulePath, "mod.rs"),
    ];

    for (const candidate of candidates) {
      if (await this.fileExists(candidate)) {
        return normalizePath(candidate);
      }
    }
    return null;
  }

  /**
   * Strategy 2: Recursive mod chain resolution.
   * Follow mod declarations one segment at a time:
   *   lib.rs → mod common; → common/mod.rs → mod taxonomy_path_vo; → taxonomy_path_vo.rs
   */
  private async resolveModChain(
    fromDir: string,
    segments: string[],
  ): Promise<string | null> {
    let currentDir = fromDir;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLast = i === segments.length - 1;

      // Try module.rs (leaf file)
      const fileCandidate = path.join(currentDir, segment + ".rs");
      if (await this.fileExists(fileCandidate)) {
        if (isLast) {
          return normalizePath(fileCandidate);
        }
        // Not last segment — can't go deeper from a .rs file
        // (unless it's a mod.rs, which we try next)
      }

      // Try module/mod.rs (directory module)
      const modDir = path.join(currentDir, segment);
      const modRs = path.join(modDir, "mod.rs");
      if (await this.fileExists(modRs)) {
        if (isLast) {
          return normalizePath(modRs);
        }
        // Continue to next segment from this directory
        currentDir = modDir;
        continue;
      }

      // Try hyphen variant: cli_commands -> cli-commands
      const hyphenSegment = segment.replace(/_/g, "-");
      if (hyphenSegment !== segment) {
        const hyphenModDir = path.join(currentDir, hyphenSegment);
        const hyphenModRs = path.join(hyphenModDir, "mod.rs");
        if (await this.fileExists(hyphenModRs)) {
          if (isLast) return normalizePath(hyphenModRs);
          currentDir = hyphenModDir;
          continue;
        }
        const hyphenFile = path.join(currentDir, hyphenSegment + ".rs");
        if (await this.fileExists(hyphenFile)) {
          if (isLast) return normalizePath(hyphenFile);
        }
      }

      // Can't resolve this segment
      return null;
    }

    return null;
  }

  /**
   * Strategy 3: Re-export resolution (pub use).
   * Check barrel files (lib.rs, mod.rs) for pub use statements that re-export the target.
   * Also follows pub mod declarations to find which module defines the type.
   */
  /**
   * Expand a module import (e.g., "shared::common") into all re-exported type files.
   * Returns an array of absolute paths to the actual type definition files,
   * skipping mod.rs/lib.rs barrel files.
   */
  async expandModuleImport(
    fromFile: string,
    moduleSpecifier: string,
  ): Promise<string[]> {
    const resolved = await this.resolvePath(fromFile, moduleSpecifier);
    if (!resolved) return [];

    // If not a barrel file, return as-is
    if (!resolved.endsWith("/mod.rs") && !resolved.endsWith("/lib.rs")) {
      return [resolved];
    }

    // Read barrel file and extract all pub use re-exports
    const barrelDir = path.dirname(resolved);
    let barrelContent: string;
    try {
      barrelContent = await fs.readFile(resolved, "utf-8");
    } catch {
      return [resolved];
    }

    const results: string[] = [];
    const pubUseRe = /pub\s+use\s+([a-zA-Z_][a-zA-Z0-9_:]*)(?:\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*))?\s*;/g;
    let match: RegExpExecArray | null;

    while ((match = pubUseRe.exec(barrelContent)) !== null) {
      const reexportPath = match[1];
      const alias = match[2];
      const typeName = alias || reexportPath.split("::").pop();

      // Skip non-type re-exports (lowercase = module re-export)
      if (!typeName || typeName[0] !== typeName[0].toUpperCase()) continue;

      try {
        const reexportResolved = await this.resolvePath(resolved, reexportPath);
        if (reexportResolved && !reexportResolved.endsWith("/mod.rs") && !reexportResolved.endsWith("/lib.rs")) {
          if (!results.includes(reexportResolved)) {
            results.push(reexportResolved);
          }
        }
      } catch {}
    }

    return results.length > 0 ? results : [resolved];
  }

  private async findTypeDefinitionFile(
    fromDir: string,
    segments: string[],
  ): Promise<string | null> {
    const barrelFiles = ["lib.rs", "mod.rs"];

    for (const barrel of barrelFiles) {
      const barrelPath = path.join(fromDir, barrel);
      if (!(await this.fileExists(barrelPath))) continue;

      const content = await this.readFileSafe(barrelPath);
      if (!content) continue;

      // 1. Check pub use statements — follow re-export chains
      const pubUseRegex = /pub\s+use\s+([a-zA-Z_][a-zA-Z0-9_:]*)(?:\s+as\s+([a-zA-Z_][a-zA-Z0-9_]*))?\s*;/g;
      let match: RegExpExecArray | null;
      const lastSeg = segments[segments.length - 1] ?? "";

      while ((match = pubUseRegex.exec(content)) !== null) {
        const reexportPath = match[1];
        const pubUseAlias = match[2];
        const pubUseLast = reexportPath.split("::").pop() ?? "";
        if (pubUseLast === lastSeg || pubUseAlias === lastSeg) {
          // Resolve the re-export path to find actual definition file
          const resolved = await this.resolveModDeclaration(fromDir, reexportPath);
          if (resolved && (resolved.endsWith("/mod.rs") || resolved.endsWith("/lib.rs"))) {
            const deeper = await this.findTypeDefinitionFile(path.dirname(resolved), [lastSeg]);
            if (deeper) return deeper;
          }
          return resolved ?? normalizePath(barrelPath);
        }
      }

      // 2. Check pub mod declarations — find which module might define the type
      // This handles: use shared::common::FilePath
      // where FilePath is defined in taxonomy_path_vo.rs (re-exported via pub mod)
      const lastSegment = segments[segments.length - 1] ?? "";
      if (lastSegment && lastSegment[0] === lastSegment[0].toUpperCase()) {
        // Last segment is a type name (uppercase) — look for pub mod declarations
        const pubModRegex = /pub\s+mod\s+([a-z_][a-z0-9_]*)\s*;/g;
        let modMatch: RegExpExecArray | null;

        while ((modMatch = pubModRegex.exec(content)) !== null) {
          const modName = modMatch[1];
          // Check if this module file contains the type
          const modFilePath = path.join(fromDir, modName + ".rs");
          const modDirPath = path.join(fromDir, modName, "mod.rs");

          let modContent: string | null = null;
          if (await this.fileExists(modFilePath)) {
            modContent = await this.readFileSafe(modFilePath);
          } else if (await this.fileExists(modDirPath)) {
            modContent = await this.readFileSafe(modDirPath);
          }

          if (modContent) {
            // Check if the type is defined in this module
            const typeRegex = new RegExp("(?:pub\\s+(?:struct|enum|trait|type)\\s+|pub\\s+use\\s+[^;]*\\b)" + lastSegment + "\\b");
            if (typeRegex.test(modContent)) {
              // Found! Return this module file
              if (await this.fileExists(modFilePath)) {
                return normalizePath(modFilePath);
              }
              if (await this.fileExists(modDirPath)) {
                return normalizePath(modDirPath);
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Check if target segments match (exact or suffix match).
   */
  private segmentsMatch(reexportSegments: string[], targetSegments: string[]): boolean {
    if (reexportSegments.length === targetSegments.length) {
      return reexportSegments.every((s, i) => s === targetSegments[i]);
    }
    if (reexportSegments.length > targetSegments.length) {
      const suffix = reexportSegments.slice(reexportSegments.length - targetSegments.length);
      return suffix.every((s, i) => s === targetSegments[i]);
    }
    return false;
  }

  /**
   * Read file content safely.
   */
  private async readFileSafe(filePath: string): Promise<string | null> {
    try {
      const fs = await import("node:fs/promises");
      return await fs.readFile(filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Check if file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Traverse tree and call visitor for each node
   */
  private traverseTree(
    node: Node,
    visitor: (node: Node) => void,
  ): void {
    visitor(node);
    for (const child of node.children) {
      this.traverseTree(child, visitor);
    }
  }

  /**
   * Find first child of a specific type
   */
  private findChildByType(
    node: Node,
    type: string,
  ): Node | null {
    for (const child of node.children) {
      if (child.type === type) {
        return child;
      }
    }
    return null;
  }

  /**
   * Find all nodes of a specific type
   */
  private findAllByType(
    node: Node,
    type: string,
  ): Node[] {
    const results: Node[] = [];

    const traverse = (n: Node) => {
      if (n.type === type) {
        results.push(n);
      }
      for (const child of n.children) {
        traverse(child);
      }
    };

    traverse(node);
    return results;
  }

  /**
   * Get text content of a node
   */
  private getNodeText(node: Node, content: string): string {
    return content.slice(node.startIndex, node.endIndex);
  }
}

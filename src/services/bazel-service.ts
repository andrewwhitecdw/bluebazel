////////////////////////////////////////////////////////////////////////////////////
// MIT License
//
// Copyright (c) 2021-2026 NVIDIA Corporation
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
////////////////////////////////////////////////////////////////////////////////////
import { BAZEL_BIN, BazelParser } from './bazel-parser';
import { languageMapping as bazelRuleTypeLanguageMapping, sortedBazelRuleTypePrefixes } from './bazel-rule-language-mapping';
import { ConfigurationManager } from './configuration-manager';
import { Console } from './console';
import { findFileRecursive, isNativeBinary } from './platform-utils';
import { ShellService } from './shell-service';
import { WorkspaceService } from './workspace-service';
import { BazelAction, BazelTarget } from '../models/bazel-target';
import * as fs from 'fs';
import * as path from 'path';
import * as tmp from 'tmp';
import * as vscode from 'vscode';


interface BuildFileCacheEntry {
    buildFilePath: string;
    mtimeMs: number;
    targetsBySourceBasename: Map<string, { ruleType: string; targetName: string }[]>;
}

export class BazelService {

    private static buildFileCache = new Map<string, BuildFileCacheEntry>();

    private readonly isBuildTargetRegex = /_library|_proto|_archive|_module|_object|_bundle|_package|_test|_build/;
    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly configurationManager: ConfigurationManager,
        private readonly shellService: ShellService
    ) { }

    /**
     * Best-effort cancellation of whatever command the Bazel server is
     * currently running.  Useful when tearing down debug sessions that
     * may leave orphaned actions inside a Docker container (dazel).
     */
    public async cancelRunningCommand(): Promise<void> {
        const executable = this.configurationManager.getExecutableCommand();
        try {
            await this.shellService.runShellCommand(`${executable} cancel`);
            Console.info('Sent cancel to Bazel server.');
        } catch {
            // Acceptable — no command may be running, or cancel unsupported.
        }
    }

    /**
     * Fetches the list of Bazel actions that require a target.
     */
    public async fetchTargetActions(): Promise<string[]> {
        const actionsRequiringTarget: string[] = [
            'aquery',
            'build',
            'coverage',
            'cquery',
            'mobile-install',
            'print_action',
            'query',
            'run',
            'test'
        ];
        return actionsRequiringTarget;
    }

    /**
     * Converts the provided path into a valid Bazel target path.
     */
    public static formatBazelTargetFromPath(buildPath: string): string {
        const normalized = buildPath.replace(/\\/g, '/');
        const resultSplitted = normalized.split('/');
        resultSplitted.shift(); // Removes bazel-bin
        const targetName = resultSplitted[resultSplitted.length - 1];
        return '//' + resultSplitted.slice(0, resultSplitted.length - 1).join('/') + ':' + targetName;
    }

    public async fetchAllTargetsByAction(cancellationToken?: vscode.CancellationToken, timeoutMs?: number, rootDir?: string): Promise<Map<BazelAction, BazelTarget[]>> {
        // Initialize map entries for each action
        const testTargets: BazelTarget[] = [];
        const map: Map<BazelAction, BazelTarget[]> = new Map([
            ['run', []],
            ['build', []],
            ['test', testTargets],
            ['coverage', testTargets]
        ]);

        try {
            // Fetch all targets
            // Race between the fetch operation and the timeout
            const fetchPromise = this.fetchAllTargets(rootDir, cancellationToken);
            const targets = timeoutMs && timeoutMs !== 0 ? await Promise.race([
                fetchPromise,
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Update targets timed out')), timeoutMs)
                )
            ]) : await fetchPromise;

            // Iterate through fetched targets and categorize them by action
            targets.forEach(item => {
                const target = new BazelTarget(this.context, this, item.label, item.bazelPath, item.buildPath, item.action, item.ruleType);

                // Determine which categories this target belongs to
                if (target.action === 'test') {
                    map.get('test')?.push(target);
                    if (target.ruleType !== 'package_test') {
                        map.get('run')?.push(target); // Tests can also be run
                    }
                    map.get('build')?.push(target); // Tests are built before running
                } else if (target.action === 'run') {
                    map.get('run')?.push(target);
                    map.get('build')?.push(target); // Binaries need to be built
                } else {
                    map.get('build')?.push(target);
                }
            });

        } catch (error) {
            Console.error(`Failed to fetch and categorize targets: ${error}`);
            return Promise.reject(error);
        }

        return map;
    }


    private async runQueriesForTargets(cancellationToken?: vscode.CancellationToken): Promise<{ stdout: string, stderr: string}> {
        try {
            const filter = '"^(?!.*\\.aspect_rules_js|.*node_modules|.*bazel-|.*/\\.).*$"';
            const executable = this.configurationManager.getExecutableCommand();
            const combinedCommand = `
            echo "### Run Targets";
            ${executable} query 'attr("$is_executable", 1, //...)' --output=label_kind --keep_going 2>/dev/null;

            echo "### Test Targets";
            ${executable} query 'filter(${filter}, tests(//...))' --output=label_kind --keep_going 2>/dev/null;

            echo "### Other Targets";
            ${executable} query 'filter(${filter}, //... except attr("$is_executable", 1, //...) except tests(//...))' --output=label_kind --keep_going 2>/dev/null;
            `.trim();
            const data = await this.shellService.runShellCommand(combinedCommand, cancellationToken);
            Console.info('running command', combinedCommand);
            return data;
        } catch (error) {
            Console.error('Error running fetch queries', error);
            return Promise.reject(error);
        }
    }

    /**
     * Fetches available targets for Bazel.
     */
    public async fetchAllTargets(rootDir?: string, cancellationToken?: vscode.CancellationToken): Promise<BazelTarget[]> {
        if (!this.configurationManager.shouldFetchTargetsUsingQuery()) {
            return this.fetchAllTargetsFromBuildFiles('.*', rootDir, true, cancellationToken);
        } else {
            return this.fetchAllTargetsFromQuery(cancellationToken);
        }
    }

    public async fetchAllTargetsFromQuery(cancellationToken?: vscode.CancellationToken): Promise<BazelTarget[]> {
        Console.info('Fetching all targets from bazel...');
        try {

            // Run label_kind and package queries in parallel to save time
            const result = await this.runQueriesForTargets(cancellationToken);
            const sections = result.stdout.split('###').map(section => section.trim()).filter(Boolean);
            const query = {
                runTargets: [] as string[],
                testTargets: [] as string[],
                otherTargets: [] as string[],
            };

            sections.forEach(section => {
                const lines = section.split(/\r?\n/);
                if (lines[0].includes('Run Targets')) {
                    query.runTargets = lines.slice(1); // Skip the header line
                } else if (lines[0].includes('Test Targets')) {
                    query.testTargets = lines.slice(1);
                } else if (lines[0].includes('Other Targets')) {
                    query.otherTargets = lines.slice(1);
                }
            });


            const createTargets = (action: BazelAction, lines: string[]): BazelTarget[] => {
                return lines.filter(line => line.trim() !== '')
                    .map(line => {
                        const [ruleType, , target] = line.split(' ');
                        const [targetPath, targetName] = target.split(':');
                        const buildPath = path.join(BAZEL_BIN, ...targetPath.split('/'), targetName || '');

                        return {
                            label: targetName || targetPath,
                            ruleType: ruleType,
                            bazelPath: target,
                            buildPath: buildPath,
                            action: action,
                        } as BazelTarget;
                    });
            };

            const targets = createTargets('run', query.runTargets);
            const testTargets = createTargets('test', query.testTargets);
            const otherTargets = createTargets('build', query.otherTargets);

            const testPackageLines = new Set(testTargets.map(target => {
                return `package_test package //${target.bazelPath.split(':')}/...`;
            }));

            const otherPackageLines = new Set(otherTargets.map(target => {
                return `package_build package //${target.bazelPath.split(':')}/...`;
            }));

            const testPackages = createTargets('test', Array.from(testPackageLines));
            const otherPackages = createTargets('build', Array.from(otherPackageLines));

            return [...targets,
                ...testTargets,
                ...testPackages,
                ...otherTargets,
                ...otherPackages
            ];
        } catch (error) {
            Console.error('Error fetching run targets:', error);
            return Promise.reject(error);
        }
    }

    public async fetchAllTargetsFromBuildFiles(ruleTypeRegex = '.*',
        rootDir?: string,
        includeOutputPackages = false,
        cancellationToken?: vscode.CancellationToken): Promise<BazelTarget[]> {
        Console.info(`Fetching targets with rule type ${ruleTypeRegex} from Bazel BUILD files...`);

        // Determine the root directory
        const workspaceRoot = WorkspaceService.getInstance().getWorkspaceFolder()?.uri.fsPath;
        rootDir = rootDir || workspaceRoot;

        if (!rootDir) {
            Console.error('No workspace folder found.');
            return Promise.reject(new Error('No workspace folder found.'));
        }

        try {
            const parsedTargets = await BazelParser.parseAllBazelBuildFilesTargets(rootDir, workspaceRoot, ruleTypeRegex, includeOutputPackages, cancellationToken);

            const targets: BazelTarget[] = parsedTargets.map((parsedTarget) => {

                let action = 'build';

                if (parsedTarget.ruleType.includes('_test')) {
                    action = 'test';
                } else if (parsedTarget.ruleType.includes('_binary')) {
                    action = 'run';
                }

                return {
                    label: parsedTarget.name,
                    ruleType: parsedTarget.ruleType,
                    action: action,
                    bazelPath: parsedTarget.bazelPath,
                    buildPath: parsedTarget.buildPath
                } as BazelTarget;
            });

            // Sort the targets alphabetically
            return targets.sort((a, b) => (a.bazelPath < b.bazelPath ? -1 : 1));
        } catch (error) {
            Console.error('Error fetching run targets:', error);
            return Promise.reject(error);
        }
    }

    /**
     * Searches for bash-completion scripts (e.g., for Bazel) in the specified directory.
     */
    private async findBashCompleteScript(startDir: string, _cancellationToken?: vscode.CancellationToken): Promise<string | undefined> {
        const patterns = [/^bash-complete.*\.sh$/, /^bazel-complete.*\.sh$/];

        for (const pattern of patterns) {
            try {
                const found = await findFileRecursive(startDir, pattern);
                if (found) {
                    return found;
                }
            } catch (error) {
                Console.error(`Error finding bash complete script for ${pattern}:`, error);
                return Promise.reject(error);
            }
        }

        return undefined;
    }

    /**
     * Fetches available arguments or configs for a given Bazel action by sourcing bash-completion scripts.
     */
    private async fetchAutocompleteForAction(
        action: BazelAction,
        expandType: 'args' | 'configs',
        cancellationToken?: vscode.CancellationToken
    ): Promise<string[]> {
        try {
            const workspacePath = WorkspaceService.getInstance().getWorkspaceFolder().uri.fsPath;
            const bashCompleteScript = await this.findBashCompleteScript(workspacePath, cancellationToken);

            if (!bashCompleteScript) {
                Console.warn(`Cannot find bash-complete.bash or bazel-complete.bash to receive available ${expandType}.`);
                return [];
            }

            const expandCommand = expandType === 'args'
                ? `_bazel__options_for ${action}`
                : `_bazel__expand_config . ${action}`;

            const data = await this.shellService.runShellCommand(
                `bash -c 'source ${bashCompleteScript} && echo $(${expandCommand})'`,
                cancellationToken
            );
            const result = data.stdout.split(' ');

            // Remove duplicates by converting the result to a set
            return Array.from(new Set(result));
        } catch (error) {
            Console.error(`Error fetching autocomplete for ${action} (${expandType}):`, error);
            return Promise.reject(error);  // Rejecting instead of throwing
        }
    }

    /**
     * Fetches available arguments for a given Bazel action.
     */
    public async fetchArgsForAction(action: BazelAction, cancellationToken: vscode.CancellationToken): Promise<string[]> {
        return this.fetchAutocompleteForAction(action, 'args', cancellationToken);
    }

    /**
     * Fetches available configs for a given Bazel action.
     */
    public async fetchConfigsForAction(action: BazelAction, cancellationToken: vscode.CancellationToken): Promise<string[]> {
        return this.fetchAutocompleteForAction(action, 'configs', cancellationToken);
    }

    public static inferLanguageFromRuleType(ruleType: string): string | undefined {
        if (!ruleType || typeof ruleType !== 'string') {
            Console.warn(`Invalid ruleType: ${ruleType}`);
            return undefined;
        }

        // Normalize the ruleType to lowercase to handle case-insensitive matching
        const normalizedRuleType = ruleType.toLowerCase();

        // Iterate over the sorted prefixes to find the first matching prefix
        for (const prefix of sortedBazelRuleTypePrefixes) {
            if (normalizedRuleType.includes(prefix)) {
                return bazelRuleTypeLanguageMapping.get(prefix);
            }
        }

        // Special cases or rules that don't map directly to a language
        if (normalizedRuleType.includes('package')) {
            return 'starlark';
        } else if (normalizedRuleType.includes('alias')) {
            return 'starlark';
        }

        // Return 'unknown' if no matching language is found
        return 'unknown';
    }

    /**
     * Extracts the Bazel target from a source file path.
     * Dynamically determines the target name by inspecting the BUILD file.
     * @param sourceFilePath - The full path to the test file.
     * @returns The Bazel target as a string, or throws an error if extraction fails.
     */
    public static extractBazelTargetsAssociatedWithSourceFile(sourceFilePath: string): BazelTarget[] {
        // Get the directory of the current file
        const dir = path.dirname(sourceFilePath);

        // Find the Bazel workspace root
        const workspacePath = this.findWorkspaceRoot(dir);
        if (!workspacePath) {
            throw new Error('Could not find Bazel workspace');
        }

        // Compute the relative path to the package within the workspace
        const relativePath = path.relative(workspacePath, dir);
        if (!relativePath) {
            throw new Error('Could not compute relative path');
        }

        // Find the target in the BUILD file
        const targetNames = this.getTargetsFromBuildFileWithSource(dir, sourceFilePath);
        if (!targetNames) {
            throw new Error('Could not find any targets in the BUILD file');
        }

        // Build the full Bazel target
        return targetNames.map((target) => {
            return {
                label: target.targetName,
                ruleType: target.ruleType,
                bazelPath: `//${relativePath}:${target.targetName}`,
                buildPath: path.join(BAZEL_BIN, ...relativePath.split('/'), target.targetName || '')
            } as BazelTarget;
        });
    }

    /**
     * Async variant of extractBazelTargetsAssociatedWithSourceFile().
     * Used by CodeLens to avoid blocking the extension host event loop during file open.
     */
    public static async extractBazelTargetsAssociatedWithSourceFileAsync(sourceFilePath: string): Promise<BazelTarget[]> {
        const dir = path.dirname(sourceFilePath);

        const workspacePath = this.findWorkspaceRoot(dir);
        if (!workspacePath) {
            throw new Error('Could not find Bazel workspace');
        }

        const relativePath = path.relative(workspacePath, dir);
        if (!relativePath) {
            throw new Error('Could not compute relative path');
        }

        const targetNames = await this.getTargetsFromBuildFileWithSourceAsync(dir, sourceFilePath);
        if (!targetNames) {
            throw new Error('Could not find any targets in the BUILD file');
        }

        return targetNames.map((target) => {
            return {
                label: target.targetName,
                ruleType: target.ruleType,
                bazelPath: `//${relativePath}:${target.targetName}`,
                buildPath: path.join(BAZEL_BIN, ...relativePath.split('/'), target.targetName || '')
            } as BazelTarget;
        });
    }

    /**
     * Finds the Bazel workspace root by searching for the `WORKSPACE` file.
     * @param currentDir - The directory to start searching from.
     * @returns The Bazel workspace root path as a string, or null if not found.
     */
    private static findWorkspaceRoot(currentDir: string): string | null {
        let dir = currentDir;

        const workspaceFiles = ['WORKSPACE', 'WORKSPACE.bazel', 'MODULE', 'MODULE.bazel'];
        const forever = true;
        while (forever) {
            for (const name of workspaceFiles) {
                if (fs.existsSync(path.join(dir, name))) {
                    return dir;
                }
            }

            const parentDir = path.dirname(dir);
            if (parentDir === dir) {
                // Reached the root directory
                return null;
            }

            dir = parentDir;
        }
        return null;
    }

    /**
     * Parses the BUILD file in the given directory to find all targets that include the specified file in their sources.
     * Extracts both the Bazel rule type and the target name.
     * @param dir - The directory containing the BUILD file.
     * @param filePath - The full path to the file whose targets we want to find.
     * @returns An array of objects with `ruleType` and `targetName`, or an empty array if no matching targets are found.
     */
    private static getTargetsFromBuildFileWithSource(dir: string, filePath: string): { ruleType: string; targetName: string }[] {
        const buildFileNames = ['BUILD', 'BUILD.bazel'];
        let buildFilePath: string | null = null;

        // Find the BUILD file in the directory
        for (const buildFileName of buildFileNames) {
            const candidatePath = path.join(dir, buildFileName);
            if (fs.existsSync(candidatePath)) {
                buildFilePath = candidatePath;
                break;
            }
        }

        if (!buildFilePath) {
            return []; // No BUILD file found
        }

        // Read the BUILD file content
        const buildFileContent = fs.readFileSync(buildFilePath, 'utf8');
        const fileName = path.basename(filePath);

        // Capture rule type, target name, and `srcs` list content.
        // The lookahead (?!\n\s*\)) prevents matching across rule boundaries
        // (a closing paren on its own line terminates each BUILD rule).
        const regex = new RegExp(
            '(\\w+)\\s*\\(\\s*name\\s*=\\s*"([^"]*)"(?:(?!\\n\\s*\\))[\\s\\S])*?srcs\\s*=\\s*\\[([^\\]]*?)\\]',
            'g'
        );

        const matches: { ruleType: string; targetName: string }[] = [];
        let match;

        while ((match = regex.exec(buildFileContent)) !== null) {
            const ruleType = match[1]; // The type of the Bazel rule (e.g., go_test)
            const targetName = match[2]; // The name of the target
            const srcsContent = match[3]; // The content of the `srcs` attribute

            // Check if the file name is in the `srcs` list
            const srcRegex = new RegExp(`["']${fileName}["']`);
            if (srcRegex.test(srcsContent)) {
                matches.push({ ruleType, targetName });
            }
        }

        return matches; // Return all matching rule types and target names
    }

    private static async getTargetsFromBuildFileWithSourceAsync(dir: string, filePath: string): Promise<{ ruleType: string; targetName: string }[]> {
        const buildFileNames = ['BUILD', 'BUILD.bazel'];
        let buildFilePath: string | null = null;

        for (const buildFileName of buildFileNames) {
            const candidatePath = path.join(dir, buildFileName);
            if (fs.existsSync(candidatePath)) {
                buildFilePath = candidatePath;
                break;
            }
        }

        if (!buildFilePath) {
            return [];
        }

        const fileName = path.basename(filePath);
        const entry = await this.getCachedBuildFileTargets(buildFilePath);
        return entry.get(fileName) || [];
    }

    /**
     * Returns a map of source-basename -> matching targets for a BUILD file,
     * re-reading only when the file's mtime has changed.
     */
    private static async getCachedBuildFileTargets(buildFilePath: string): Promise<Map<string, { ruleType: string; targetName: string }[]>> {
        const stat = await fs.promises.stat(buildFilePath);
        const cached = this.buildFileCache.get(buildFilePath);

        if (cached && cached.mtimeMs === stat.mtimeMs) {
            return cached.targetsBySourceBasename;
        }

        const content = await fs.promises.readFile(buildFilePath, 'utf8');

        const regex = new RegExp(
            '(\\w+)\\s*\\(\\s*name\\s*=\\s*"([^"]*)"(?:(?!\\n\\s*\\))[\\s\\S])*?srcs\\s*=\\s*\\[([^\\]]*?)\\]',
            'g'
        );

        const targetsBySource = new Map<string, { ruleType: string; targetName: string }[]>();
        let match;
        while ((match = regex.exec(content)) !== null) {
            const ruleType = match[1];
            const targetName = match[2];
            const srcsContent = match[3];

            const srcFiles = srcsContent
                .split(',')
                .map(s => s.trim().replace(/["']/g, ''))
                .filter(s => s.length > 0);

            for (const srcFile of srcFiles) {
                const basename = path.basename(srcFile);
                const list = targetsBySource.get(basename) || [];
                list.push({ ruleType, targetName });
                targetsBySource.set(basename, list);
            }
        }

        this.buildFileCache.set(buildFilePath, {
            buildFilePath,
            mtimeMs: stat.mtimeMs,
            targetsBySourceBasename: targetsBySource,
        });

        return targetsBySource;
    }

    /**
     * Resolves the actual executable path for a Bazel target.
     * The static buildPath (bazel-bin/pkg/target) may point to a shell script
     * wrapper rather than the actual ELF binary (e.g. for macro-generated test
     * targets that wrap a shared binary with a gtest filter).
     *
     * Resolution order:
     *  1. If the file at buildPath is already an ELF binary, return it.
     *  2. If it is a shell script, parse it for an `exec <binary>` invocation
     *     and derive the real binary path under bazel-bin/.
     *  3. Fall back to bazel cquery to locate a matching binary/test dep.
     *  4. Return the original buildPath unchanged.
     *
     * @param ruleKindFilter  pipe-separated rule kinds for the cquery fallback
     *                        (default: common native binary/test rules)
     */
    public async getBazelTargetBuildPath(
        target: BazelTarget,
        cancellationToken?: vscode.CancellationToken,
        ruleKindFilter = 'cc_binary|cc_test|go_binary|go_test'
    ): Promise<string> {
        const workspacePath = WorkspaceService.getInstance().getWorkspaceFolder().uri.fsPath;
        const fullPath = path.join(workspacePath, target.buildPath);

        if (isNativeBinary(fullPath)) {
            return target.buildPath;
        }

        // Try to extract the real binary from a wrapper script (fast, no bazel needed)
        const scriptBinary = BazelService.extractBinaryFromScript(fullPath);
        if (scriptBinary) {
            const resolvedPath = path.join(BAZEL_BIN, scriptBinary);
            const resolvedFullPath = path.join(workspacePath, resolvedPath);
            if (isNativeBinary(resolvedFullPath)) {
                Console.info(`Resolved executable from wrapper script: ${resolvedPath}`);
                return resolvedPath;
            }
        }

        // If the file doesn't exist at all (pre-build), skip cquery and use
        // buildPath as-is — cquery may not be available (e.g. dazel environments).
        if (!fs.existsSync(fullPath)) {
            return target.buildPath;
        }

        // Last resort: use cquery to find the actual binary in the dep tree.
        // This is best-effort; failures fall back to buildPath silently.
        Console.info(`File at ${target.buildPath} is not an ELF binary, resolving via cquery...`);
        try {
            const executable = this.configurationManager.getExecutableCommand();
            const configArgs = target.getConfigArgs().toString();
            const command = `${executable} cquery "kind('${ruleKindFilter}', deps(${target.bazelPath}))" --output=files ${configArgs} --compilation_mode=dbg 2>/dev/null`;
            const data = await this.shellService.runShellCommand(command, cancellationToken);
            const resolvedPath = data.stdout.trim().split(/\r?\n/)[0]?.trim();
            if (resolvedPath) {
                Console.info(`Resolved executable path via cquery: ${resolvedPath}`);
                return resolvedPath;
            }
        } catch (error) {
            Console.warn(`Failed to resolve executable path via cquery: ${error}`);
        }

        return target.buildPath;
    }

    /**
     * Reads a shell script and extracts the executable binary path.
     * Bazel macro-generated test wrappers typically end with a line like:
     *   exec path/to/real_binary --gtest_filter=... "$@"
     * or:
     *   VAR=val exec path/to/real_binary ...
     *
     * The method looks for the last `exec` invocation and extracts a bare
     * filesystem path (no variable expansions, no flags).
     */
    private static extractBinaryFromScript(filePath: string): string | undefined {
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            if (!content.startsWith('#!')) {
                return undefined;
            }

            // Match `exec [-c] [-l] [-a name]* <path>`, skipping leading env
            // assignments. Handles the standard exec builtin flags, then captures
            // the first token that looks like a filesystem path.
            const execRegex =
                /\bexec\s+(?:(?:-[cl]\s+)|(?:-a\s+\S+\s+))*(?:["'])?([.\/\w][^\s"']*)/g;

            let candidate: string | undefined;
            let m: RegExpExecArray | null;
            while ((m = execRegex.exec(content)) !== null) {
                const p = m[1];
                // Skip shell variable expansions — we can't resolve them
                if (p.includes('$') || p.includes('`')) continue;
                candidate = p;
            }

            return candidate;
        } catch {
            return undefined;
        }
    }

    public async getRunfilesLocation(target: BazelTarget, cancellationToken?: vscode.CancellationToken): Promise<string> {
        try {
            const executable = this.configurationManager.getExecutableCommand();

            const tmpFile = tmp.fileSync();
            const tmpFilePath = tmpFile.name;

            const command = `${executable} run ${target.bazelPath} --script_path=${tmpFilePath}`;
            await this.shellService.runShellCommand(command, cancellationToken);

            const scriptContent = fs.readFileSync(tmpFilePath, 'utf-8');
            tmpFile.removeCallback();

            const match = scriptContent.match(/cd\s+(.*?\.runfiles)/);
            if (match) {
                return match[1].trim();
            }

            return '';
        } catch (error) {
            Console.error('Error getting runfiles location', error);
            return Promise.reject(error);
        }
    }

}

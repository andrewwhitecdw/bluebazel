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
import { LanguageRegistry } from '../../languages/language-registry';
import { BazelAction, BazelTarget } from '../../models/bazel-target';
import { BazelService } from '../../services/bazel-service';
import { Console } from '../../services/console';
import { ExtensionUtils } from '../../services/extension-utils';
import * as vscode from 'vscode';

enum PatternType {
    Run,
    Test
}
interface Pattern {
    type: PatternType;
    language: string;
    regex: RegExp;
}

export class UnifiedCodeLensProvider implements vscode.CodeLensProvider {

    private readonly regexPatterns: Pattern[];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly bazelService: BazelService
    ) {
        this.regexPatterns = [];
        const languages = LanguageRegistry.getLanguages();
        const testRegexes = languages.map(language => {
            try {
                return {
                    language: language,
                    type: PatternType.Test,
                    regex: LanguageRegistry.getPlugin(language).getCodeLensTestRegex()
                };
            } catch (error) {
                return undefined;
            }
        }).filter(Boolean) as Pattern[];

        const runRegexes = languages.map(language => {
            try {
                return {
                    language: language,
                    type: PatternType.Run,
                    regex: LanguageRegistry.getPlugin(language).getCodeLensRunRegex()
                };
            } catch (error) {
                return undefined;
            }
        }).filter(Boolean) as Pattern[];

        this.regexPatterns.push(...testRegexes);
        this.regexPatterns.push(...runRegexes);
    }

    public async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        if (token.isCancellationRequested) {
            return [];
        }

        // Match the correct regex based on the document's language
        const patterns = this.regexPatterns.filter(pattern => pattern.language === document.languageId);
        const results = await Promise.all(patterns.map(pattern => this.processRegexPattern(document, pattern, token)));
        return results.flat();
    }

    private async processRegexPattern(document: vscode.TextDocument, pattern: Pattern, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        const text = document.getText();
        const language = document.languageId; // Detect the language of the document
        const codeLenses: vscode.CodeLens[] = [];

        const extensionName = ExtensionUtils.getExtensionName(this.context);
        const extensionDisplayName = ExtensionUtils.getExtensionDisplayName(this.context);

        const { regex } = pattern;
        let match;


        let action: BazelAction = 'run';
        if (pattern.type === PatternType.Run) {
            action = 'run';
        } else if (pattern.type === PatternType.Test) {
            action = 'test';
        }

        // IMPORTANT: compute associated targets once per document (not per match),
        // and do it async to avoid blocking the extension host during file open.
        let targets: BazelTarget[] = [];
        try {
            targets = await BazelService.extractBazelTargetsAssociatedWithSourceFileAsync(document.fileName);
        } catch (err) {
            // If the file isn't in a Bazel workspace or BUILD parsing fails, just don't show lenses.
            Console.debug(`Failed to infer targets for ${document.fileName}:`, (err as Error)?.message || err);
            return [];
        }

        if (targets.length === 0) {
            return [];
        }

        while ((match = regex.exec(text)) !== null) {
            if (token.isCancellationRequested) {
                return codeLenses;
            }
            let functionName = '';
            if (language === 'cpp' || language === 'c') {
                if (pattern.type === PatternType.Test) {
                    // C++/C gtest regex captures (FixtureName, TestName) in groups 1 and 2
                    const fixtureName = match[1];
                    const testName = match[2];
                    functionName = `${fixtureName}.${testName}`;
                } else {
                    // Run pattern captures main() in group 1
                    functionName = match[1] || '';
                }
            } else {
                // Use captured function name for other languages
                functionName = match[1] || match[2] || '';
            }
            const line = document.lineAt(document.positionAt(match.index).line);

            Console.info(`Installing code lens provider for ${action} on ${functionName}...`);

            const realTargets = targets.map(target => {
                return new BazelTarget(this.context, this.bazelService, target.label, target.bazelPath, target.buildPath, action, target.ruleType);
            });

            const target = realTargets[0];

            // Modify run arguments for the specific function
            if (pattern.type === PatternType.Test) {
                target.getBazelArgs().add(`--test_filter=${functionName}`);
            }
            codeLenses.push(
                new vscode.CodeLens(line.range, {
                    title: `${extensionName} ${action}`,
                    tooltip: extensionDisplayName,
                    command: `${extensionName}.executeTarget`,
                    arguments: [target],
                })
            );

            const debugTarget = target.clone(true);
            debugTarget.getBazelArgs().add('--compilation_mode=dbg');

            codeLenses.push(
                new vscode.CodeLens(line.range, {
                    title: `${extensionName} debug`,
                    tooltip: extensionDisplayName,
                    command: `${extensionName}.debugTarget`,
                    arguments: [debugTarget],
                })
            );
        }
        return codeLenses;
    }
}

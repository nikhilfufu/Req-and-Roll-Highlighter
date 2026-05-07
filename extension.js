const vscode = require('vscode');
const fs = require('fs');

let paramDecoration, outlineDecoration, stepKwDecoration, featureKwDecoration, unmatchedDecoration;
let stepDefinitions = [];
let stepDefsLoaded = false;  // suppress red lines until first load completes
let statusBarItem;          // shows loading spinner / step count

// Prefix index: first 3 literal words of pattern -> [defs]
let stepIndex = new Map();

// Version cache: docUri -> { version, paramRanges, outlineRanges, stepKwRanges, featureKwRanges }
const decorCache = new Map();

// Debounce timers: docUri -> timeoutId
const debounceTimers = new Map();
const DEBOUNCE_MS = 250;

// Unmatched step tracker for code actions: docUri -> [{range, keyword, stepText}]
const unmatchedStepMap = new Map();

// ─── Pattern helpers ──────────────────────────────────────────────────────────

function patternToRegex(pattern) {
    pattern = pattern
        .replace(/\{int\}/g,            '(-?\\d+)')
        .replace(/\{float\}|\{double\}/g,'(-?\\d*\\.?\\d+)')
        .replace(/\{word\}/g,           '(\\w+)')
        .replace(/\{string\}/g,         '("[^"]*"|\'[^\']*\')')
        .replace(/\{\}/g,               '(.*)');
    const LPAR = '\u0001', RPAR = '\u0002';
    pattern = pattern.replace(/\\\(/g, LPAR).replace(/\\\)/g, RPAR);
    const parts = pattern.split(/(\([^)]*\))/);
    const escaped = parts.map((part, i) => {
        if (i % 2 === 0) {
            return part
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(new RegExp(LPAR, 'g'), '\\(')
                .replace(new RegExp(RPAR, 'g'), '\\)');
        }
        const inner = part.slice(1, -1);
        if (/[.*+?\\[\]|^${}]/.test(inner)) return part;
        return '\\(' + inner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\)';
    });
    return new RegExp('^' + escaped.join('') + '$', 'i');
}

function literalPrefix(pattern) {
    const firstLiteral = pattern.split(/\([^)]*\)/)[0].trim().toLowerCase();
    return firstLiteral.split(/\s+/).slice(0, 3).join(' ');
}

function buildIndex() {
    stepIndex.clear();
    for (const def of stepDefinitions) {
        const key = def.prefix;
        if (!stepIndex.has(key)) stepIndex.set(key, []);
        stepIndex.get(key).push(def);
    }
}

function getCandidates(stepText) {
    const words = stepText.trim().toLowerCase().split(/\s+/);
    const seen = new Set();
    const result = [];
    for (let n = Math.min(3, words.length); n >= 1; n--) {
        const key = words.slice(0, n).join(' ');
        const bucket = stepIndex.get(key);
        if (bucket) { for (const d of bucket) { if (!seen.has(d)) { seen.add(d); result.push(d); } } }
    }
    const emptyBucket = stepIndex.get('');
    if (emptyBucket) { for (const d of emptyBucket) { if (!seen.has(d)) { seen.add(d); result.push(d); } } }
    return result.length > 0 ? result : stepDefinitions;
}

// ─── Step definition loader ───────────────────────────────────────────────────

async function loadStepDefinitions() {
    stepDefsLoaded = false;
    if (statusBarItem) {
        statusBarItem.text = '$(sync~spin) BDD: Indexing steps...';
        statusBarItem.tooltip = 'Scanning C# step definition files';
        statusBarItem.show();
    }
    stepDefinitions = [];
    const files = await vscode.workspace.findFiles('**/Steps/**/*.cs', '**/bin/**');
    const attrRe = /\[\s*(?:Given|When|Then|And|But)\s*\(\s*(@?)"((?:[^"\\]|\\.)*)"\s*\)/g;
    for (const file of files) {
        try {
            const content = fs.readFileSync(file.fsPath, 'utf8');
            attrRe.lastIndex = 0;
            let m;
            while ((m = attrRe.exec(content)) !== null) {
                try {
                    const isVerbatim = m[1] === '@';
                    const rawPattern = isVerbatim ? m[2] : m[2].replace(/\\(.)/g, '$1');
                    const lineNum = content.slice(0, m.index).split('\n').length - 1;
                    const prefix = literalPrefix(rawPattern);
                    stepDefinitions.push({ regex: patternToRegex(rawPattern), prefix, file, line: lineNum });
                } catch (_) {}
            }
        } catch (_) {}
    }
    buildIndex();
    decorCache.clear();
    unmatchedStepMap.clear();
    stepDefsLoaded = true;
    if (statusBarItem) {
        statusBarItem.text = `$(check) BDD: ${stepDefinitions.length} steps`;
        statusBarItem.tooltip = `${stepDefinitions.length} step definitions indexed from C# files`;
    }
    vscode.window.visibleTextEditors.forEach(decorateEditor);
}

// ─── Decoration computation ───────────────────────────────────────────────────

function computeDecorations(doc) {
    const paramRanges = [], outlineRanges = [], stepKwRanges = [],
          featureKwRanges = [], unmatchedRanges = [];
    const unmatchedSteps = [];   // [{range, keyword, stepText}]

    const stepKwRe    = /^(\s*)(Given|When|Then|And|But)(\s+)/i;
    const featureKwRe = /^(\s*)(Feature:|Scenario Outline:|Scenario:|Background:|Examples:|Rule:)/i;
    const outlineRe   = /<([^>]+)>/g;

    for (let ln = 0; ln < doc.lineCount; ln++) {
        const lineText = doc.lineAt(ln).text;
        const fk = lineText.match(featureKwRe);
        if (fk) featureKwRanges.push(new vscode.Range(ln, fk[1].length, ln, fk[1].length + fk[2].length));
        const sk = lineText.match(stepKwRe);
        if (!sk) continue;
        const stepStart = sk[0].length;
        stepKwRanges.push(new vscode.Range(ln, sk[1].length, ln, sk[1].length + sk[2].length));
        const stepText = lineText.slice(stepStart).trim();
        outlineRe.lastIndex = 0;
        let om;
        while ((om = outlineRe.exec(lineText)) !== null) {
            outlineRanges.push(new vscode.Range(ln, om.index, ln, om.index + om[0].length));
        }
        const candidates = getCandidates(stepText);
        let bestMatch = null, bestCapLen = Infinity;
        for (const def of candidates) {
            const m = stepText.match(def.regex);
            if (!m) continue;
            const capLen = m.slice(1).reduce((sum, g) => sum + (g ? g.length : 0), 0);
            if (capLen < bestCapLen) { bestCapLen = capLen; bestMatch = m; }
        }
        if (bestMatch) {
            let searchFrom = stepStart;
            for (let g = 1; g < bestMatch.length; g++) {
                if (!bestMatch[g]) continue;
                const val = bestMatch[g];
                const idx = lineText.indexOf(val, searchFrom);
                if (/^<[^>]+>$/.test(val)) { searchFrom = idx + val.length; continue; }
                if (idx >= 0) { paramRanges.push(new vscode.Range(ln, idx, ln, idx + val.length)); searchFrom = idx + val.length; }
            }
        } else if (stepDefsLoaded) {
            const endCol = lineText.trimEnd().length;
            const range = new vscode.Range(ln, stepStart, ln, endCol);
            unmatchedRanges.push(range);
            unmatchedSteps.push({ range, keyword: sk[2], stepText });
        }
    }
    return { paramRanges, outlineRanges, stepKwRanges, featureKwRanges, unmatchedRanges, unmatchedSteps };
}

function decorateEditor(editor) {
    if (!editor || !editor.document.fileName.endsWith('.feature')) return;
    const doc = editor.document;
    const key = doc.uri.toString();
    const cached = decorCache.get(key);
    if (cached && cached.version === doc.version) {
        editor.setDecorations(paramDecoration,     cached.paramRanges);
        editor.setDecorations(outlineDecoration,   cached.outlineRanges);
        editor.setDecorations(stepKwDecoration,    cached.stepKwRanges);
        editor.setDecorations(featureKwDecoration, cached.featureKwRanges);
        editor.setDecorations(unmatchedDecoration, cached.unmatchedRanges);
        return;
    }
    const result = computeDecorations(doc);
    decorCache.set(key, { version: doc.version, ...result });
    unmatchedStepMap.set(key, result.unmatchedSteps);
    editor.setDecorations(paramDecoration,     result.paramRanges);
    editor.setDecorations(outlineDecoration,   result.outlineRanges);
    editor.setDecorations(stepKwDecoration,    result.stepKwRanges);
    editor.setDecorations(featureKwDecoration, result.featureKwRanges);
    editor.setDecorations(unmatchedDecoration, result.unmatchedRanges);
}

function scheduleDecorate(editor) {
    if (!editor || !editor.document.fileName.endsWith('.feature')) return;
    const key = editor.document.uri.toString();
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.set(key, setTimeout(() => { debounceTimers.delete(key); decorateEditor(editor); }, DEBOUNCE_MS));
}

// ─── Snippet generator ────────────────────────────────────────────────────────

/**
 * Converts a plain-English step text into a C# Reqnroll step definition snippet.
 *
 * Detection order (first match wins per token):
 *   "quoted string"   → {string}  → string paramN
 *   decimal number    → {double}  → double paramN
 *   integer           → {int}     → int    paramN
 *
 * The keyword (Given/When/Then/And/But) is normalised to Given/When/Then for
 * the C# attribute (And/But are ambiguous, so we default to Given).
 */
function generateStepSnippet(keyword, stepText) {
    const kwMap = { given: 'Given', when: 'When', then: 'Then', and: 'Given', but: 'Given' };
    const attr = kwMap[keyword.toLowerCase()] || 'Given';

    const params = [];
    let idx = 0;

    // Replace in a single pass to keep parameter order stable
    const pattern = stepText
        .replace(/"[^"]*"/g, () => {
            params.push({ type: 'string', name: `p${++idx}` });
            return '{string}';
        })
        .replace(/\b-?\d+\.\d+\b/g, () => {
            params.push({ type: 'double', name: `p${++idx}` });
            return '{double}';
        })
        .replace(/\b-?\d+\b/g, () => {
            params.push({ type: 'int', name: `p${++idx}` });
            return '{int}';
        });

    // Build a PascalCase method name from the first 6 non-param words
    const methodName = pattern
        .replace(/\{[^}]+\}/g, '')          // strip param placeholders
        .replace(/[^a-zA-Z0-9 ]/g, ' ')     // strip punctuation
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 6)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join('') || 'StepDefinition';

    const csParams = params.map(p => `${p.type} ${p.name}`).join(', ');

    const lines = [
        `[${attr}(@"${pattern}")]`,
        `public void ${methodName}(${csParams})`,
        `{`,
        `    // TODO: implement step`,
        `    throw new PendingStepException();`,
        `}`,
    ];
    return lines.join('\n');
}

// ─── Code action provider ─────────────────────────────────────────────────────

const SNIPPET_ACTION_KIND = vscode.CodeActionKind.QuickFix;

const snippetCodeActionProvider = {
    provideCodeActions(document, range) {
        if (!document.fileName.endsWith('.feature')) return [];
        if (!stepDefsLoaded) return [];

        const key = document.uri.toString();
        const unmatched = unmatchedStepMap.get(key) || [];
        const actions = [];

        for (const entry of unmatched) {
            // Fire when the cursor / selection overlaps an unmatched step range
            if (!entry.range.intersection(range)) continue;

            const snippet = generateStepSnippet(entry.keyword, entry.stepText);

            // ── Action 1: Copy snippet to clipboard ──────────────────────────
            const copyAction = new vscode.CodeAction(
                `$(clippy) Copy step definition snippet`,
                SNIPPET_ACTION_KIND
            );
            copyAction.command = {
                command: 'bdd.copyStepSnippet',
                title: 'Copy step definition snippet',
                arguments: [snippet, entry.keyword, entry.stepText],
            };
            copyAction.isPreferred = true;
            copyAction.diagnostics = [];
            actions.push(copyAction);

            // ── Action 2: Insert snippet into a step-definitions file ────────
            const insertAction = new vscode.CodeAction(
                `$(new-file) Insert step definition into Steps file`,
                SNIPPET_ACTION_KIND
            );
            insertAction.command = {
                command: 'bdd.insertStepSnippet',
                title: 'Insert step definition into Steps file',
                arguments: [snippet, entry.keyword, entry.stepText],
            };
            actions.push(insertAction);

            // Only generate one action set per cursor position
            break;
        }
        return actions;
    }
};

// ─── Command: copy snippet to clipboard ──────────────────────────────────────

async function cmdCopyStepSnippet(snippet, keyword, stepText) {
    await vscode.env.clipboard.writeText(snippet);
    vscode.window.showInformationMessage(
        `Step definition snippet copied to clipboard!`,
        { detail: `Paste it into your C# Steps class.` }
    );
}

// ─── Command: pick a .cs Steps file and insert the snippet ───────────────────

async function cmdInsertStepSnippet(snippet, keyword, stepText) {
    // Find candidate step definition files
    const files = await vscode.workspace.findFiles('**/Steps/**/*.cs', '**/bin/**');

    if (files.length === 0) {
        vscode.window.showWarningMessage(
            'No C# step definition files found under **/Steps/**/*.cs'
        );
        return;
    }

    // Build quick-pick items (relative paths for readability)
    const items = files.map(f => ({
        label: vscode.workspace.asRelativePath(f),
        uri: f,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Steps .cs file to insert the snippet into',
        matchOnDetail: true,
    });
    if (!picked) return;

    const doc = await vscode.workspace.openTextDocument(picked.uri);
    const editor = await vscode.window.showTextDocument(doc);

    // Find the last closing brace of a class — insert just before it
    const text = doc.getText();
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace < 0) {
        vscode.window.showErrorMessage('Could not find a suitable insertion point in the file.');
        return;
    }

    // Determine indentation from file (2 or 4 spaces, or tab)
    const indentMatch = text.match(/^(\s+)\[(?:Given|When|Then)/m);
    const indent = indentMatch ? indentMatch[1] : '    ';

    const indentedSnippet = '\n' + snippet
        .split('\n')
        .map(l => (l.trim() === '' ? '' : indent + l))
        .join('\n') + '\n';

    await editor.edit(editBuilder => {
        const insertPos = doc.positionAt(lastBrace);
        editBuilder.insert(insertPos, indentedSnippet);
    });

    // Move cursor to the TODO line so the developer sees it immediately
    const newText = editor.document.getText();
    const todoIdx = newText.lastIndexOf('// TODO: implement step');
    if (todoIdx >= 0) {
        const pos = editor.document.positionAt(todoIdx);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    }

    vscode.window.showInformationMessage(`Step definition inserted into ${picked.label}`);
}

// ─── Go-to-definition provider ────────────────────────────────────────────────

const definitionProvider = {
    provideDefinition(document, position) {
        const lineText = document.lineAt(position.line).text;
        const kw = lineText.match(/^(\s*)(Given|When|Then|And|But)\s+/i);
        if (!kw) return null;
        const stepText = lineText.slice(kw[0].length).trim();
        const candidates = getCandidates(stepText);
        let bestDef = null, bestCapLen = Infinity;
        for (const def of candidates) {
            const m = stepText.match(def.regex);
            if (!m) continue;
            const capLen = m.slice(1).reduce((sum, g) => sum + (g ? g.length : 0), 0);
            if (capLen < bestCapLen) { bestCapLen = capLen; bestDef = def; }
        }
        return bestDef ? new vscode.Location(bestDef.file, new vscode.Position(bestDef.line, 0)) : null;
    }
};

// ─── Activation ───────────────────────────────────────────────────────────────

function activate(context) {
    paramDecoration     = vscode.window.createTextEditorDecorationType({ color: '#CE9178', fontWeight: 'bold' });
    outlineDecoration   = vscode.window.createTextEditorDecorationType({ color: '#FF69B4', fontWeight: 'bold' });
    stepKwDecoration    = vscode.window.createTextEditorDecorationType({ color: '#569CD6', fontWeight: 'bold' });
    featureKwDecoration = vscode.window.createTextEditorDecorationType({ color: '#C586C0', fontWeight: 'bold' });
    unmatchedDecoration = vscode.window.createTextEditorDecorationType({
    color: '#C586C0',
    fontWeight: 'bold',
    textDecoration: 'underline wavy #C586C0',
    });

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(sync~spin) BDD: Indexing steps...';
    statusBarItem.tooltip = 'BDD Parameter Colorizer is scanning step definitions';
    statusBarItem.show();

    loadStepDefinitions();

    const watcher = vscode.workspace.createFileSystemWatcher('**/Steps/**/*.cs');
    watcher.onDidChange(loadStepDefinitions);
    watcher.onDidCreate(loadStepDefinitions);
    watcher.onDidDelete(loadStepDefinitions);

    const featureSelector = [
        { language: 'feature' },
        { language: 'gherkin' },
        { scheme: 'file', pattern: '**/*.feature' },
    ];

    context.subscriptions.push(
        watcher,
        statusBarItem,
        paramDecoration, outlineDecoration, stepKwDecoration, featureKwDecoration, unmatchedDecoration,

        // Go-to-definition
        vscode.languages.registerDefinitionProvider({ language: 'feature' }, definitionProvider),
        vscode.languages.registerDefinitionProvider({ language: 'gherkin' }, definitionProvider),
        vscode.languages.registerDefinitionProvider({ scheme: 'file', pattern: '**/*.feature' }, definitionProvider),

        // Snippet quick-fix lightbulb
        vscode.languages.registerCodeActionsProvider(featureSelector, snippetCodeActionProvider, {
            providedCodeActionKinds: [SNIPPET_ACTION_KIND],
        }),

        // Commands wired to the code actions
        vscode.commands.registerCommand('bdd.copyStepSnippet',   cmdCopyStepSnippet),
        vscode.commands.registerCommand('bdd.insertStepSnippet', cmdInsertStepSnippet),

        // Editor events
        vscode.window.onDidChangeActiveTextEditor(decorateEditor),
        vscode.workspace.onDidChangeTextDocument(evt => {
            const ed = vscode.window.activeTextEditor;
            if (ed && ed.document === evt.document) scheduleDecorate(ed);
        })
    );

    if (vscode.window.activeTextEditor) decorateEditor(vscode.window.activeTextEditor);
}

function deactivate() {}
module.exports = { activate, deactivate };
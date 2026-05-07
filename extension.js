const vscode = require('vscode');
const fs = require('fs');

let paramDecoration, outlineDecoration, stepKwDecoration, featureKwDecoration,
    unmatchedDecoration, ambiguousDecoration;
let stepDefinitions = [];
let stepDefsLoaded = false;
let statusBarItem;

// Prefix index: first 3 literal words of pattern -> [defs]
let stepIndex = new Map();

// Version cache: docUri -> { version, ...ranges }
const decorCache = new Map();

// Debounce timers: docUri -> timeoutId
const debounceTimers = new Map();
const DEBOUNCE_MS = 250;

// Unmatched step tracker:   docUri -> [{range, keyword, resolvedKeyword, stepText}]
const unmatchedStepMap = new Map();

// Ambiguous step tracker:   docUri -> [{range, keyword, stepText, matchingDefs[]}]
const ambiguousStepMap = new Map();

// ─── Pattern helpers ──────────────────────────────────────────────────────────

function patternToRegex(pattern) {
    pattern = pattern
        .replace(/\{int\}/g,              '(-?\\d+)')
        .replace(/\{float\}|\{double\}/g, '(-?\\d*\\.?\\d+)')
        .replace(/\{word\}/g,             '(\\w+)')
        .replace(/\{string\}/g,           '("[^"]*"|\'[^\']*\')')
        .replace(/\{\}/g,                 '(.*)');
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
        if (bucket) {
            for (const d of bucket) {
                if (!seen.has(d)) { seen.add(d); result.push(d); }
            }
        }
    }
    const emptyBucket = stepIndex.get('');
    if (emptyBucket) {
        for (const d of emptyBucket) {
            if (!seen.has(d)) { seen.add(d); result.push(d); }
        }
    }
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

    for (const file of files) {
        try {
            const content = fs.readFileSync(file.fsPath, 'utf8');

            // m[1] = keyword (Given|When|Then|And|But)
            // m[2] = verbatim flag (@ or empty string)
            // m[3] = raw pattern string
            const attrRe = /\[\s*(Given|When|Then|And|But)\s*\(\s*(@?)"((?:[^"\\]|\\.)*)"\s*\)\s*\]/g;

            let m;
            while ((m = attrRe.exec(content)) !== null) {
                try {
                    const defKeyword = m[1].toLowerCase();
                    const isVerbatim = m[2] === '@';
                    const rawPattern = isVerbatim
                        ? m[3]
                        : m[3].replace(/\\(.)/g, '$1');
                    const lineNum = content.slice(0, m.index).split('\n').length - 1;
                    const prefix  = literalPrefix(rawPattern);
                    stepDefinitions.push({
                        regex: patternToRegex(rawPattern),
                        rawPattern,
                        prefix,
                        defKeyword,
                        file,
                        line: lineNum,
                    });
                } catch (_) {}
            }
        } catch (_) {}
    }

    buildIndex();
    decorCache.clear();
    unmatchedStepMap.clear();
    ambiguousStepMap.clear();
    stepDefsLoaded = true;
    if (statusBarItem) {
        statusBarItem.text = `$(check) BDD: ${stepDefinitions.length} steps`;
        statusBarItem.tooltip = `${stepDefinitions.length} step definitions indexed from C# files`;
    }
    vscode.window.visibleTextEditors.forEach(decorateEditor);
}

// ─── Keyword compatibility map ────────────────────────────────────────────────

// Strict keyword matching - only exact matches allowed
// And/But are context-neutral so they match any def keyword
const KW_COMPAT = {
    given: new Set(['given']),
    when:  new Set(['when']),
    then:  new Set(['then']),
    and:   new Set(['given', 'when', 'then', 'and', 'but']),
    but:   new Set(['given', 'when', 'then', 'and', 'but']),
};

// ─── Resolve "And"/"But" keyword from context ─────────────────────────────────
// Walks back up the document to find the last Given/When/Then keyword
// so that snippets generated for And/But steps use the correct C# attribute.
function resolveKeywordFromContext(doc, lineIndex) {
    for (let i = lineIndex - 1; i >= 0; i--) {
        const text = doc.lineAt(i).text;
        const m = text.match(/^\s*(Given|When|Then)\s+/i);
        if (m) return m[1].toLowerCase();
        // Stop searching at scenario/feature boundaries
        if (/^\s*(Scenario|Feature|Background|Rule)/i.test(text)) break;
    }
    return 'given'; // safe fallback
}

// ─── Decoration computation ───────────────────────────────────────────────────

function computeDecorations(doc) {
    const paramRanges     = [];
    const outlineRanges   = [];
    const stepKwRanges    = [];
    const featureKwRanges = [];
    const unmatchedRanges = [];
    const ambiguousRanges = [];
    const unmatchedSteps  = [];
    const ambiguousSteps  = [];

    const stepKwRe    = /^(\s*)(Given|When|Then|And|But)(\s+)/i;
    const featureKwRe = /^(\s*)(Feature:|Scenario Outline:|Scenario:|Background:|Examples:|Rule:)/i;
    const outlineRe   = /<([^>]+)>/g;

    for (let ln = 0; ln < doc.lineCount; ln++) {
        const lineText = doc.lineAt(ln).text;

        const fk = lineText.match(featureKwRe);
        if (fk) {
            featureKwRanges.push(new vscode.Range(ln, fk[1].length, ln, fk[1].length + fk[2].length));
        }

        const sk = lineText.match(stepKwRe);
        if (!sk) continue;

        const stepStart  = sk[0].length;
        const stepKw     = sk[2].toLowerCase();
        const compatSet  = KW_COMPAT[stepKw] || new Set([stepKw]);

        stepKwRanges.push(new vscode.Range(ln, sk[1].length, ln, sk[1].length + sk[2].length));

        const stepText = lineText.slice(stepStart).trim();

        outlineRe.lastIndex = 0;
        let om;
        while ((om = outlineRe.exec(lineText)) !== null) {
            outlineRanges.push(new vscode.Range(ln, om.index, ln, om.index + om[0].length));
        }

        // ── Resolve effective keyword for And/But (used in snippet generation) ──
        const resolvedKeyword = (stepKw === 'and' || stepKw === 'but')
            ? resolveKeywordFromContext(doc, ln)
            : stepKw;

        // ── Collect definitions that match the text AND have a compatible keyword ──
        const candidates = getCandidates(stepText);
        const allMatches = [];

        for (const def of candidates) {
            if (!compatSet.has(def.defKeyword)) continue;
            const match = stepText.match(def.regex);
            if (!match) continue;
            const capLen = match.slice(1).reduce((sum, g) => sum + (g ? g.length : 0), 0);
            allMatches.push({ def, match, capLen });
        }

        const endCol = lineText.trimEnd().length;
        const range  = new vscode.Range(ln, stepStart, ln, endCol);

        if (allMatches.length === 0) {
            // ── No compatible definition found → purple unmatched ─────────
            if (stepDefsLoaded) {
                unmatchedRanges.push(range);
                // FIX: store resolvedKeyword so snippet uses correct attribute
                unmatchedSteps.push({ range, keyword: sk[2], resolvedKeyword, stepText });
            }

        } else if (allMatches.length > 1) {
            // ── More than one compatible definition matches → orange ambiguous ──
            // FIX: always flag as ambiguous; never silently pick one
            ambiguousRanges.push(range);
            ambiguousSteps.push({
                range,
                keyword: sk[2],
                stepText,
                matchingDefs: allMatches.map(({ def }) => def),
            });

            // Still highlight params using best (lowest capLen) match so the
            // file doesn't look completely broken while the developer resolves it
            const best = allMatches.reduce((a, b) => a.capLen <= b.capLen ? a : b);
            let searchFrom = stepStart;
            for (let g = 1; g < best.match.length; g++) {
                if (!best.match[g]) continue;
                const val = best.match[g];
                const idx = lineText.indexOf(val, searchFrom);
                if (/^<[^>]+>$/.test(val)) { searchFrom = idx + val.length; continue; }
                if (idx >= 0) {
                    paramRanges.push(new vscode.Range(ln, idx, ln, idx + val.length));
                    searchFrom = idx + val.length;
                }
            }

        } else {
            // ── Exactly one compatible match → highlight params ───────────
            const { match: bestMatch } = allMatches[0];
            let searchFrom = stepStart;
            for (let g = 1; g < bestMatch.length; g++) {
                if (!bestMatch[g]) continue;
                const val = bestMatch[g];
                const idx = lineText.indexOf(val, searchFrom);
                if (/^<[^>]+>$/.test(val)) { searchFrom = idx + val.length; continue; }
                if (idx >= 0) {
                    paramRanges.push(new vscode.Range(ln, idx, ln, idx + val.length));
                    searchFrom = idx + val.length;
                }
            }
        }
    }

    return {
        paramRanges, outlineRanges, stepKwRanges, featureKwRanges,
        unmatchedRanges, unmatchedSteps,
        ambiguousRanges, ambiguousSteps,
    };
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
        editor.setDecorations(ambiguousDecoration, cached.ambiguousRanges);
        return;
    }
    const result = computeDecorations(doc);
    decorCache.set(key, { version: doc.version, ...result });
    unmatchedStepMap.set(key, result.unmatchedSteps);
    ambiguousStepMap.set(key, result.ambiguousSteps);
    editor.setDecorations(paramDecoration,     result.paramRanges);
    editor.setDecorations(outlineDecoration,   result.outlineRanges);
    editor.setDecorations(stepKwDecoration,    result.stepKwRanges);
    editor.setDecorations(featureKwDecoration, result.featureKwRanges);
    editor.setDecorations(unmatchedDecoration, result.unmatchedRanges);
    editor.setDecorations(ambiguousDecoration, result.ambiguousRanges);
}

function scheduleDecorate(editor) {
    if (!editor || !editor.document.fileName.endsWith('.feature')) return;
    const key = editor.document.uri.toString();
    const existing = debounceTimers.get(key);
    if (existing) clearTimeout(existing);
    debounceTimers.set(key, setTimeout(() => {
        debounceTimers.delete(key);
        decorateEditor(editor);
    }, DEBOUNCE_MS));
}

// ─── Snippet generator ────────────────────────────────────────────────────────

// FIX: uses resolvedKeyword directly — no more kwMap that clobbers And/But to Given
function generateStepSnippet(resolvedKeyword, stepText) {
    const attr = resolvedKeyword.charAt(0).toUpperCase() + resolvedKeyword.slice(1);
    const params = [];
    let idx = 0;

    const pattern = stepText
        .replace(/"[^"]*"/g,          () => { params.push({ type: 'string', name: `p${++idx}` }); return '{string}'; })
        .replace(/\b-?\d+\.\d+\b/g,   () => { params.push({ type: 'double', name: `p${++idx}` }); return '{double}'; })
        .replace(/\b-?\d+\b/g,        () => { params.push({ type: 'int',    name: `p${++idx}` }); return '{int}'; });

    const methodName = pattern
        .replace(/\{[^}]+\}/g, '').replace(/[^a-zA-Z0-9 ]/g, ' ').trim()
        .split(/\s+/).filter(Boolean).slice(0, 6)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join('') || 'StepDefinition';

    const csParams = params.map(p => `${p.type} ${p.name}`).join(', ');
    return [
        `[${attr}(@"${pattern}")]`,
        `public void ${methodName}(${csParams})`,
        `{`,
        `    // TODO: implement step`,
        `    throw new PendingStepException();`,
        `}`,
    ].join('\n');
}

// ─── Code action provider ─────────────────────────────────────────────────────

const SNIPPET_ACTION_KIND = vscode.CodeActionKind.QuickFix;

const snippetCodeActionProvider = {
    provideCodeActions(document, range) {
        if (!document.fileName.endsWith('.feature')) return [];
        if (!stepDefsLoaded) return [];

        const key     = document.uri.toString();
        const actions = [];

        // ── Ambiguous steps: show conflict navigator ───────────────────────
        for (const entry of (ambiguousStepMap.get(key) || [])) {
            if (!entry.range.intersection(range)) continue;
            const showAction = new vscode.CodeAction(
                `$(warning) Ambiguous — ${entry.matchingDefs.length} definitions match this step`,
                SNIPPET_ACTION_KIND
            );
            showAction.command = {
                command: 'bdd.showAmbiguousMatches',
                title: 'Show all matching step definitions',
                arguments: [entry.matchingDefs, entry.stepText],
            };
            showAction.isPreferred = true;
            actions.push(showAction);
            break;
        }

        // ── Unmatched steps: offer snippet generation ──────────────────────
        for (const entry of (unmatchedStepMap.get(key) || [])) {
            if (!entry.range.intersection(range)) continue;

            // FIX: pass resolvedKeyword so And/But steps get [When(...)]/[Then(...)] etc.
            const snippet = generateStepSnippet(entry.resolvedKeyword, entry.stepText);

            const copyAction = new vscode.CodeAction(
                `$(clippy) Copy step definition snippet`,
                SNIPPET_ACTION_KIND
            );
            copyAction.command = {
                command: 'bdd.copyStepSnippet',
                title: 'Copy step definition snippet',
                arguments: [snippet],
            };
            copyAction.isPreferred = true;
            actions.push(copyAction);

            const insertAction = new vscode.CodeAction(
                `$(new-file) Insert step definition into Steps file`,
                SNIPPET_ACTION_KIND
            );
            insertAction.command = {
                command: 'bdd.insertStepSnippet',
                title: 'Insert step definition into Steps file',
                arguments: [snippet],
            };
            actions.push(insertAction);
            break;
        }

        return actions;
    }
};

// ─── Command: navigate ambiguous matches ──────────────────────────────────────

async function cmdShowAmbiguousMatches(matchingDefs, stepText) {
    const items = matchingDefs.map(def => ({
        label:       `$(go-to-file) ${vscode.workspace.asRelativePath(def.file)}`,
        description: `Line ${def.line + 1}`,
        detail:      `Pattern: ${def.rawPattern}`,
        def,
    }));

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: `⚠ Ambiguous: "${stepText}" matches ${matchingDefs.length} definitions — select one to navigate`,
        matchOnDetail:      true,
        matchOnDescription: true,
    });
    if (!picked) return;

    const doc    = await vscode.workspace.openTextDocument(picked.def.file);
    const editor = await vscode.window.showTextDocument(doc);
    const pos    = new vscode.Position(picked.def.line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}

// ─── Command: copy snippet ────────────────────────────────────────────────────

async function cmdCopyStepSnippet(snippet) {
    await vscode.env.clipboard.writeText(snippet);
    vscode.window.showInformationMessage('Step definition snippet copied to clipboard!');
}

// ─── Command: insert snippet into a Steps .cs file ───────────────────────────

async function cmdInsertStepSnippet(snippet) {
    const files = await vscode.workspace.findFiles('**/Steps/**/*.cs', '**/bin/**');
    if (files.length === 0) {
        vscode.window.showWarningMessage('No C# step definition files found under **/Steps/**/*.cs');
        return;
    }

    const items  = files.map(f => ({ label: vscode.workspace.asRelativePath(f), uri: f }));
    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a Steps .cs file to insert the snippet into',
    });
    if (!picked) return;

    const doc    = await vscode.workspace.openTextDocument(picked.uri);
    const editor = await vscode.window.showTextDocument(doc);
    const text   = doc.getText();
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace < 0) {
        vscode.window.showErrorMessage('Could not find a suitable insertion point in the file.');
        return;
    }

    const indentMatch     = text.match(/^(\s+)\[(?:Given|When|Then)/m);
    const indent          = indentMatch ? indentMatch[1] : '    ';
    const indentedSnippet = '\n' + snippet.split('\n').map(l => (l.trim() === '' ? '' : indent + l)).join('\n') + '\n';

    await editor.edit(eb => eb.insert(doc.positionAt(lastBrace), indentedSnippet));

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

        const stepText  = lineText.slice(kw[0].length).trim();
        const stepKw    = kw[2].toLowerCase();
        const compatSet = KW_COMPAT[stepKw] || new Set([stepKw]);

        const candidates = getCandidates(stepText);
        let bestDef = null, bestCapLen = Infinity;

        for (const def of candidates) {
            if (!compatSet.has(def.defKeyword)) continue;
            const m = stepText.match(def.regex);
            if (!m) continue;
            const capLen = m.slice(1).reduce((sum, g) => sum + (g ? g.length : 0), 0);
            if (capLen < bestCapLen) { bestCapLen = capLen; bestDef = def; }
        }

        return bestDef
            ? new vscode.Location(bestDef.file, new vscode.Position(bestDef.line, 0))
            : null;
    }
};

// ─── Activation ───────────────────────────────────────────────────────────────

function activate(context) {
    paramDecoration     = vscode.window.createTextEditorDecorationType({ color: '#CE9178', fontWeight: 'bold' });
    outlineDecoration   = vscode.window.createTextEditorDecorationType({ color: '#4EC994', fontWeight: 'bold' });
    stepKwDecoration    = vscode.window.createTextEditorDecorationType({ color: '#569CD6', fontWeight: 'bold' });
    featureKwDecoration = vscode.window.createTextEditorDecorationType({ color: '#C586C0', fontWeight: 'bold' });

    // Purple wavy underline = no matching definition
    unmatchedDecoration = vscode.window.createTextEditorDecorationType({
        color: '#C586C0',
        fontWeight: 'bold',
        textDecoration: 'underline wavy #C586C0',
    });

    // Orange wavy underline = multiple definitions match (ambiguous)
    ambiguousDecoration = vscode.window.createTextEditorDecorationType({
        color: '#FF8C00',
        fontWeight: 'bold',
        textDecoration: 'underline wavy #FF8C00',
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
        paramDecoration, outlineDecoration, stepKwDecoration,
        featureKwDecoration, unmatchedDecoration, ambiguousDecoration,

        vscode.languages.registerDefinitionProvider({ language: 'feature' }, definitionProvider),
        vscode.languages.registerDefinitionProvider({ language: 'gherkin' }, definitionProvider),
        vscode.languages.registerDefinitionProvider({ scheme: 'file', pattern: '**/*.feature' }, definitionProvider),

        vscode.languages.registerCodeActionsProvider(featureSelector, snippetCodeActionProvider, {
            providedCodeActionKinds: [SNIPPET_ACTION_KIND],
        }),

        vscode.commands.registerCommand('bdd.copyStepSnippet',      cmdCopyStepSnippet),
        vscode.commands.registerCommand('bdd.insertStepSnippet',    cmdInsertStepSnippet),
        vscode.commands.registerCommand('bdd.showAmbiguousMatches', cmdShowAmbiguousMatches),

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
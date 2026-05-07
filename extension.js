const vscode = require('vscode');
const fs = require('fs');

let paramDecoration, outlineDecoration, stepKwDecoration, featureKwDecoration,
    unmatchedDecoration, ambiguousDecoration;
let stepDefinitions = [];
let stepDefsLoaded = false;
let statusBarItem;

let stepIndex = new Map();
const decorCache = new Map();
const debounceTimers = new Map();
const DEBOUNCE_MS = 250;

const unmatchedStepMap = new Map();
const ambiguousStepMap = new Map();

const STEP_PREFERENCES = {
    'action': ['when', 'given', 'then'],
    'verification': ['then', 'when', 'given'],
    'default': ['when', 'then', 'given']
};

// ─── Pattern helpers ──────────────────────────────────────────────────────────

function patternToRegex(pattern) {
    pattern = pattern
        .replace(/\{int\}/g, '(-?\\d+)')
        .replace(/\{float\}|\{double\}/g, '(-?\\d*\\.?\\d+)')
        .replace(/\{word\}/g, '(\\w+)')
        .replace(/\{string\}/g, '("[^"]*"|\'[^\']*\')')
        .replace(/\{\}/g, '(.*)');

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

    return result.length > 0 ? result : stepDefinitions;
}

// ─── Step definition loader ───────────────────────────────────────────────────

async function loadStepDefinitions() {
    stepDefsLoaded = false;

    if (statusBarItem) {
        statusBarItem.text = '$(sync~spin) BDD: Indexing steps...';
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
                    const prefix = literalPrefix(rawPattern);

                    stepDefinitions.push({
                        regex: patternToRegex(rawPattern),
                        rawPattern,
                        prefix,
                        file: file.fsPath,
                        line: content.slice(0, m.index).split('\n').length - 1
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

    vscode.window.visibleTextEditors.forEach(decorateEditor);
}

// ─── Preferences ──────────────────────────────────────────────────────────────

function applyStepPreferences(allMatches, stepText) {
    if (allMatches.length <= 1) return allMatches[0] || null;

    let preferenceType = 'default';

    if (stepText.match(/\b(verify|check|validate|should|assert|confirm|ensure)\b/i)) {
        preferenceType = 'verification';
    } else if (stepText.match(/\b(click|enter|select|upload|navigate|login|update|process)\b/i)) {
        preferenceType = 'action';
    }

    const preferences = STEP_PREFERENCES[preferenceType];

    for (const preferredKeyword of preferences) {
        const match = allMatches.find(m => m.def.defKeyword === preferredKeyword);
        if (match) return match;
    }

    return allMatches[0];
}

// ─── Decoration computation ───────────────────────────────────────────────────

function computeDecorations(doc) {
    const paramRanges = [], outlineRanges = [], stepKwRanges = [],
          featureKwRanges = [], unmatchedRanges = [], ambiguousRanges = [];
    const unmatchedSteps = [];
    const ambiguousSteps = [];

    const stepKwRe = /^(\s*)(Given|When|Then|And|But)(\s+)/i;

    for (let ln = 0; ln < doc.lineCount; ln++) {
        const lineText = doc.lineAt(ln).text;
        const sk = lineText.match(stepKwRe);
        if (!sk) continue;

        const stepStart = sk[0].length;
        const stepText = lineText.slice(stepStart).trim();

        const candidates = getCandidates(stepText);
        const allMatches = [];

        for (const def of candidates) {
            const m = stepText.match(def.regex);
            if (!m) continue;

            const capLen = m.slice(1).reduce((sum, g) => sum + (g ? g.length : 0), 0);
            allMatches.push({ def, match: m, capLen });
        }

        const range = new vscode.Range(ln, stepStart, lineText.trimEnd().length);

        if (allMatches.length === 0) {

            if (stepDefsLoaded) {
                unmatchedRanges.push(range);
                unmatchedSteps.push({ range, keyword: sk[2], stepText });
            }

        } else if (allMatches.length > 1) {

            // 🔥 FIX: ALWAYS mark ambiguous
            ambiguousRanges.push(range);
            ambiguousSteps.push({
                range,
                keyword: sk[2],
                stepText,
                matchingDefs: allMatches.map(({ def }) => def),
            });

            // Keep UX: still highlight params using preferred match
            const preferredMatch = applyStepPreferences(allMatches, stepText);

            if (preferredMatch) {
                const { match: bestMatch } = preferredMatch;

                let searchFrom = stepStart;
                for (let g = 1; g < bestMatch.length; g++) {
                    if (!bestMatch[g]) continue;

                    const val = bestMatch[g];
                    const idx = lineText.indexOf(val, searchFrom);

                    if (idx >= 0) {
                        paramRanges.push(new vscode.Range(ln, idx, ln, idx + val.length));
                        searchFrom = idx + val.length;
                    }
                }
            }

        } else {

            const { match: bestMatch } = allMatches[0];

            let searchFrom = stepStart;
            for (let g = 1; g < bestMatch.length; g++) {
                if (!bestMatch[g]) continue;

                const val = bestMatch[g];
                const idx = lineText.indexOf(val, searchFrom);

                if (idx >= 0) {
                    paramRanges.push(new vscode.Range(ln, idx, ln, idx + val.length));
                    searchFrom = idx + val.length;
                }
            }
        }
    }

    return { paramRanges, unmatchedRanges, ambiguousRanges, unmatchedSteps, ambiguousSteps };
}

// ─── Decoration apply ─────────────────────────────────────────────────────────

function decorateEditor(editor) {
    if (!editor || !editor.document.fileName.endsWith('.feature')) return;

    const doc = editor.document;
    const result = computeDecorations(doc);

    editor.setDecorations(paramDecoration, result.paramRanges);
    editor.setDecorations(unmatchedDecoration, result.unmatchedRanges);
    editor.setDecorations(ambiguousDecoration, result.ambiguousRanges);
}

// ─── Activate ─────────────────────────────────────────────────────────────────

function activate(context) {

    paramDecoration = vscode.window.createTextEditorDecorationType({ color: '#CE9178' });

    unmatchedDecoration = vscode.window.createTextEditorDecorationType({
        color: '#F44747',
        textDecoration: 'underline wavy #F44747'
    });

    ambiguousDecoration = vscode.window.createTextEditorDecorationType({
        color: '#FFA500',
        textDecoration: 'underline wavy orange'
    });

    loadStepDefinitions();

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(decorateEditor),
        vscode.workspace.onDidChangeTextDocument(e => {
            const editor = vscode.window.activeTextEditor;
            if (editor && e.document === editor.document) decorateEditor(editor);
        })
    );

    if (vscode.window.activeTextEditor) {
        decorateEditor(vscode.window.activeTextEditor);
    }
}

function deactivate() {}

module.exports = { activate, deactivate };
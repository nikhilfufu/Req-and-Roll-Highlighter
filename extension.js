'use strict';

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

function patternToRegex(pattern) {
    // Convert Cucumber Expression tokens to regex capture groups
    pattern = pattern
        .replace(/\{int\}/g,            '(-?\\d+)')
        .replace(/\{float\}|\{double\}/g,'(-?\\d*\\.?\\d+)')
        .replace(/\{word\}/g,           '(\\w+)')
        .replace(/\{string\}/g,         '("[^"]*"|\'[^\']*\')')
        .replace(/\{\}/g,               '(.*)');
    // \( and \) in Reqnroll patterns mean literal parentheses (regex escape syntax).
    // Replace with private-use placeholders so the split on (...) groups works cleanly.
    const LPAR = '\u0001', RPAR = '\u0002';
    pattern = pattern.replace(/\\\(/g, LPAR).replace(/\\\)/g, RPAR);
    const parts = pattern.split(/(\([^)]*\))/);
    const escaped = parts.map((part, i) => {
        if (i % 2 === 0) {
            // literal part — escape regex specials, then restore placeholders as literal parens
            return part
                .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                .replace(new RegExp(LPAR, 'g'), '\\(')
                .replace(new RegExp(RPAR, 'g'), '\\)');
        }
        // potential capture group — only keep as regex if it contains actual regex operators
        // e.g. (.*) or (\d+) → real capture; (s) or (ies) → literal parentheses
        const inner = part.slice(1, -1);
        if (/[.*+?\\[\]|^${}]/.test(inner)) {
            return part; // real regex capture group
        }
        // literal parentheses like (s) — escape them
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
                    // m[1] = '@' (verbatim) or '' (non-verbatim); m[2] = raw captured pattern
                    const isVerbatim = m[1] === '@';
                    // For non-verbatim strings, unescape C# escape sequences (e.g. \\ -> \, \( -> ()
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
    stepDefsLoaded = true;
    if (statusBarItem) {
        statusBarItem.text = `$(check) BDD: ${stepDefinitions.length} steps`;
        statusBarItem.tooltip = `${stepDefinitions.length} step definitions indexed from C# files`;
    }
    vscode.window.visibleTextEditors.forEach(decorateEditor);
}

function computeDecorations(doc) {
    const paramRanges = [], outlineRanges = [], stepKwRanges = [], featureKwRanges = [], unmatchedRanges = [];
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
        const stepText = lineText.slice(stepStart).trim(); // trim leading and trailing whitespace so regex matches correctly
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
            // Only show red AFTER initial step index is ready — avoids false reds on startup
            unmatchedRanges.push(new vscode.Range(ln, stepStart, ln, lineText.trimEnd().length));
        }
    }
    return { paramRanges, outlineRanges, stepKwRanges, featureKwRanges, unmatchedRanges };
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

function activate(context) {
    paramDecoration     = vscode.window.createTextEditorDecorationType({ color: '#CE9178', fontWeight: 'bold' });
    outlineDecoration   = vscode.window.createTextEditorDecorationType({ color: '#FF69B4', fontWeight: 'bold' });
    stepKwDecoration    = vscode.window.createTextEditorDecorationType({ color: '#569CD6', fontWeight: 'bold' });
    featureKwDecoration = vscode.window.createTextEditorDecorationType({ color: '#C586C0', fontWeight: 'bold' });
    unmatchedDecoration = vscode.window.createTextEditorDecorationType({ color: '#F44747', fontWeight: 'bold', textDecoration: 'underline wavy #F44747' });

    // Status bar item — shows spinner while loading, step count when ready
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = '$(sync~spin) BDD: Indexing steps...';
    statusBarItem.tooltip = 'BDD Parameter Colorizer is scanning step definitions';
    statusBarItem.show();
    loadStepDefinitions();
    const watcher = vscode.workspace.createFileSystemWatcher('**/Steps/**/*.cs');
    watcher.onDidChange(loadStepDefinitions);
    watcher.onDidCreate(loadStepDefinitions);
    watcher.onDidDelete(loadStepDefinitions);
    context.subscriptions.push(
        watcher, statusBarItem,
        paramDecoration, outlineDecoration, stepKwDecoration, featureKwDecoration, unmatchedDecoration,
        vscode.languages.registerDefinitionProvider({ language: 'feature' }, definitionProvider),
        vscode.languages.registerDefinitionProvider({ language: 'gherkin' }, definitionProvider),
        vscode.languages.registerDefinitionProvider({ scheme: 'file', pattern: '**/*.feature' }, definitionProvider),
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

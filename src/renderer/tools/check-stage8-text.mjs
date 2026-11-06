import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Scan literals and JSX text, so the nullish operator is never mistaken for broken Korean. */
export function brokenText(root = resolve('src/renderer')) {
  const defects = [];
  const files = readdirSync(resolve(root, 'src'), { recursive: true }).filter(name => typeof name === 'string' && /\.(?:tsx?|[cm]?js|css|html)$/.test(name)).map(name => `src/${name}`);
  files.push('tools/capture-stage8-web.mjs', 'tools/mutate-stage8-web.mjs', 'tools/check-stage8-text.mjs', 'tools/check-contract.mjs', 'public/notify-sw.js', 'index.html', '.env.remote');
  for (const name of files) {
    const path = resolve(root, name);
    const source = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
    const report = (position, text) => defects.push(`${relative(process.cwd(), path).replaceAll('\\', '/')}:${source.slice(0, position).split('\n').length}: ${text}`);
    if (source.includes('\uFFFD')) report(source.indexOf('\uFFFD'), 'replacement character');
    if (!/\.(?:tsx?|[cm]?js)$/.test(name)) continue;
    const ast = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    function visit(node) {
      if ((ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && /\?{2,}/.test(node.text)) {
        // Mutation tools also hold valid source snippets containing the nullish operator.
        const codeSnippet = name.startsWith('tools/') && ts.createSourceFile('snippet.tsx', node.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).parseDiagnostics.length === 0;
        if (!codeSnippet) report(node.getStart(ast), 'question marks in text');
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
  return { files: files.length, defects };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = brokenText();
  console.log(JSON.stringify(result, null, 2));
  if (result.defects.length) process.exitCode = 1;
}

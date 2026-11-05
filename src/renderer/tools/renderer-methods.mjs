import ts from 'typescript';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? sourceFiles(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : []);
}

export function invokedMethods(source, filename = 'screen.tsx') {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const methods = [];
  const literals = node => {
    if (!node) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node)) return [...literals(node.whenTrue), ...literals(node.whenFalse)];
    return [];
  };
  const walk = node => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (name === 'call' || name === 'invoke') methods.push(...literals(node.arguments[0]));
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  return methods;
}

export function rendererInvocations(root) {
  return sourceFiles(root).flatMap(path => invokedMethods(readFileSync(path, 'utf8'), path).map(method => ({ path, method })));
}

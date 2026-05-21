import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));
const importSpecifierPattern =
  /(?<prefix>\bfrom\s+['"]|\bimport\s*\(\s*['"]|\bexport\s+[^'";]*?\s+from\s+['"])(?<specifier>\.{1,2}\/[^'"?#]+)(?<suffix>['"])/g;
const supportedExtensions = new Set(['.js', '.mjs', '.cjs', '.json', '.node']);

async function exists(pathOrUrl) {
  try {
    await stat(pathOrUrl);
    return true;
  } catch {
    return false;
  }
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (entry.isFile()) {
      yield path;
    }
  }
}

async function resolveRuntimeSpecifier(filePath, specifier) {
  if (supportedExtensions.has(extname(specifier))) {
    return specifier;
  }

  const sourceUrl = pathToFileURL(filePath);
  const fileTarget = new URL(`${specifier}.js`, sourceUrl);
  if (await exists(fileTarget)) {
    return `${specifier}.js`;
  }

  const indexTarget = new URL(`${specifier}/index.js`, sourceUrl);
  if (await exists(indexTarget)) {
    return `${specifier}/index.js`;
  }

  return specifier;
}

for await (const filePath of walk(DIST_DIR)) {
  if (!(filePath.endsWith('.js') || filePath.endsWith('.d.ts'))) {
    continue;
  }

  const source = await readFile(filePath, 'utf8');
  const replacements = await Promise.all(
    [...source.matchAll(importSpecifierPattern)].map(async (match) => {
      const fixedSpecifier = await resolveRuntimeSpecifier(filePath, match.groups.specifier);
      return [match[0], `${match.groups.prefix}${fixedSpecifier}${match.groups.suffix}`];
    }),
  );

  let fixed = source;
  for (const [from, to] of replacements) {
    fixed = fixed.replace(from, to);
  }

  if (fixed !== source) {
    await writeFile(filePath, fixed);
  }
}

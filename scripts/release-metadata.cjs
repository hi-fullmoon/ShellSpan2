'use strict';
const fs = require('node:fs');

function metadata(tag, version, notes, changelog) {
  const suffix = tag.startsWith(`v${version}-`) ? tag.slice(version.length + 2) : null;
  const identifier = /^(0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)$/;
  if (tag !== `v${version}` && !(suffix && suffix.split('.').every((x) => identifier.test(x))))
    throw new Error('Release tag/version mismatch');
  const extract = (name) => {
    const lines = changelog.split('\n');
    const start = lines.findIndex((line) => line.startsWith(`## [${name}]`));
    if (start < 0) return '';
    const end = lines.findIndex((line, i) => i > start && line.startsWith('## ['));
    return lines
      .slice(start + 1, end < 0 ? undefined : end)
      .join('\n')
      .trim();
  };
  return {
    tag,
    version: tag.slice(1),
    prerelease: tag.slice(1).includes('-'),
    notes: notes || extract(tag) || extract(`v${version}`) || `Release ${tag}`,
  };
}
if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const cargo = fs
    .readFileSync('native/Cargo.toml', 'utf8')
    .match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  const lock = fs
    .readFileSync('native/Cargo.lock', 'utf8')
    .match(/\[\[package\]\]\s*\nname = "ShellSpan"\s*\nversion = "([^"]+)"/)?.[1];
  if (cargo !== pkg.version || lock !== pkg.version)
    throw new Error('Package and native versions differ');
  const result = metadata(
    process.env.RELEASE_TAG,
    pkg.version,
    process.env.RELEASE_NOTES,
    fs.existsSync('CHANGELOG.md') ? fs.readFileSync('CHANGELOG.md', 'utf8') : '',
  );
  fs.writeFileSync('release-metadata.json', JSON.stringify(result, null, 2));
  fs.writeFileSync('release-notes.md', result.notes + '\n');
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(
      process.env.GITHUB_OUTPUT,
      `tag=${result.tag}\nversion=${result.version}\nprerelease=${result.prerelease}\n`,
    );
}
module.exports = { metadata };

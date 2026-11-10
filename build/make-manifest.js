// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.
// Source: vscode-agent-plus shared/build/make-manifest.js; sync-shared.js copies it, so edit it there.

'use strict';
/*
 * Writes the two descriptor files a .vsix needs, derived from package.json so the identity and version cannot drift
 * from the manifest the editor actually reads:
 *
 *   node make-manifest.js <staging-dir> [<package.json>]
 *
 * It reads the staged extension/package.json, or the one given as the second argument (build/pack-shim.sh in Claude
 * Code Plus passes the shim's).
 */
const fs = require('fs');
const path = require('path');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/*
 * A .vsix is an Open Packaging Conventions zip: a part whose extension has no Default in [Content_Types].xml is not
 * part of the package to a reader that follows the format, and the Marketplace is one. So every extension in the staged
 * tree is listed, and a file with no extension at all stops the build.
 */
const TYPES = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.md': 'text/markdown', '.png': 'image/png', '.py': 'text/x-python', '.svg': 'image/svg+xml', '.txt': 'text/plain',
};

/** Writes extension.vsixmanifest and [Content_Types].xml into `stage`, or throws saying what the package cannot carry. */
function write(stage, pkgFile) {
  const ext = path.join(stage, 'extension');
  const pkg = JSON.parse(fs.readFileSync(pkgFile || path.join(ext, 'package.json'), 'utf8'));
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(dir, e.name));
      else files.push(path.relative(stage, path.join(dir, e.name)).split(path.sep).join('/'));
    }
  };
  walk(ext);
  const bare = files.filter((f) => !path.extname(f));
  if (bare.length) throw new Error(`files with no extension, which the package cannot carry: ${bare.join(', ')}`);
  /* The marketplace icon is optional; without one the two icon entries are left out. */
  const icon = pkg.icon ? 'extension/' + pkg.icon : '';
  const missing = ['extension/LICENSE.txt', icon].filter((f) => f && !files.includes(f));
  if (missing.length) throw new Error(`the manifest names files the package does not hold: ${missing.join(', ')}`);

  const vsix = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc((pkg.keywords || []).join(','))}</Tags>
    <Categories>${esc((pkg.categories || ['Other']).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="${esc((pkg.extensionDependencies || []).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="${esc((pkg.extensionKind || ['workspace']).join(','))}" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.EnabledApiProposals" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExecutesCode" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
${icon ? `    <Icon>${esc(icon)}</Icon>\n` : ''}  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
${icon ? `    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="${esc(icon)}" Addressable="true" />\n` : ''}  </Assets>
</PackageManifest>
`;
  const exts = [...new Set(files.map((f) => path.extname(f).toLowerCase()).concat('.vsixmanifest'))].sort();
  const types = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${exts.map((x) => `  <Default Extension="${esc(x)}" ContentType="${x === '.vsixmanifest' ? 'text/xml' : TYPES[x] || 'application/octet-stream'}" />`).join('\n')}
</Types>
`;
  fs.writeFileSync(path.join(stage, 'extension.vsixmanifest'), vsix);
  fs.writeFileSync(path.join(stage, '[Content_Types].xml'), types);
  return pkg;
}

module.exports = { write, TYPES };

if (require.main === module) {
  const stage = process.argv[2];
  if (!stage) { console.error('usage: node make-manifest.js <staging-dir> [<package.json>]'); process.exit(2); }
  try {
    const pkg = write(stage, process.argv[3] && path.resolve(process.argv[3]));
    console.log(`manifest for ${pkg.publisher}.${pkg.name} ${pkg.version}`);
  } catch (e) {
    console.error(`make-manifest.js: ${e.message}`);
    process.exit(1);
  }
}

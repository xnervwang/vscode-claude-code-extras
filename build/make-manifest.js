// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Writes the two descriptor files a .vsix needs, derived from package.json so the identity and version cannot drift
 * from the manifest the editor actually reads. Called by pack.sh with the staging directory as its argument, and by
 * pack-shim.sh with the shim's package.json after it.
 */
const fs = require('fs');
const path = require('path');
const stage = process.argv[2];
if (!stage) { console.error('usage: node make-manifest.js <staging-dir> [<package.json>]'); process.exit(2); }
const pkg = require(process.argv[3] ? path.resolve(process.argv[3]) : '../package.json');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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
    <Icon>extension/images/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/images/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
`;

/*
 * A .vsix is an Open Packaging Conventions zip: a part whose extension has no Default in [Content_Types].xml is not
 * part of the package to a reader that follows the format, and the Marketplace is one. So every extension in the staged
 * tree is listed, and a file with no extension at all stops the build.
 */
const TYPES = {
  '.css': 'text/css', '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
  '.md': 'text/markdown', '.png': 'image/png', '.py': 'text/x-python', '.svg': 'image/svg+xml', '.txt': 'text/plain',
};
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name));
    else files.push(path.relative(stage, path.join(dir, e.name)));
  }
};
walk(path.join(stage, 'extension'));
const bare = files.filter((f) => !path.extname(f));
if (bare.length) { console.error('make-manifest.js: files with no extension, which the package cannot carry: ' + bare.join(', ')); process.exit(1); }
const exts = Array.from(new Set(files.map((f) => path.extname(f).toLowerCase()).concat('.vsixmanifest'))).sort();
const types = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${exts.map((x) => `  <Default Extension="${esc(x)}" ContentType="${x === '.vsixmanifest' ? 'text/xml' : TYPES[x] || 'application/octet-stream'}" />`).join('\n')}
</Types>
`;

fs.writeFileSync(path.join(stage, 'extension.vsixmanifest'), vsix);
fs.writeFileSync(path.join(stage, '[Content_Types].xml'), types);
console.log(`manifest for ${pkg.publisher}.${pkg.name} ${pkg.version}`);

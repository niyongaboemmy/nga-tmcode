# Third-party notices

TMCode bundles the following material from other projects. Each keeps its own
licence; the full texts ship next to the files.

## Visual Studio Code colour themes

- Files: `packages/workbench/src/themes/vscode/*.json`
- Source: <https://github.com/microsoft/vscode> (`extensions/theme-defaults`)
- Licence: MIT, Copyright (c) 2015 - present Microsoft Corporation.
  Full text: `packages/workbench/src/themes/vscode/LICENSE.txt`

## Seti file icon theme ("Seti (Visual Studio Code)")

TMCode's default file icon theme is VS Code's built-in Seti theme, unchanged.

- Files: `packages/workbench/src/themes/seti/vs-seti-icon-theme.json`,
  `packages/workbench/src/themes/seti/seti.woff`
- Source: <https://github.com/microsoft/vscode> (`extensions/theme-seti`, package
  `vscode-theme-seti`, licence MIT), built from Seti UI
  <https://github.com/jesseweed/seti-ui> at commit
  `2d6c5e68b4ded73c92dac291845ee44e1182d511` (see `cgmanifest.json`).
- Licences:
  - MIT, Copyright (c) 2015 - present Microsoft Corporation
    (`packages/workbench/src/themes/seti/LICENSE.txt`).
  - MIT, Copyright (c) 2014 Jesse Weed, for the Seti UI icons and font
    (`packages/workbench/src/themes/seti/ThirdPartyNotices.txt`).

To update: download `icons/vs-seti-icon-theme.json`, `icons/seti.woff`,
`ThirdPartyNotices.txt` and `cgmanifest.json` from
`microsoft/vscode/extensions/theme-seti` on `main` into
`packages/workbench/src/themes/seti/`, and run `npx vitest run packages/workbench/src/themes`.

import { describe, expect, it } from "vitest";
import { EXTRA_LANGUAGES } from "../textmate/grammars";
import { matchesFilenamePattern, matchLanguage, type LanguageNamePatterns } from "./languageMatch";

/** The parts of Monaco's own registrations that compete with TMCode's (they come first, as in the app). */
const MONACO: LanguageNamePatterns[] = [
  { id: "plaintext", extensions: [".txt"] },
  { id: "ini", extensions: [".ini", ".properties", ".gitconfig"], filenames: ["config", ".gitattributes", ".gitconfig", ".editorconfig"] },
  { id: "json", extensions: [".json", ".bowerrc", ".jshintrc", ".jscsrc", ".eslintrc", ".babelrc", ".har"] },
  { id: "fsharp", extensions: [".fs", ".fsi", ".ml", ".mli", ".fsx", ".fsscript"] },
  { id: "scheme", extensions: [".scm", ".ss", ".sch", ".rkt"] },
  { id: "php", extensions: [".php", ".php4", ".php5", ".phtml", ".ctp"] },
  { id: "ruby", extensions: [".rb", ".rbx", ".rjs", ".gemspec", ".pp"], filenames: ["rakefile", "Gemfile"] },
  { id: "dockerfile", extensions: [".dockerfile"], filenames: ["Dockerfile"] },
  { id: "shell", extensions: [".sh", ".bash"] },
  { id: "yaml", extensions: [".yaml", ".yml"] },
  { id: "hcl", extensions: [".tf", ".tfvars", ".hcl"] },
  { id: "typescript", extensions: [".ts", ".tsx", ".cts", ".mts"] },
  { id: "python", extensions: [".py"] },
  { id: "kotlin", extensions: [".kt", ".kts"] },
  { id: "mdx", extensions: [".mdx"] },
  { id: "proto", extensions: [".proto"] },
  { id: "sol", extensions: [".sol"] },
  { id: "wgsl", extensions: [".wgsl"] },
  { id: "mips", extensions: [".s"] },
];
const ALL = [...MONACO, ...EXTRA_LANGUAGES];
const lang = (path: string) => matchLanguage(path, ALL) ?? "plaintext";

describe("matchLanguage", () => {
  it("gives every kind of .env file the dotenv language, never 'local' or plain text", () => {
    for (const p of [".env", ".env.local", ".env.production", ".env.development.local", ".env.example", ".ENV.Test", "app/.env.staging", "config/prod.env", ".flaskenv"]) expect(lang(p), p).toBe("dotenv");
    expect(lang(".envrc")).toBe("shell");
    expect(lang("src/env.ts")).toBe("typescript");
  });

  it("knows dotfiles, ignore files and config files", () => {
    const cases: Record<string, string> = {
      ".gitignore": "ignore",
      "web/.dockerignore": "ignore",
      ".npmignore": "ignore",
      ".prettierignore": "ignore",
      ".eslintignore": "ignore",
      ".gitattributes": "gitattributes",
      ".editorconfig": "ini",
      ".npmrc": "ini",
      ".yarnrc": "ini",
      "setup.cfg": "ini",
      "nginx.conf": "nginx",
      "deploy/nginx/site.conf": "nginx",
      "app.conf": "ini",
      ".htaccess": "apacheconf",
      "crontab": "crontab",
      "requirements.txt": "pip-requirements",
      "requirements-dev.txt": "pip-requirements",
      "notes.txt": "plaintext",
      "go.mod": "go.mod",
      "go.sum": "go.sum",
      "Cargo.lock": "toml",
      "Cargo.toml": "toml",
      "poetry.lock": "toml",
      "tsconfig.json": "jsonc",
      "tsconfig.app.json": "jsonc",
      "jsconfig.json": "jsonc",
      ".eslintrc": "jsonc",
      ".babelrc": "jsonc",
      "proj.code-workspace": "jsonc",
      ".vscode/settings.json": "jsonc",
      ".prettierrc": "json",
      "package.json": "json",
      ".bashrc": "shell",
      ".zshrc": "shell",
      ".profile": "shell",
      "CODEOWNERS": "codeowners",
      ".ssh/config": "ssh_config",
    };
    for (const [p, id] of Object.entries(cases)) expect(lang(p), p).toBe(id);
  });

  it("knows build files by name and pattern", () => {
    const cases: Record<string, string> = {
      Dockerfile: "dockerfile",
      "Dockerfile.dev": "dockerfile",
      "dockerfile.prod": "dockerfile",
      "api.Dockerfile": "dockerfile",
      Containerfile: "dockerfile",
      "docker-compose.yml": "yaml",
      "docker-compose.override.yaml": "yaml",
      Makefile: "makefile",
      "rules.mk": "makefile",
      "CMakeLists.txt": "cmake",
      "toolchain.cmake": "cmake",
      Jenkinsfile: "groovy",
      "Jenkinsfile.release": "groovy",
      "build.gradle": "groovy",
      "build.gradle.kts": "kotlin",
      Vagrantfile: "ruby",
      Gemfile: "ruby",
      Rakefile: "ruby",
      Podfile: "ruby",
      justfile: "just",
    };
    for (const [p, id] of Object.entries(cases)) expect(lang(p), p).toBe(id);
  });

  it("knows web, template and other languages, TMCode's registration winning a tie with Monaco's", () => {
    const cases: Record<string, string> = {
      "App.vue": "vue",
      "Page.svelte": "svelte",
      "index.astro": "astro",
      "post.mdx": "mdx",
      "rules.mdc": "mdc",
      "welcome.blade.php": "blade",
      "index.php": "php",
      "base.html.j2": "jinja-html",
      "page.njk": "jinja",
      "theme.sass": "sass",
      "theme.styl": "stylus",
      "main.tf": "terraform",
      "prod.tfvars": "terraform",
      "config.hcl": "hcl",
      "api.http": "http",
      "calls.rest": "http",
      "schema.prisma": "prisma",
      "user.proto": "proto",
      "Main.hs": "haskell",
      "main.ml": "ocaml",
      "server.rkt": "racket",
      "build.zig": "zig",
      "paper.tex": "latex",
      "refs.bib": "bibtex",
      "boot.asm": "asm",
      "flake.nix": "nix",
      "Token.sol": "sol",
      "shader.wgsl": "wgsl",
      "light.hlsl": "hlsl",
      "blur.frag": "glsl",
      "config.fish": "fish",
      "init.vim": "viml",
      ".vimrc": "viml",
      "app.service": "systemd",
      "server.log": "log",
      "server.log.1": "log",
      "data.tsv": "tsv",
      "fix.patch": "diff",
    };
    for (const [p, id] of Object.entries(cases)) expect(lang(p), p).toBe(id);
  });
});

describe("matchesFilenamePattern", () => {
  it("matches globs on the name, and on the end of the path when the pattern has a /", () => {
    expect(matchesFilenamePattern(".env.*", "a/b/.env.local")).toBe(true);
    expect(matchesFilenamePattern(".env.*", ".env")).toBe(false);
    expect(matchesFilenamePattern("Dockerfile.*", "DOCKERFILE.dev")).toBe(true);
    expect(matchesFilenamePattern(".vscode/*.json", "proj/.vscode/tasks.json")).toBe(true);
    expect(matchesFilenamePattern(".vscode/*.json", "proj/.vscode/sub/tasks.json")).toBe(false);
    expect(matchesFilenamePattern("nginx/**/*.conf", "etc/nginx/sites/a.conf")).toBe(true);
    expect(matchesFilenamePattern("*.{yml,yaml}", "x.yaml")).toBe(true);
    expect(matchesFilenamePattern("requirements*.txt", "requirements.txt")).toBe(true);
  });
});

/**
 * Which TextMate grammar colours which language. Built-in grammars come from
 * `tm-grammars` (MIT, the grammars VS Code and Shiki ship) and are bundled as
 * separate chunks, loaded the first time a language is tokenized. Extensions
 * add or override grammars at runtime (extensions/contributions.ts).
 */

/** A grammar's JSON (or plist parsed to an object). */
export type RawGrammarSource = { kind: "object"; value: unknown } | { kind: "text"; text: string; path: string };

export interface GrammarDef {
  scopeName: string;
  load(): Promise<RawGrammarSource>;
  /** Scopes this grammar is injected into (`injectTo` in a VS Code grammar contribution). */
  injectTo?: string[];
  /** Scope → language id of embedded code (for completeness; colours come from the grammar). */
  embeddedLanguages?: Record<string, string>;
  /** Scope → "string" | "comment" | "other" overrides for Monaco's token kinds. */
  tokenTypes?: Record<string, string>;
  /** Extension that contributed it (undefined for built-ins). */
  extension?: string;
}

/** `?raw` keeps tsc from type-checking megabytes of JSON; JSON.parse is also faster than a JS object literal. */
const obj = (p: Promise<{ default: string }>): Promise<RawGrammarSource> => p.then((m) => ({ kind: "object", value: JSON.parse(m.default) }));

/** A PHP block: `<?php … ?>`, `<?= … ?>`, or `<?php` to the end of the file. */
const phpTag = (name: string, begin: string) => ({
  begin,
  beginCaptures: { 0: { name: "punctuation.section.embedded.begin.php" } },
  end: "(\\?)>",
  endCaptures: { 0: { name: "punctuation.section.embedded.end.php" }, 1: { name: "source.php" } },
  name,
  contentName: "source.php",
  patterns: [{ include: "source.php" }],
});

/**
 * VS Code's PHP grammar (extensions/php/syntaxes/html.tmLanguage.json, MIT): HTML, with PHP
 * injected wherever `<?php` opens (between tags, inside attributes and inline scripts).
 */
const HTML_PHP = {
  scopeName: "text.html.php",
  injections: {
    "L:text.html.php - (meta.embedded | meta.tag), L:text.html.php meta.tag, L:source.js.embedded.html": { patterns: [{ include: "#php-tag" }] },
  },
  patterns: [{ include: "text.html.derivative" }],
  repository: {
    "php-tag": { patterns: [phpTag("meta.embedded.block.php", "<\\?(?i:php|=)?(?![^?]*\\?>)"), phpTag("meta.embedded.line.php", "<\\?(?i:php|=)?")] },
  },
};

/** TMCode's own grammars (inlineGrammars.ts), in their own lazy chunk. */
const inline = (name: keyof typeof import("./inlineGrammars")): Promise<RawGrammarSource> => import("./inlineGrammars").then((m) => ({ kind: "object", value: m[name] }));

/**
 * Built-in grammars: scope → lazy chunk. Every language in LANGUAGES, plus the
 * grammars they embed (Markdown fences, <script>/<style> in Vue, SQL in PHP…).
 */
const BUILTIN: GrammarDef[] = [
  { scopeName: "source.abap", load: () => obj(import("tm-grammars/grammars/abap.json?raw")) },
  { scopeName: "source.actionscript.3", load: () => obj(import("tm-grammars/grammars/actionscript-3.json?raw")) },
  { scopeName: "source.ada", load: () => obj(import("tm-grammars/grammars/ada.json?raw")) },
  { scopeName: "source.ahk", load: () => obj(import("tm-grammars/grammars/ahk.json?raw")) },
  { scopeName: "source.apacheconf", load: () => obj(import("tm-grammars/grammars/apache.json?raw")) },
  { scopeName: "source.apex", load: () => obj(import("tm-grammars/grammars/apex.json?raw")) },
  { scopeName: "source.apl", load: () => obj(import("tm-grammars/grammars/apl.json?raw")) },
  { scopeName: "source.applescript", load: () => obj(import("tm-grammars/grammars/applescript.json?raw")) },
  { scopeName: "source.asm.x86_64", load: () => obj(import("tm-grammars/grammars/asm.json?raw")) },
  { scopeName: "source.asp.vb.net", load: () => obj(import("tm-grammars/grammars/vb.json?raw")) },
  { scopeName: "source.astro", load: () => obj(import("tm-grammars/grammars/astro.json?raw")) },
  { scopeName: "source.awk", load: () => obj(import("tm-grammars/grammars/awk.json?raw")) },
  { scopeName: "source.ballerina", load: () => obj(import("tm-grammars/grammars/ballerina.json?raw")) },
  { scopeName: "source.batchfile", load: () => obj(import("tm-grammars/grammars/bat.json?raw")) },
  { scopeName: "source.bicep", load: () => obj(import("tm-grammars/grammars/bicep.json?raw")) },
  { scopeName: "source.c", load: () => obj(import("tm-grammars/grammars/c.json?raw")) },
  { scopeName: "source.c3", load: () => obj(import("tm-grammars/grammars/c3.json?raw")) },
  { scopeName: "source.cairo0", load: () => obj(import("tm-grammars/grammars/cairo.json?raw")) },
  { scopeName: "source.chapel", load: () => obj(import("tm-grammars/grammars/chapel.json?raw")) },
  { scopeName: "source.clojure", load: () => obj(import("tm-grammars/grammars/clojure.json?raw")) },
  { scopeName: "source.cmake", load: () => obj(import("tm-grammars/grammars/cmake.json?raw")) },
  { scopeName: "source.cobol", load: () => obj(import("tm-grammars/grammars/cobol.json?raw")) },
  { scopeName: "source.coffee", load: () => obj(import("tm-grammars/grammars/coffee.json?raw")) },
  { scopeName: "source.commonlisp", load: () => obj(import("tm-grammars/grammars/common-lisp.json?raw")) },
  { scopeName: "source.cpp", load: () => obj(import("tm-grammars/grammars/cpp.json?raw")) },
  { scopeName: "source.cpp.embedded.macro", load: () => obj(import("tm-grammars/grammars/cpp-macro.json?raw")) },
  { scopeName: "source.crystal", load: () => obj(import("tm-grammars/grammars/crystal.json?raw")) },
  { scopeName: "source.cs", load: () => obj(import("tm-grammars/grammars/csharp.json?raw")) },
  { scopeName: "source.css", load: () => obj(import("tm-grammars/grammars/css.json?raw")) },
  { scopeName: "source.css.less", load: () => obj(import("tm-grammars/grammars/less.json?raw")) },
  { scopeName: "source.css.postcss", load: () => obj(import("tm-grammars/grammars/postcss.json?raw")) },
  { scopeName: "source.css.scss", load: () => obj(import("tm-grammars/grammars/scss.json?raw")) },
  { scopeName: "source.cue", load: () => obj(import("tm-grammars/grammars/cue.json?raw")) },
  { scopeName: "source.cypher", load: () => obj(import("tm-grammars/grammars/cypher.json?raw")) },
  { scopeName: "source.d", load: () => obj(import("tm-grammars/grammars/d.json?raw")) },
  { scopeName: "source.dart", load: () => obj(import("tm-grammars/grammars/dart.json?raw")) },
  { scopeName: "source.dax", load: () => obj(import("tm-grammars/grammars/dax.json?raw")) },
  { scopeName: "source.desktop", load: () => obj(import("tm-grammars/grammars/desktop.json?raw")) },
  { scopeName: "source.diff", load: () => obj(import("tm-grammars/grammars/diff.json?raw")) },
  { scopeName: "source.dockerfile", load: () => obj(import("tm-grammars/grammars/docker.json?raw")) },
  { scopeName: "source.elixir", load: () => obj(import("tm-grammars/grammars/elixir.json?raw")) },
  { scopeName: "source.elm", load: () => obj(import("tm-grammars/grammars/elm.json?raw")) },
  { scopeName: "source.erlang", load: () => obj(import("tm-grammars/grammars/erlang.json?raw")) },
  { scopeName: "source.fish", load: () => obj(import("tm-grammars/grammars/fish.json?raw")) },
  { scopeName: "source.fnl", load: () => obj(import("tm-grammars/grammars/fennel.json?raw")) },
  { scopeName: "source.fortran.fixed", load: () => obj(import("tm-grammars/grammars/fortran-fixed-form.json?raw")) },
  { scopeName: "source.fortran.free", load: () => obj(import("tm-grammars/grammars/fortran-free-form.json?raw")) },
  { scopeName: "source.fsharp", load: () => obj(import("tm-grammars/grammars/fsharp.json?raw")) },
  { scopeName: "source.gdresource", load: () => obj(import("tm-grammars/grammars/gdresource.json?raw")) },
  { scopeName: "source.gdscript", load: () => obj(import("tm-grammars/grammars/gdscript.json?raw")) },
  { scopeName: "source.gdshader", load: () => obj(import("tm-grammars/grammars/gdshader.json?raw")) },
  { scopeName: "source.gleam", load: () => obj(import("tm-grammars/grammars/gleam.json?raw")) },
  { scopeName: "source.glsl", load: () => obj(import("tm-grammars/grammars/glsl.json?raw")) },
  { scopeName: "source.gn", load: () => obj(import("tm-grammars/grammars/gn.json?raw")) },
  { scopeName: "source.gnuplot", load: () => obj(import("tm-grammars/grammars/gnuplot.json?raw")) },
  { scopeName: "source.go", load: () => obj(import("tm-grammars/grammars/go.json?raw")) },
  { scopeName: "source.graphql", load: () => obj(import("tm-grammars/grammars/graphql.json?raw")) },
  { scopeName: "source.groovy", load: () => obj(import("tm-grammars/grammars/groovy.json?raw")) },
  { scopeName: "source.haskell", load: () => obj(import("tm-grammars/grammars/haskell.json?raw")) },
  { scopeName: "source.hcl", load: () => obj(import("tm-grammars/grammars/hcl.json?raw")) },
  { scopeName: "source.hcl.terraform", load: () => obj(import("tm-grammars/grammars/terraform.json?raw")) },
  { scopeName: "source.hjson", load: () => obj(import("tm-grammars/grammars/hjson.json?raw")) },
  { scopeName: "source.hlsl", load: () => obj(import("tm-grammars/grammars/hlsl.json?raw")) },
  { scopeName: "source.http", load: () => obj(import("tm-grammars/grammars/http.json?raw")) },
  { scopeName: "source.hurl", load: () => obj(import("tm-grammars/grammars/hurl.json?raw")) },
  { scopeName: "source.hx", load: () => obj(import("tm-grammars/grammars/haxe.json?raw")) },
  { scopeName: "source.hxml", load: () => obj(import("tm-grammars/grammars/hxml.json?raw")) },
  { scopeName: "source.hy", load: () => obj(import("tm-grammars/grammars/hy.json?raw")) },
  { scopeName: "source.imba", load: () => obj(import("tm-grammars/grammars/imba.json?raw")) },
  { scopeName: "source.ini", load: () => obj(import("tm-grammars/grammars/ini.json?raw")) },
  { scopeName: "source.java", load: () => obj(import("tm-grammars/grammars/java.json?raw")) },
  { scopeName: "source.jinja", load: () => obj(import("tm-grammars/grammars/jinja.json?raw")) },
  { scopeName: "source.js", load: () => obj(import("tm-grammars/grammars/javascript.json?raw")) },
  { scopeName: "source.js.jsx", load: () => obj(import("tm-grammars/grammars/jsx.json?raw")) },
  { scopeName: "source.json", load: () => obj(import("tm-grammars/grammars/json.json?raw")) },
  { scopeName: "source.json.comments", load: () => obj(import("tm-grammars/grammars/jsonc.json?raw")) },
  { scopeName: "source.json.lines", load: () => obj(import("tm-grammars/grammars/jsonl.json?raw")) },
  { scopeName: "source.json5", load: () => obj(import("tm-grammars/grammars/json5.json?raw")) },
  { scopeName: "source.jsonnet", load: () => obj(import("tm-grammars/grammars/jsonnet.json?raw")) },
  { scopeName: "source.julia", load: () => obj(import("tm-grammars/grammars/julia.json?raw")) },
  { scopeName: "source.just", load: () => obj(import("tm-grammars/grammars/just.json?raw")) },
  { scopeName: "source.kdl", load: () => obj(import("tm-grammars/grammars/kdl.json?raw")) },
  { scopeName: "source.kotlin", load: () => obj(import("tm-grammars/grammars/kotlin.json?raw")) },
  { scopeName: "source.kusto", load: () => obj(import("tm-grammars/grammars/kusto.json?raw")) },
  { scopeName: "source.lean4", load: () => obj(import("tm-grammars/grammars/lean.json?raw")) },
  { scopeName: "source.llvm", load: () => obj(import("tm-grammars/grammars/llvm.json?raw")) },
  { scopeName: "source.lua", load: () => obj(import("tm-grammars/grammars/lua.json?raw")) },
  { scopeName: "source.luau", load: () => obj(import("tm-grammars/grammars/luau.json?raw")) },
  { scopeName: "source.makefile", load: () => obj(import("tm-grammars/grammars/make.json?raw")) },
  { scopeName: "source.mdx", load: () => obj(import("tm-grammars/grammars/mdx.json?raw")) },
  { scopeName: "source.mojo", load: () => obj(import("tm-grammars/grammars/mojo.json?raw")) },
  { scopeName: "source.moonbit", load: () => obj(import("tm-grammars/grammars/moonbit.json?raw")) },
  { scopeName: "source.move", load: () => obj(import("tm-grammars/grammars/move.json?raw")) },
  { scopeName: "source.nextflow", load: () => obj(import("tm-grammars/grammars/nextflow.json?raw")) },
  { scopeName: "source.nextflow-groovy", load: () => obj(import("tm-grammars/grammars/nextflow-groovy.json?raw")) },
  { scopeName: "source.nginx", load: () => obj(import("tm-grammars/grammars/nginx.json?raw")) },
  { scopeName: "source.nim", load: () => obj(import("tm-grammars/grammars/nim.json?raw")) },
  { scopeName: "source.nix", load: () => obj(import("tm-grammars/grammars/nix.json?raw")) },
  { scopeName: "source.nsis", load: () => obj(import("tm-grammars/grammars/nsis.json?raw")) },
  { scopeName: "source.nushell", load: () => obj(import("tm-grammars/grammars/nushell.json?raw")) },
  { scopeName: "source.objc", load: () => obj(import("tm-grammars/grammars/objective-c.json?raw")) },
  { scopeName: "source.objcpp", load: () => obj(import("tm-grammars/grammars/objective-cpp.json?raw")) },
  { scopeName: "source.ocaml", load: () => obj(import("tm-grammars/grammars/ocaml.json?raw")) },
  { scopeName: "source.odin", load: () => obj(import("tm-grammars/grammars/odin.json?raw")) },
  { scopeName: "source.org", load: () => obj(import("tm-grammars/grammars/org.json?raw")) },
  { scopeName: "source.pascal", load: () => obj(import("tm-grammars/grammars/pascal.json?raw")) },
  { scopeName: "source.perl", load: () => obj(import("tm-grammars/grammars/perl.json?raw")) },
  { scopeName: "source.perl.6", load: () => obj(import("tm-grammars/grammars/raku.json?raw")) },
  { scopeName: "source.php", load: () => obj(import("tm-grammars/grammars/php.json?raw")) },
  { scopeName: "source.plsql.oracle", load: () => obj(import("tm-grammars/grammars/plsql.json?raw")) },
  { scopeName: "source.po", load: () => obj(import("tm-grammars/grammars/po.json?raw")) },
  { scopeName: "source.powerquery", load: () => obj(import("tm-grammars/grammars/powerquery.json?raw")) },
  { scopeName: "source.powershell", load: () => obj(import("tm-grammars/grammars/powershell.json?raw")) },
  { scopeName: "source.prisma", load: () => obj(import("tm-grammars/grammars/prisma.json?raw")) },
  { scopeName: "source.proto", load: () => obj(import("tm-grammars/grammars/proto.json?raw")) },
  { scopeName: "source.purescript", load: () => obj(import("tm-grammars/grammars/purescript.json?raw")) },
  { scopeName: "source.python", load: () => obj(import("tm-grammars/grammars/python.json?raw")) },
  { scopeName: "source.ql", load: () => obj(import("tm-grammars/grammars/codeql.json?raw")) },
  { scopeName: "source.qml", load: () => obj(import("tm-grammars/grammars/qml.json?raw")) },
  { scopeName: "source.qmldir", load: () => obj(import("tm-grammars/grammars/qmldir.json?raw")) },
  { scopeName: "source.qss", load: () => obj(import("tm-grammars/grammars/qss.json?raw")) },
  { scopeName: "source.r", load: () => obj(import("tm-grammars/grammars/r.json?raw")) },
  { scopeName: "source.racket", load: () => obj(import("tm-grammars/grammars/racket.json?raw")) },
  { scopeName: "source.rbs", load: () => obj(import("tm-grammars/grammars/rbs.json?raw")) },
  { scopeName: "source.reg", load: () => obj(import("tm-grammars/grammars/reg.json?raw")) },
  { scopeName: "source.regexp.python", load: () => obj(import("tm-grammars/grammars/regexp.json?raw")) },
  { scopeName: "source.riscv", load: () => obj(import("tm-grammars/grammars/riscv.json?raw")) },
  { scopeName: "source.ron", load: () => obj(import("tm-grammars/grammars/ron.json?raw")) },
  { scopeName: "source.rst", load: () => obj(import("tm-grammars/grammars/rst.json?raw")) },
  { scopeName: "source.ruby", load: () => obj(import("tm-grammars/grammars/ruby.json?raw")) },
  { scopeName: "source.rust", load: () => obj(import("tm-grammars/grammars/rust.json?raw")) },
  { scopeName: "source.sas", load: () => obj(import("tm-grammars/grammars/sas.json?raw")) },
  { scopeName: "source.sass", load: () => obj(import("tm-grammars/grammars/sass.json?raw")) },
  { scopeName: "source.scad", load: () => obj(import("tm-grammars/grammars/openscad.json?raw")) },
  { scopeName: "source.scala", load: () => obj(import("tm-grammars/grammars/scala.json?raw")) },
  { scopeName: "source.scheme", load: () => obj(import("tm-grammars/grammars/scheme.json?raw")) },
  { scopeName: "source.shaderlab", load: () => obj(import("tm-grammars/grammars/shaderlab.json?raw")) },
  { scopeName: "source.shell", load: () => obj(import("tm-grammars/grammars/shellscript.json?raw")) },
  { scopeName: "source.smithy", load: () => obj(import("tm-grammars/grammars/smithy.json?raw")) },
  { scopeName: "source.solidity", load: () => obj(import("tm-grammars/grammars/solidity.json?raw")) },
  { scopeName: "source.sparql", load: () => obj(import("tm-grammars/grammars/sparql.json?raw")) },
  { scopeName: "source.sql", load: () => obj(import("tm-grammars/grammars/sql.json?raw")) },
  { scopeName: "source.ssh-config", load: () => obj(import("tm-grammars/grammars/ssh-config.json?raw")) },
  { scopeName: "source.stata", load: () => obj(import("tm-grammars/grammars/stata.json?raw")) },
  { scopeName: "source.stylus", load: () => obj(import("tm-grammars/grammars/stylus.json?raw")) },
  { scopeName: "source.surrealql", load: () => obj(import("tm-grammars/grammars/surrealql.json?raw")) },
  { scopeName: "source.svelte", load: () => obj(import("tm-grammars/grammars/svelte.json?raw")) },
  { scopeName: "source.swift", load: () => obj(import("tm-grammars/grammars/swift.json?raw")) },
  { scopeName: "source.systemd", load: () => obj(import("tm-grammars/grammars/systemd.json?raw")) },
  { scopeName: "source.systemverilog", load: () => obj(import("tm-grammars/grammars/system-verilog.json?raw")) },
  { scopeName: "source.tcl", load: () => obj(import("tm-grammars/grammars/tcl.json?raw")) },
  { scopeName: "source.templ", load: () => obj(import("tm-grammars/grammars/templ.json?raw")) },
  { scopeName: "source.toml", load: () => obj(import("tm-grammars/grammars/toml.json?raw")) },
  { scopeName: "source.ts", load: () => obj(import("tm-grammars/grammars/typescript.json?raw")) },
  { scopeName: "source.tsp", load: () => obj(import("tm-grammars/grammars/typespec.json?raw")) },
  { scopeName: "source.tsx", load: () => obj(import("tm-grammars/grammars/tsx.json?raw")) },
  { scopeName: "source.turtle", load: () => obj(import("tm-grammars/grammars/turtle.json?raw")) },
  { scopeName: "source.typst", load: () => obj(import("tm-grammars/grammars/typst.json?raw")) },
  { scopeName: "source.vala", load: () => obj(import("tm-grammars/grammars/vala.json?raw")) },
  { scopeName: "source.verilog", load: () => obj(import("tm-grammars/grammars/verilog.json?raw")) },
  { scopeName: "source.vhdl", load: () => obj(import("tm-grammars/grammars/vhdl.json?raw")) },
  { scopeName: "source.viml", load: () => obj(import("tm-grammars/grammars/viml.json?raw")) },
  { scopeName: "source.vyper", load: () => obj(import("tm-grammars/grammars/vyper.json?raw")) },
  { scopeName: "source.wat", load: () => obj(import("tm-grammars/grammars/wasm.json?raw")) },
  { scopeName: "source.wgsl", load: () => obj(import("tm-grammars/grammars/wgsl.json?raw")) },
  { scopeName: "source.wikitext", load: () => obj(import("tm-grammars/grammars/wikitext.json?raw")) },
  { scopeName: "source.wit", load: () => obj(import("tm-grammars/grammars/wit.json?raw")) },
  { scopeName: "source.yaml", load: () => obj(import("tm-grammars/grammars/yaml.json?raw")) },
  { scopeName: "source.zenscript", load: () => obj(import("tm-grammars/grammars/zenscript.json?raw")) },
  { scopeName: "source.zig", load: () => obj(import("tm-grammars/grammars/zig.json?raw")) },
  { scopeName: "text.asciidoc", load: () => obj(import("tm-grammars/grammars/asciidoc.json?raw")) },
  { scopeName: "text.aspnetcorerazor", load: () => obj(import("tm-grammars/grammars/razor.json?raw")) },
  { scopeName: "text.beancount", load: () => obj(import("tm-grammars/grammars/beancount.json?raw")) },
  { scopeName: "text.bibtex", load: () => obj(import("tm-grammars/grammars/bibtex.json?raw")) },
  { scopeName: "text.codeowners", load: () => obj(import("tm-grammars/grammars/codeowners.json?raw")) },
  { scopeName: "text.csv", load: () => obj(import("tm-grammars/grammars/csv.json?raw")) },
  { scopeName: "text.gherkin.feature", load: () => obj(import("tm-grammars/grammars/gherkin.json?raw")) },
  { scopeName: "text.git-commit", load: () => obj(import("tm-grammars/grammars/git-commit.json?raw")) },
  { scopeName: "text.git-rebase", load: () => obj(import("tm-grammars/grammars/git-rebase.json?raw")) },
  { scopeName: "text.haml", load: () => obj(import("tm-grammars/grammars/haml.json?raw")) },
  { scopeName: "text.html.basic", load: () => obj(import("tm-grammars/grammars/html.json?raw")) },
  { scopeName: "text.html.derivative", load: () => obj(import("tm-grammars/grammars/html-derivative.json?raw")) },
  { scopeName: "text.html.edge", load: () => obj(import("tm-grammars/grammars/edge.json?raw")) },
  { scopeName: "text.html.erb", load: () => obj(import("tm-grammars/grammars/erb.json?raw")) },
  { scopeName: "text.html.handlebars", load: () => obj(import("tm-grammars/grammars/handlebars.json?raw")) },
  { scopeName: "text.html.jinja", load: () => obj(import("tm-grammars/grammars/jinja-html.json?raw")) },
  { scopeName: "text.html.liquid", load: () => obj(import("tm-grammars/grammars/liquid.json?raw")) },
  { scopeName: "text.html.markdown", load: () => obj(import("tm-grammars/grammars/markdown.json?raw")) },
  { scopeName: "text.html.php.blade", load: () => obj(import("tm-grammars/grammars/blade.json?raw")) },
  { scopeName: "text.html.soy", load: () => obj(import("tm-grammars/grammars/soy.json?raw")) },
  { scopeName: "text.html.twig", load: () => obj(import("tm-grammars/grammars/twig.json?raw")) },
  { scopeName: "text.html.vue", load: () => obj(import("tm-grammars/grammars/vue.json?raw")) },
  { scopeName: "text.log", load: () => obj(import("tm-grammars/grammars/log.json?raw")) },
  { scopeName: "text.markdown.mdc.standalone", load: () => obj(import("tm-grammars/grammars/mdc.json?raw")) },
  { scopeName: "text.marko", load: () => obj(import("tm-grammars/grammars/marko.json?raw")) },
  { scopeName: "text.pug", load: () => obj(import("tm-grammars/grammars/pug.json?raw")) },
  { scopeName: "text.shell-session", load: () => obj(import("tm-grammars/grammars/shellsession.json?raw")) },
  { scopeName: "text.tex", load: () => obj(import("tm-grammars/grammars/tex.json?raw")) },
  { scopeName: "text.tex.latex", load: () => obj(import("tm-grammars/grammars/latex.json?raw")) },
  { scopeName: "text.tsv", load: () => obj(import("tm-grammars/grammars/tsv.json?raw")) },
  { scopeName: "text.xml", load: () => obj(import("tm-grammars/grammars/xml.json?raw")) },
  { scopeName: "text.xml.xsl", load: () => obj(import("tm-grammars/grammars/xsl.json?raw")) },
  { scopeName: "text.html.php", load: async () => ({ kind: "object", value: HTML_PHP }), embeddedLanguages: { "source.php": "php", "text.html": "html" } },
  { scopeName: "source.dotenv", load: () => inline("DOTENV") },
  { scopeName: "source.ignore", load: () => inline("IGNORE") },
  { scopeName: "source.gitattributes", load: () => inline("GITATTRIBUTES") },
  { scopeName: "source.pip-requirements", load: () => inline("PIP_REQUIREMENTS") },
  { scopeName: "source.gomod", load: () => inline("GO_MOD") },
  { scopeName: "source.crontab", load: () => inline("CRONTAB") },
];

/** A language TMCode colours: Monaco id → grammar scope, plus the file names that open in it. */
interface LanguageDef {
  id: string;
  scope: string;
  extensions?: string[];
  filenames?: string[];
  /** VS Code globs on the file name (`.env.*`), or on the path when they contain "/" (`.vscode/*.json`). */
  filenamePatterns?: string[];
  /** Set for languages Monaco doesn't have; left out when TMCode only adds file names to one of Monaco's. */
  aliases?: string[];
}

/**
 * Every language TMCode colours, with VS Code's ids and file patterns. Where
 * Monaco has a Monarch tokenizer for the id, the TextMate grammar wins (Monarch
 * stays as the fallback). `typescript` uses the TSX grammar because Monaco has
 * one language id for .ts and .tsx (its TypeScript worker serves only
 * "typescript"); JSX in .tsx files then colours like VS Code.
 */
const LANGUAGES: LanguageDef[] = [
  // Monaco's languages (its own file patterns, a few added).
  { id: "python", scope: "source.python", extensions: [".pyi", ".pyx", ".pxd", ".pyz", ".ipy", ".bzl", ".star"], filenames: ["SConstruct", "SConscript", ".pythonrc", ".pythonstartup", "BUILD.bazel", "WORKSPACE", "BUCK", "Snakefile", "Tiltfile"] },
  { id: "javascript", scope: "source.js", extensions: [".es", ".pac"] },
  { id: "typescript", scope: "source.tsx" },
  { id: "html", scope: "text.html.basic", extensions: [".ejs", ".hta"] },
  { id: "css", scope: "source.css" },
  { id: "scss", scope: "source.css.scss" },
  { id: "less", scope: "source.css.less" },
  { id: "json", scope: "source.json", extensions: [".webmanifest", ".geojson", ".topojson", ".gltf", ".avsc", ".jsonld", ".mcmeta", ".tfstate", ".sarif"], filenames: [".prettierrc", ".stylelintrc", ".htmlhintrc", ".watchmanconfig", ".lintstagedrc", ".tern-project", ".tern-config", ".arcconfig", ".auto-changelog", ".c8rc", ".nycrc", ".markdownlintrc", "composer.lock", "Pipfile.lock", "flake.lock", "deno.lock", "mcmod.info", ".firebaserc", ".imgbotconfig"] },
  { id: "markdown", scope: "text.html.markdown", extensions: [".mkdown", ".ronn", ".workbook", ".scd", ".livemd"], filenames: ["contents.lr"] },
  { id: "c", scope: "source.c", extensions: [".i"] },
  { id: "cpp", scope: "source.cpp", extensions: [".cc", ".cxx", ".c++", ".hh", ".hxx", ".h++", ".ino", ".ipp", ".tpp", ".txx", ".inl", ".cu", ".cuh"] },
  { id: "java", scope: "source.java", extensions: [".jsh"] },
  // A .php file is HTML with PHP inside <?php … ?> (VS Code's text.html.php), not PHP code alone:
  // with source.php, HTML before <?php was coloured as PHP operators and names.
  { id: "php", scope: "text.html.php", extensions: [".php3", ".php7", ".php8", ".phps", ".phpt"] },
  { id: "sql", scope: "source.sql", extensions: [".dsql", ".ddl", ".dml", ".psql", ".pgsql", ".mysql", ".hql", ".cql"] },
  { id: "mysql", scope: "source.sql" },
  { id: "pgsql", scope: "source.sql" },
  {
    id: "shell",
    scope: "source.shell",
    extensions: [".zsh", ".ksh", ".csh", ".tcsh", ".ash", ".dash", ".ebuild", ".eclass", ".bats", ".command", ".tmux", ".zsh-theme", ".bash_aliases", ".bashrc", ".zshrc", ".install"],
    filenames: [".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".bash_aliases", ".bash_functions", ".zshrc", ".zprofile", ".zshenv", ".zlogin", ".zlogout", ".profile", ".kshrc", ".cshrc", ".tcshrc", ".login", ".logout", ".envrc", ".xprofile", ".xinitrc", ".xsession", ".xsessionrc", ".inputrc", "bashrc", "zshrc", "profile", "bash_profile", "PKGBUILD", "APKBUILD", "gradlew", "mvnw", "configure", ".shellcheckrc", ".tmux.conf"],
  },
  { id: "yaml", scope: "source.yaml", extensions: [".cff", ".yaml-tmlanguage", ".sublime-syntax", ".mir", ".reek", ".rviz", ".syntax", ".eyaml", ".eyml"], filenames: [".clang-format", ".clang-tidy", ".clangd", ".gemrc", ".condarc", ".yamllint", "CITATION.cff", ".gitlab-ci.yml", "pubspec.lock", ".kitchen.yml"] },
  { id: "xml", scope: "text.xml", extensions: [".xib", ".storyboard", ".plist", ".resx", ".nuspec", ".vbproj", ".fsproj", ".vcxproj", ".pom", ".xliff", ".xlf", ".kml", ".gpx", ".rss", ".atom", ".tld", ".jrxml", ".fxml", ".iml", ".mxml", ".launch", ".urdf", ".xacro", ".manifest", ".wsdl", ".xproj", ".adml", ".admx", ".ant", ".axml", ".builds", ".ccxml", ".clixml", ".cproject", ".dita", ".ditamap", ".ditaval", ".glade", ".grxml", ".jelly", ".ncl", ".nproj", ".osm", ".pluginspec", ".proj", ".pt", ".rdf", ".scxml", ".srdf", ".sublime-snippet", ".tmcommand", ".tml", ".tmlanguage", ".tmpreferences", ".tmsnippet", ".tmtheme", ".ui", ".ux", ".vxml", ".wixproj", ".wsf", ".x3d", ".xmi", ".xmp", ".xspec", ".xul", ".zcml"], filenames: [".classpath", ".project", ".cproject", "pom.xml", "App.config", "Web.config", "packages.config", "NuGet.Config"] },
  { id: "ini", scope: "source.ini", extensions: [".cfg", ".conf", ".prefs", ".directory", ".gitmodules", ".repo", ".url", ".inf", ".npmrc", ".editorconfig"], filenames: [".npmrc", ".yarnrc", ".pypirc", ".pylintrc", "pylintrc", ".flake8", ".coveragerc", ".pep8", ".isort.cfg", ".bumpversion.cfg", "setup.cfg", "tox.ini", "pytest.ini", "mypy.ini", ".mypy.ini", ".gitconfig", "gitconfig", ".hgrc", "hgrc", ".wgetrc", ".s3cfg", ".mailmap", ".buckconfig", ".flowconfig", ".jshintignore", "php.ini", "my.cnf", ".my.cnf", "buildozer.spec"], filenamePatterns: [".git/config", "**/.git/modules/**/config", "*.cnf"] },
  { id: "dockerfile", scope: "source.dockerfile", extensions: [".containerfile"], filenames: ["Containerfile"], filenamePatterns: ["Dockerfile.*", "*.Dockerfile", "Dockerfile-*", "*-Dockerfile", "Containerfile.*", "*.Containerfile"] },
  { id: "go", scope: "source.go" },
  { id: "rust", scope: "source.rust" },
  { id: "kotlin", scope: "source.kotlin", extensions: [".ktm"] },
  { id: "csharp", scope: "source.cs" },
  {
    id: "ruby",
    scope: "source.ruby",
    extensions: [".rake", ".ru", ".podspec", ".thor", ".jbuilder", ".rabl", ".builder", ".irbrc", ".god", ".mspec", ".pluginspec", ".rbuild", ".rbw", ".ruby", ".watchr", ".arb", ".prawn", ".rbi"],
    filenames: ["Vagrantfile", "Podfile", "Rakefile", "Gemfile", "Guardfile", "Fastfile", "Appfile", "Matchfile", "Pluginfile", "Scanfile", "Snapfile", "Gymfile", "Deliverfile", "Brewfile", "Capfile", "Dangerfile", "Berksfile", "Thorfile", "Steepfile", "Cheffile", "Puppetfile", "Hobofile", "Jarfile", "Mavenfile", "Buildfile", "Lsrcfile", ".irbrc", ".pryrc", ".simplecov", ".gemspec", "config.ru", ".rspec_parallel", "Gemfile.lock"],
  },
  { id: "lua", scope: "source.lua", extensions: [".luacheckrc", ".rockspec", ".nse", ".p8", ".wlua"], filenames: [".luacheckrc"] },
  { id: "r", scope: "source.r", extensions: [".rd", ".rsx"], filenames: [".Rprofile", ".Renviron"] },
  { id: "bat", scope: "source.batchfile" },
  { id: "powershell", scope: "source.powershell", extensions: [".pssc", ".psrc", ".ps1xml"] },
  { id: "swift", scope: "source.swift" },
  { id: "dart", scope: "source.dart" },
  { id: "graphql", scope: "source.graphql", extensions: [".graphqls"] },
  { id: "abap", scope: "source.abap" },
  { id: "apex", scope: "source.apex", extensions: [".trigger"] },
  { id: "bicep", scope: "source.bicep", extensions: [".bicepparam"] },
  { id: "clojure", scope: "source.clojure", extensions: [".cljx", ".clojure", ".boot", ".bb", ".joke"], filenames: ["project.clj", "deps.edn", "bb.edn", "build.boot"] },
  { id: "coffeescript", scope: "source.coffee", extensions: [".cson", ".iced", "._coffee", ".cake", ".cjsx"], filenames: ["Cakefile"] },
  { id: "cypher", scope: "source.cypher" },
  { id: "elixir", scope: "source.elixir", filenames: ["mix.lock"] },
  { id: "fsharp", scope: "source.fsharp" },
  { id: "handlebars", scope: "text.html.handlebars", extensions: [".mustache", ".hjs"] },
  { id: "hcl", scope: "source.hcl", extensions: [".nomad", ".workflow"], filenames: [".terraformrc", "terraform.rc"] },
  { id: "julia", scope: "source.julia" },
  { id: "liquid", scope: "text.html.liquid" },
  { id: "mdx", scope: "source.mdx" },
  { id: "msdax", scope: "source.dax" },
  { id: "objective-c", scope: "source.objc" },
  { id: "pascal", scope: "source.pascal", extensions: [".dpr", ".lpr", ".dfm", ".lfm"] },
  { id: "perl", scope: "source.perl", extensions: [".pod", ".t", ".psgi", ".cgi", ".fcgi", ".perl", ".ph", ".plx", ".al"], filenames: ["cpanfile", "Makefile.PL", "Rexfile", "ack", ".latexmkrc", "latexmkrc"] },
  { id: "powerquery", scope: "source.powerquery" },
  { id: "proto", scope: "source.proto", extensions: [".proto3", ".textproto", ".pbtxt"] },
  { id: "pug", scope: "text.pug" },
  { id: "razor", scope: "text.aspnetcorerazor", extensions: [".razor"] },
  { id: "restructuredtext", scope: "source.rst", extensions: [".rest.txt", ".rst.txt"] },
  { id: "scala", scope: "source.scala", extensions: [".mill", ".kojo"] },
  { id: "scheme", scope: "source.scheme", extensions: [".sld", ".sls", ".sps"] },
  { id: "sol", scope: "source.solidity" },
  { id: "sparql", scope: "source.sparql", extensions: [".sparql"] },
  { id: "systemverilog", scope: "source.systemverilog" },
  { id: "tcl", scope: "source.tcl", extensions: [".tm", ".tk", ".itk", ".exp"], filenames: ["pkgIndex.tcl"] },
  { id: "twig", scope: "text.html.twig" },
  { id: "typespec", scope: "source.tsp" },
  { id: "vb", scope: "source.asp.vb.net", extensions: [".vbs", ".bas", ".vba", ".brs", ".frm", ".ctl", ".dsr"] },
  { id: "wgsl", scope: "source.wgsl" },

  // Languages Monaco doesn't know (VS Code's ids and file patterns).
  { id: "dotenv", scope: "source.dotenv", extensions: [".env"], filenames: [".env", ".flaskenv"], filenamePatterns: [".env.*", ".env-*", "env.example"], aliases: ["Dotenv", "dotenv", "env"] },
  {
    id: "ignore",
    scope: "source.ignore",
    extensions: [".gitignore", ".gitignore_global", ".git-blame-ignore-revs", ".dockerignore", ".npmignore", ".eslintignore", ".prettierignore", ".stylelintignore", ".vscodeignore", ".hgignore", ".slugignore", ".gcloudignore", ".helmignore", ".cfignore", ".ignore", ".rgignore", ".fdignore", ".tfignore", ".vercelignore", ".nowignore", ".bzrignore", ".cvsignore", ".chefignore", ".clang-format-ignore", ".containerignore", ".markdownlintignore", ".nodemonignore", ".atomignore", ".coffeelintignore", ".gitkeep-ignore", ".ebignore", ".funcignore", ".pmignore", ".sonarcloudignore", ".swiftlintignore"],
    filenamePatterns: [".git/info/exclude"],
    aliases: ["Ignore", "ignore"],
  },
  { id: "gitattributes", scope: "source.gitattributes", filenames: [".gitattributes"], filenamePatterns: [".git/info/attributes", "*.gitattributes"], aliases: ["Git Attributes", "gitattributes"] },
  { id: "pip-requirements", scope: "source.pip-requirements", extensions: [".pip"], filenamePatterns: ["requirements*.txt", "*requirements.txt", "*-requirements*.txt", "constraints*.txt", "requirements/*.txt", "requirements/*.in", "requirements*.in"], aliases: ["pip requirements", "requirements.txt"] },
  { id: "go.mod", scope: "source.gomod", filenames: ["go.mod", "go.work", "gopls.mod"], aliases: ["Go Module File", "go.mod"] },
  { id: "go.sum", scope: "source.gomod", filenames: ["go.sum", "go.work.sum"], aliases: ["Go Checksum File", "go.sum"] },
  { id: "crontab", scope: "source.crontab", extensions: [".cron", ".crontab"], filenames: ["crontab", "anacrontab"], filenamePatterns: ["cron.d/*"], aliases: ["crontab", "Cron"] },
  { id: "toml", scope: "source.toml", extensions: [".toml"], filenames: ["Cargo.lock", "Pipfile", "poetry.lock", "uv.lock", "pdm.lock", "Gopkg.lock", "pixi.lock", "rustfmt.toml"], filenamePatterns: [".cargo/config"], aliases: ["TOML", "toml"] },
  { id: "diff", scope: "source.diff", extensions: [".diff", ".patch", ".rej"], aliases: ["Diff", "diff"] },
  { id: "log", scope: "text.log", extensions: [".log"], filenamePatterns: ["*.log.*", "npm-debug.log*", "yarn-error.log*"], aliases: ["Log", "log"] },
  { id: "makefile", scope: "source.makefile", extensions: [".mk", ".mak", ".make"], filenames: ["Makefile", "makefile", "GNUmakefile", "BSDmakefile", "OCamlMakefile", "Kbuild", "Makefile.am", "Makefile.in", "Makefile.inc", "Makefile.boot", "Makefile.frag"], filenamePatterns: ["Makefile.*"], aliases: ["Makefile", "makefile"] },
  { id: "csv", scope: "text.csv", extensions: [".csv", ".psv"], aliases: ["CSV", "csv"] },
  { id: "tsv", scope: "text.tsv", extensions: [".tsv", ".tab"], aliases: ["TSV", "tsv"] },
  { id: "git-commit", scope: "text.git-commit", filenames: ["COMMIT_EDITMSG", "MERGE_MSG", "TAG_EDITMSG", "NOTES_EDITMSG", "EDIT_DESCRIPTION"], aliases: ["Git Commit Message", "git-commit"] },
  { id: "git-rebase", scope: "text.git-rebase", filenames: ["git-rebase-todo"], aliases: ["Git Rebase Message", "git-rebase"] },
  {
    id: "jsonc",
    scope: "source.json.comments",
    extensions: [".jsonc", ".code-workspace", ".code-snippets", ".code-profile", ".code-search", ".color-theme.json", ".icon-theme.json", ".sublime-settings", ".sublime-project", ".sublime-commands", ".sublime-keymap", ".sublime-menu", ".sublime-build", ".sublime-macro", ".sublime-completions", ".jscsrc", ".jshintrc", ".jsbeautifyrc"],
    filenames: ["tsconfig.json", "jsconfig.json", ".eslintrc", ".eslintrc.json", ".babelrc", ".babelrc.json", ".swcrc", ".jshintrc", ".jscsrc", ".jsbeautifyrc", ".devcontainer.json", "devcontainer.json", "language-configuration.json", "typedoc.json", "api-extractor.json", "bun.lock", "tslint.json", ".oxlintrc.json", "biome.json", "deno.json", "turbo.json", "nest-cli.json", "angular.json", ".ember-cli"],
    filenamePatterns: ["tsconfig.*.json", "tsconfig-*.json", "jsconfig.*.json", "jsconfig-*.json", ".vscode/*.json", ".devcontainer/*.json", ".tmcode/*.json", "*.code-workspace"],
    aliases: ["JSON with Comments", "jsonc"],
  },
  { id: "json5", scope: "source.json5", extensions: [".json5"], filenames: [".babelrc.json5", "renovate.json5"], aliases: ["JSON5", "json5"] },
  { id: "jsonl", scope: "source.json.lines", extensions: [".jsonl", ".ndjson", ".jsonlines"], aliases: ["JSON Lines", "jsonl"] },
  { id: "hjson", scope: "source.hjson", extensions: [".hjson"], aliases: ["Hjson", "hjson"] },
  { id: "jsonnet", scope: "source.jsonnet", extensions: [".jsonnet", ".libsonnet"], aliases: ["Jsonnet", "jsonnet"] },
  { id: "terraform", scope: "source.hcl.terraform", extensions: [".tf", ".tfvars", ".tfbackend", ".tftest.hcl", ".tfmock.hcl", ".tofu"], aliases: ["Terraform", "terraform"] },
  { id: "http", scope: "source.http", extensions: [".http", ".rest"], aliases: ["HTTP", "http"] },
  { id: "hurl", scope: "source.hurl", extensions: [".hurl"], aliases: ["Hurl", "hurl"] },
  { id: "nginx", scope: "source.nginx", extensions: [".nginx", ".nginxconf"], filenames: ["nginx.conf", "fastcgi_params", "uwsgi_params", "scgi_params", "proxy_params"], filenamePatterns: ["nginx*.conf", "*.nginx.conf", "nginx/*.conf", "nginx/**/*.conf", "sites-available/*", "sites-enabled/*"], aliases: ["Nginx", "nginx"] },
  { id: "apacheconf", scope: "source.apacheconf", extensions: [".htaccess", ".htgroups", ".apacheconf", ".apache2"], filenames: [".htaccess", "httpd.conf", "apache2.conf", "apache.conf", "srm.conf", "access.conf"], filenamePatterns: ["apache2/**/*.conf", "httpd/**/*.conf"], aliases: ["Apache Conf", "apacheconf"] },
  { id: "ssh_config", scope: "source.ssh-config", filenames: ["ssh_config", "sshd_config"], filenamePatterns: [".ssh/config", ".ssh/config.d/*", "ssh/ssh_config.d/*", "ssh/sshd_config.d/*"], aliases: ["SSH Config", "ssh_config"] },
  { id: "systemd", scope: "source.systemd", extensions: [".service", ".socket", ".timer", ".target", ".mount", ".automount", ".slice", ".swap", ".scope", ".network", ".netdev", ".nspawn", ".link"], aliases: ["systemd Unit File", "systemd"] },
  { id: "desktop", scope: "source.desktop", extensions: [".desktop", ".directory.desktop"], aliases: ["Desktop Entry", "desktop"] },
  { id: "codeowners", scope: "text.codeowners", filenames: ["CODEOWNERS", "OWNERS"], aliases: ["CODEOWNERS", "codeowners"] },
  { id: "cmake", scope: "source.cmake", extensions: [".cmake", ".cmake.in"], filenames: ["CMakeLists.txt"], aliases: ["CMake", "cmake"] },
  { id: "groovy", scope: "source.groovy", extensions: [".groovy", ".gvy", ".gy", ".gsh", ".gradle", ".jenkinsfile", ".nf.groovy"], filenames: ["Jenkinsfile"], filenamePatterns: ["Jenkinsfile*", "*.Jenkinsfile"], aliases: ["Groovy", "groovy"] },
  { id: "nextflow", scope: "source.nextflow", extensions: [".nf"], filenames: ["nextflow.config"], aliases: ["Nextflow", "nextflow"] },
  { id: "just", scope: "source.just", extensions: [".just"], filenames: ["justfile", ".justfile"], aliases: ["Just", "just"] },
  { id: "prisma", scope: "source.prisma", extensions: [".prisma"], aliases: ["Prisma", "prisma"] },
  { id: "vue", scope: "text.html.vue", extensions: [".vue"], aliases: ["Vue", "vue"] },
  { id: "svelte", scope: "source.svelte", extensions: [".svelte"], aliases: ["Svelte", "svelte"] },
  { id: "astro", scope: "source.astro", extensions: [".astro"], aliases: ["Astro", "astro"] },
  { id: "mdc", scope: "text.markdown.mdc.standalone", extensions: [".mdc"], aliases: ["MDC", "mdc"] },
  { id: "blade", scope: "text.html.php.blade", extensions: [".blade.php", ".blade"], aliases: ["Blade", "blade"] },
  { id: "jinja", scope: "source.jinja", extensions: [".j2", ".jinja", ".jinja2", ".nunjucks", ".njk", ".tera"], aliases: ["Jinja", "jinja"] },
  { id: "jinja-html", scope: "text.html.jinja", extensions: [".html.j2", ".html.jinja", ".html.jinja2", ".htm.j2", ".html.njk"], aliases: ["Jinja HTML", "jinja-html"] },
  { id: "edge", scope: "text.html.edge", extensions: [".edge"], aliases: ["Edge", "edge"] },
  { id: "erb", scope: "text.html.erb", extensions: [".erb", ".rhtml", ".html.erb"], aliases: ["ERB", "erb"] },
  { id: "haml", scope: "text.haml", extensions: [".haml"], aliases: ["Haml", "haml"] },
  { id: "marko", scope: "text.marko", extensions: [".marko"], aliases: ["Marko", "marko"] },
  { id: "templ", scope: "source.templ", extensions: [".templ"], aliases: ["Templ", "templ"] },
  { id: "soy", scope: "text.html.soy", extensions: [".soy"], aliases: ["Closure Templates", "soy"] },
  { id: "sass", scope: "source.sass", extensions: [".sass"], aliases: ["Sass (indented)", "sass"] },
  { id: "stylus", scope: "source.stylus", extensions: [".styl", ".stylus"], aliases: ["Stylus", "stylus"] },
  { id: "postcss", scope: "source.css.postcss", extensions: [".pcss", ".postcss", ".sss"], aliases: ["PostCSS", "postcss"] },
  { id: "qss", scope: "source.qss", extensions: [".qss"], aliases: ["Qt Style Sheets", "qss"] },
  { id: "glsl", scope: "source.glsl", extensions: [".glsl", ".vert", ".frag", ".geom", ".comp", ".tesc", ".tese", ".rgen", ".rchit", ".rmiss", ".mesh", ".task", ".glslv", ".glslf", ".vsh", ".fsh", ".gsh"], aliases: ["GLSL", "glsl"] },
  { id: "hlsl", scope: "source.hlsl", extensions: [".hlsl", ".hlsli", ".fx", ".fxh", ".psh", ".cginc", ".compute"], aliases: ["HLSL", "hlsl"] },
  { id: "shaderlab", scope: "source.shaderlab", extensions: [".shader"], aliases: ["ShaderLab", "shaderlab"] },
  { id: "gdscript", scope: "source.gdscript", extensions: [".gd"], aliases: ["GDScript", "gdscript"] },
  { id: "gdshader", scope: "source.gdshader", extensions: [".gdshader", ".gdshaderinc"], aliases: ["Godot Shader", "gdshader"] },
  { id: "gdresource", scope: "source.gdresource", extensions: [".tscn", ".tres", ".godot", ".gdextension", ".import"], aliases: ["Godot Resource", "gdresource"] },
  { id: "haskell", scope: "source.haskell", extensions: [".hs", ".hs-boot", ".hsig", ".lhs"], aliases: ["Haskell", "haskell"] },
  { id: "purescript", scope: "source.purescript", extensions: [".purs"], aliases: ["PureScript", "purescript"] },
  { id: "elm", scope: "source.elm", extensions: [".elm"], aliases: ["Elm", "elm"] },
  { id: "erlang", scope: "source.erlang", extensions: [".erl", ".hrl", ".escript", ".app.src", ".xrl", ".yrl"], filenames: ["rebar.config", "rebar.lock", "sys.config", "Emakefile"], aliases: ["Erlang", "erlang"] },
  { id: "gleam", scope: "source.gleam", extensions: [".gleam"], aliases: ["Gleam", "gleam"] },
  { id: "ocaml", scope: "source.ocaml", extensions: [".ml", ".mli", ".mll", ".mly", ".eliom", ".eliomi"], filenames: [".ocamlinit"], aliases: ["OCaml", "ocaml"] },
  { id: "racket", scope: "source.racket", extensions: [".rkt", ".rktl", ".rktd", ".scrbl"], aliases: ["Racket", "racket"] },
  { id: "commonlisp", scope: "source.commonlisp", extensions: [".lisp", ".lsp", ".asd", ".ros", ".sbclrc"], filenames: [".sbclrc"], aliases: ["Common Lisp", "commonlisp"] },
  { id: "fennel", scope: "source.fnl", extensions: [".fnl"], aliases: ["Fennel", "fennel"] },
  { id: "raku", scope: "source.perl.6", extensions: [".raku", ".rakumod", ".rakutest", ".rakudoc", ".p6", ".pl6", ".pm6", ".nqp"], aliases: ["Raku", "raku"] },
  { id: "objective-cpp", scope: "source.objcpp", extensions: [".mm"], aliases: ["Objective-C++", "objective-cpp"] },
  { id: "zig", scope: "source.zig", extensions: [".zig", ".zon"], aliases: ["Zig", "zig"] },
  { id: "nim", scope: "source.nim", extensions: [".nim", ".nims", ".nimble"], filenames: ["nim.cfg"], aliases: ["Nim", "nim"] },
  { id: "odin", scope: "source.odin", extensions: [".odin"], aliases: ["Odin", "odin"] },
  { id: "d", scope: "source.d", extensions: [".d", ".di"], aliases: ["D", "d"] },
  { id: "crystal", scope: "source.crystal", extensions: [".cr"], aliases: ["Crystal", "crystal"] },
  { id: "vala", scope: "source.vala", extensions: [".vala", ".vapi"], aliases: ["Vala", "vala"] },
  { id: "haxe", scope: "source.hx", extensions: [".hx"], aliases: ["Haxe", "haxe"] },
  { id: "hxml", scope: "source.hxml", extensions: [".hxml"], aliases: ["Haxe Build", "hxml"] },
  { id: "actionscript", scope: "source.actionscript.3", extensions: [".as"], aliases: ["ActionScript", "actionscript"] },
  { id: "mojo", scope: "source.mojo", extensions: [".mojo", ".🔥"], aliases: ["Mojo", "mojo"] },
  { id: "luau", scope: "source.luau", extensions: [".luau"], aliases: ["Luau", "luau"] },
  { id: "fortran-modern", scope: "source.fortran.free", extensions: [".f90", ".f95", ".f03", ".f08", ".f18", ".fpp"], aliases: ["Fortran", "fortran-modern"] },
  { id: "fortran-fixed-form", scope: "source.fortran.fixed", extensions: [".f", ".for", ".f77", ".ftn"], aliases: ["Fortran (fixed form)", "fortran-fixed-form"] },
  { id: "cobol", scope: "source.cobol", extensions: [".cob", ".cbl", ".cobol", ".ccp", ".cobol85"], aliases: ["COBOL", "cobol"] },
  { id: "ada", scope: "source.ada", extensions: [".adb", ".ads", ".ada", ".gpr"], aliases: ["Ada", "ada"] },
  { id: "verilog", scope: "source.verilog", extensions: [".v", ".vh", ".veo"], aliases: ["Verilog", "verilog"] },
  { id: "vhdl", scope: "source.vhdl", extensions: [".vhd", ".vhdl", ".vho", ".vht"], aliases: ["VHDL", "vhdl"] },
  { id: "asm", scope: "source.asm.x86_64", extensions: [".asm", ".nasm", ".yasm", ".s", ".a51"], aliases: ["Assembly", "asm"] },
  { id: "riscv", scope: "source.riscv", extensions: [".riscv"], aliases: ["RISC-V Assembly", "riscv"] },
  { id: "llvm", scope: "source.llvm", extensions: [".ll"], aliases: ["LLVM IR", "llvm"] },
  { id: "wasm", scope: "source.wat", extensions: [".wat", ".wast"], aliases: ["WebAssembly Text", "wasm"] },
  { id: "vyper", scope: "source.vyper", extensions: [".vy"], aliases: ["Vyper", "vyper"] },
  { id: "cairo", scope: "source.cairo0", extensions: [".cairo"], aliases: ["Cairo", "cairo"] },
  { id: "move", scope: "source.move", extensions: [".move"], aliases: ["Move", "move"] },
  { id: "nix", scope: "source.nix", extensions: [".nix"], aliases: ["Nix", "nix"] },
  { id: "latex", scope: "text.tex.latex", extensions: [".tex", ".ltx", ".sty", ".ctx", ".dtx", ".ins", ".latex"], aliases: ["LaTeX", "latex"] },
  { id: "tex", scope: "text.tex", extensions: [".bbx", ".cbx", ".texi"], aliases: ["TeX", "tex"] },
  { id: "bibtex", scope: "text.bibtex", extensions: [".bib", ".bibtex"], aliases: ["BibTeX", "bibtex"] },
  { id: "typst", scope: "source.typst", extensions: [".typ"], aliases: ["Typst", "typst"] },
  { id: "asciidoc", scope: "text.asciidoc", extensions: [".adoc", ".asciidoc", ".asc", ".ad"], aliases: ["AsciiDoc", "asciidoc"] },
  { id: "org", scope: "source.org", extensions: [".org"], aliases: ["Org", "org"] },
  { id: "wikitext", scope: "source.wikitext", extensions: [".wiki", ".mediawiki", ".wikitext"], aliases: ["Wikitext", "wikitext"] },
  { id: "po", scope: "source.po", extensions: [".po", ".pot"], aliases: ["Gettext PO", "po"] },
  { id: "fish", scope: "source.fish", extensions: [".fish"], aliases: ["Fish", "fish"] },
  { id: "nushell", scope: "source.nushell", extensions: [".nu"], aliases: ["Nushell", "nushell"] },
  { id: "awk", scope: "source.awk", extensions: [".awk", ".gawk", ".mawk", ".nawk"], aliases: ["AWK", "awk"] },
  { id: "viml", scope: "source.viml", extensions: [".vim", ".vimrc", ".gvimrc", ".vba.vim"], filenames: [".vimrc", "_vimrc", ".gvimrc", "_gvimrc", ".exrc", "vimrc", "gvimrc", ".ideavimrc", ".nvimrc"], aliases: ["Vim Script", "viml"] },
  { id: "applescript", scope: "source.applescript", extensions: [".applescript"], aliases: ["AppleScript", "applescript"] },
  { id: "ahk", scope: "source.ahk", extensions: [".ahk", ".ahkl"], aliases: ["AutoHotkey", "ahk"] },
  { id: "reg", scope: "source.reg", extensions: [".reg"], aliases: ["Windows Registry", "reg"] },
  { id: "nsis", scope: "source.nsis", extensions: [".nsi", ".nsh"], aliases: ["NSIS", "nsis"] },
  { id: "gn", scope: "source.gn", extensions: [".gn", ".gni"], aliases: ["GN", "gn"] },
  { id: "gnuplot", scope: "source.gnuplot", extensions: [".gp", ".gnuplot", ".gnu", ".plot", ".plt"], aliases: ["Gnuplot", "gnuplot"] },
  { id: "stata", scope: "source.stata", extensions: [".do", ".ado", ".doh", ".ihlp", ".mata", ".matah", ".sthlp"], aliases: ["Stata", "stata"] },
  { id: "sas", scope: "source.sas", extensions: [".sas"], aliases: ["SAS", "sas"] },
  { id: "openscad", scope: "source.scad", extensions: [".scad"], aliases: ["OpenSCAD", "openscad"] },
  { id: "beancount", scope: "text.beancount", extensions: [".beancount", ".bean"], aliases: ["Beancount", "beancount"] },
  { id: "feature", scope: "text.gherkin.feature", extensions: [".feature"], aliases: ["Gherkin", "feature"] },
  { id: "cue", scope: "source.cue", extensions: [".cue"], aliases: ["CUE", "cue"] },
  { id: "kdl", scope: "source.kdl", extensions: [".kdl"], aliases: ["KDL", "kdl"] },
  { id: "ron", scope: "source.ron", extensions: [".ron"], aliases: ["RON", "ron"] },
  { id: "smithy", scope: "source.smithy", extensions: [".smithy"], aliases: ["Smithy", "smithy"] },
  { id: "surrealql", scope: "source.surrealql", extensions: [".surql"], aliases: ["SurrealQL", "surrealql"] },
  { id: "turtle", scope: "source.turtle", extensions: [".ttl", ".n3", ".trig"], aliases: ["Turtle", "turtle"] },
  { id: "kusto", scope: "source.kusto", extensions: [".kql", ".csl", ".kusto"], aliases: ["Kusto", "kusto"] },
  { id: "plsql", scope: "source.plsql.oracle", extensions: [".pls", ".plb", ".pck", ".pkb", ".pks", ".pkh", ".fnc", ".prc", ".trg", ".vw", ".tps", ".tpb"], aliases: ["PL/SQL", "plsql"] },
  { id: "codeql", scope: "source.ql", extensions: [".ql", ".qll"], aliases: ["CodeQL", "codeql"] },
  { id: "lean", scope: "source.lean4", extensions: [".lean"], aliases: ["Lean 4", "lean"] },
  { id: "qml", scope: "source.qml", extensions: [".qml", ".qbs"], aliases: ["QML", "qml"] },
  { id: "qmldir", scope: "source.qmldir", filenames: ["qmldir"], aliases: ["QML Module Definition", "qmldir"] },
  { id: "rbs", scope: "source.rbs", extensions: [".rbs"], aliases: ["RBS", "rbs"] },
  { id: "imba", scope: "source.imba", extensions: [".imba"], aliases: ["Imba", "imba"] },
  { id: "ballerina", scope: "source.ballerina", extensions: [".bal"], aliases: ["Ballerina", "ballerina"] },
  { id: "chapel", scope: "source.chapel", extensions: [".chpl"], aliases: ["Chapel", "chapel"] },
  { id: "wit", scope: "source.wit", extensions: [".wit"], aliases: ["WIT", "wit"] },
  { id: "apl", scope: "source.apl", extensions: [".apl", ".dyalog", ".aplf", ".apln", ".aplo"], aliases: ["APL", "apl"] },
  { id: "hy", scope: "source.hy", extensions: [".hy"], aliases: ["Hy", "hy"] },
  { id: "moonbit", scope: "source.moonbit", extensions: [".mbt"], aliases: ["MoonBit", "moonbit"] },
  { id: "c3", scope: "source.c3", extensions: [".c3", ".c3i", ".c3t"], aliases: ["C3", "c3"] },
  { id: "zenscript", scope: "source.zenscript", extensions: [".zs"], aliases: ["ZenScript", "zenscript"] },
];

/** Monaco language id → grammar scope. */
const BUILTIN_LANGUAGES: Record<string, string> = Object.fromEntries(LANGUAGES.map((l) => [l.id, l.scope]));

/**
 * Languages TMCode registers with Monaco: new ones (with aliases), and file
 * names added to Monaco's own (no aliases, so Monaco merges them into its entry
 * and Change Language Mode lists the language once).
 */
export const EXTRA_LANGUAGES: { id: string; extensions?: string[]; filenames?: string[]; filenamePatterns?: string[]; aliases?: string[] }[] = LANGUAGES.filter(
  (l) => l.aliases || l.extensions || l.filenames || l.filenamePatterns,
).map(({ id, extensions, filenames, filenamePatterns, aliases }) => ({ id, extensions, filenames, filenamePatterns, aliases }));

const grammars = new Map<string, GrammarDef>(BUILTIN.map((g) => [g.scopeName, g]));
const languages = new Map<string, string>(Object.entries(BUILTIN_LANGUAGES));
let version = 0;

export function grammarFor(scopeName: string): GrammarDef | undefined {
  return grammars.get(scopeName);
}

export function scopeForLanguage(languageId: string): string | undefined {
  return languages.get(languageId);
}

export function tmLanguages(): string[] {
  return [...languages.keys()];
}

/** Scopes whose grammars inject into `scopeName`. */
export function injectionsFor(scopeName: string): string[] {
  const out: string[] = [];
  for (const g of grammars.values()) if (g.injectTo?.includes(scopeName)) out.push(g.scopeName);
  return out;
}

/** Bumps on every change, so the tokenizer knows to start a fresh registry. */
export function grammarsVersion() {
  return version;
}

/**
 * Replaces all extension-contributed grammars (called whenever the enabled
 * extensions change). Built-ins come back when an override is removed.
 */
export function setExtensionGrammars(defs: GrammarDef[], languageScopes: Record<string, string>) {
  for (const [scope, g] of [...grammars]) if (g.extension) grammars.delete(scope);
  for (const g of BUILTIN) if (!grammars.has(g.scopeName)) grammars.set(g.scopeName, g);
  for (const g of defs) grammars.set(g.scopeName, g);
  languages.clear();
  for (const [l, s] of Object.entries(BUILTIN_LANGUAGES)) languages.set(l, s);
  for (const [l, s] of Object.entries(languageScopes)) languages.set(l, s);
  version++;
}

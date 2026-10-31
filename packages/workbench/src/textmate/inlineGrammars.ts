/**
 * Small TextMate grammars TMCode writes itself, for files `tm-grammars` has
 * no (good) grammar for: .env, ignore files, .gitattributes, requirements.txt,
 * go.mod/go.sum and crontab. Standard scope names only, so every theme colours
 * them. Loaded lazily, like the bundled grammars (grammars.ts).
 */

const comment = (scope: string) => ({
  match: "(?:^|(?<=\\s))((#).*)$",
  captures: { 1: { name: `comment.line.number-sign.${scope}` }, 2: { name: `punctuation.definition.comment.${scope}` } },
});

/** `$VAR`, `${VAR}`, `${VAR:-default}` (dotenv-expand, Docker Compose, shells). */
const interpolation = (scope: string) => ({
  patterns: [
    {
      match: "(\\$\\{)([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-=?+])([^}]*))?(\\})",
      name: `meta.interpolation.${scope}`,
      captures: {
        1: { name: `punctuation.definition.template-expression.begin.${scope}` },
        2: { name: `variable.other.env.${scope}` },
        3: { name: `keyword.operator.expansion.${scope}` },
        4: { name: `string.unquoted.default.${scope}` },
        5: { name: `punctuation.definition.template-expression.end.${scope}` },
      },
    },
    {
      match: "(\\$)([A-Za-z_][A-Za-z0-9_]*)",
      name: `meta.interpolation.${scope}`,
      captures: { 1: { name: `punctuation.definition.variable.${scope}` }, 2: { name: `variable.other.env.${scope}` } },
    },
  ],
});

/** A whole value that is a number or a boolean/null word (`PORT=3000`, `DEBUG=true`). */
const VALUE_END = "[\\t ]*(?=$|[\\t ]#)";

/** `.env`, `.env.local`, `*.env`: `[export] KEY=value`, comments, quoted and multi-line values, interpolation. */
export const DOTENV = {
  scopeName: "source.dotenv",
  name: "dotenv",
  patterns: [{ include: "#comment" }, { include: "#assignment" }, { include: "#key-only" }],
  repository: {
    comment: comment("dotenv"),
    assignment: {
      begin: "^[\\t ]*(?:(export)[\\t ]+)?([A-Za-z_][A-Za-z0-9_.\\-]*)[\\t ]*(=|:(?=[\\t ]))",
      beginCaptures: {
        1: { name: "storage.modifier.export.dotenv" },
        2: { name: "variable.other.env.dotenv" },
        3: { name: "keyword.operator.assignment.dotenv" },
      },
      end: "$",
      patterns: [
        { match: `\\G[\\t ]*([-+]?(?:0[xX][0-9A-Fa-f]+|[0-9]+(?:\\.[0-9]+)?(?:[eE][-+]?[0-9]+)?))${VALUE_END}`, captures: { 1: { name: "constant.numeric.dotenv" } } },
        { match: `\\G[\\t ]*((?i:true|false|yes|no|on|off|null|none|nil))${VALUE_END}`, captures: { 1: { name: "constant.language.dotenv" } } },
        { include: "#double-quoted" },
        { include: "#single-quoted" },
        { include: "#backtick-quoted" },
        { include: "#comment" },
        { include: "#interpolation" },
        { match: "(?:[^\\s\"'`$#\\\\]|\\\\.|(?<=\\S)#)+", name: "string.unquoted.dotenv" },
      ],
    },
    "key-only": { match: "^[\\t ]*(?:(export)[\\t ]+)?([A-Za-z_][A-Za-z0-9_.\\-]*)[\\t ]*$", captures: { 1: { name: "storage.modifier.export.dotenv" }, 2: { name: "variable.other.env.dotenv" } } },
    "double-quoted": {
      begin: '"',
      beginCaptures: { 0: { name: "punctuation.definition.string.begin.dotenv" } },
      end: '"',
      endCaptures: { 0: { name: "punctuation.definition.string.end.dotenv" } },
      name: "string.quoted.double.dotenv",
      patterns: [{ match: "\\\\(?:[\"'\\\\$bfnrtv]|u[0-9A-Fa-f]{4}|\\n)", name: "constant.character.escape.dotenv" }, { include: "#interpolation" }],
    },
    "single-quoted": {
      begin: "'",
      beginCaptures: { 0: { name: "punctuation.definition.string.begin.dotenv" } },
      end: "'",
      endCaptures: { 0: { name: "punctuation.definition.string.end.dotenv" } },
      name: "string.quoted.single.dotenv",
    },
    "backtick-quoted": {
      begin: "`",
      beginCaptures: { 0: { name: "punctuation.definition.string.begin.dotenv" } },
      end: "`",
      endCaptures: { 0: { name: "punctuation.definition.string.end.dotenv" } },
      name: "string.quoted.other.dotenv",
    },
    interpolation: interpolation("dotenv"),
  },
};

/** Glob wildcards, `[a-z]` sets and `\` escapes, shared by ignore files and .gitattributes patterns. */
const glob = (scope: string) => [
  { match: "\\\\.", name: `constant.character.escape.${scope}` },
  { match: "\\*\\*|\\*|\\?", name: `constant.character.wildcard.${scope}` },
  { match: "\\[!?(?:\\\\.|[^\\]])*\\]", name: `constant.character.set.${scope}` },
];

/** .gitignore, .dockerignore, .npmignore, .prettierignore, .eslintignore…: VS Code's `ignore` language. */
export const IGNORE = {
  scopeName: "source.ignore",
  name: "ignore",
  patterns: [
    { match: "^\\s*((#).*)$", captures: { 1: { name: "comment.line.number-sign.ignore" }, 2: { name: "punctuation.definition.comment.ignore" } } },
    {
      begin: "^\\s*(!)?",
      beginCaptures: { 1: { name: "keyword.control.negation.ignore" } },
      end: "$",
      patterns: [...glob("ignore"), { match: "/(?=\\s*$)", name: "punctuation.separator.directory.ignore" }, { match: "[^\\\\*?\\[\\s]+", name: "string.unquoted.path.ignore" }],
    },
  ],
};

/** .gitattributes: a pattern, then attributes (`text`, `-diff`, `!merge`, `eol=lf`). */
export const GITATTRIBUTES = {
  scopeName: "source.gitattributes",
  name: "gitattributes",
  patterns: [
    { match: "^\\s*((#).*)$", captures: { 1: { name: "comment.line.number-sign.gitattributes" }, 2: { name: "punctuation.definition.comment.gitattributes" } } },
    {
      begin: "^\\s*(?=\\S)",
      end: "$",
      patterns: [
        { begin: "\\G", end: "(?=\\s|$)", name: "string.unquoted.pattern.gitattributes", patterns: glob("gitattributes") },
        {
          match: "(?<=\\s)([-!])?([A-Za-z0-9_.\\-]+)(?:(=)(\\S+))?",
          captures: {
            1: { name: "keyword.control.negation.gitattributes" },
            2: { name: "support.type.property-name.gitattributes" },
            3: { name: "keyword.operator.assignment.gitattributes" },
            4: { name: "constant.language.gitattributes" },
          },
        },
      ],
    },
  ],
};

/** requirements.txt / constraints.txt (pip): packages, extras, version specifiers, markers, options, URLs. */
export const PIP_REQUIREMENTS = {
  scopeName: "source.pip-requirements",
  name: "pip-requirements",
  patterns: [
    comment("pip-requirements"),
    {
      begin: "^\\s*(-{1,2}[A-Za-z][\\w-]*)",
      beginCaptures: { 1: { name: "constant.other.option.pip-requirements" } },
      end: "(?=\\s#)|$",
      patterns: [{ include: "#interpolation" }, { match: "[^\\s$]+", name: "string.unquoted.path.pip-requirements" }],
    },
    {
      begin: "^\\s*([A-Za-z0-9][A-Za-z0-9._-]*)",
      beginCaptures: { 1: { name: "entity.name.type.package.pip-requirements" } },
      end: "(?=\\s#)|$",
      patterns: [
        { begin: "\\[", end: "\\]", beginCaptures: { 0: { name: "punctuation.definition.extras.begin.pip-requirements" } }, endCaptures: { 0: { name: "punctuation.definition.extras.end.pip-requirements" } }, patterns: [{ match: "[A-Za-z0-9._-]+", name: "variable.parameter.extra.pip-requirements" }, { match: ",", name: "punctuation.separator.pip-requirements" }] },
        { match: "===|==|!=|~=|<=|>=|<|>", name: "keyword.operator.comparison.pip-requirements" },
        { match: "(@)\\s*(\\S+)", captures: { 1: { name: "keyword.operator.at.pip-requirements" }, 2: { name: "markup.underline.link.pip-requirements" } } },
        { match: ";", name: "punctuation.separator.marker.pip-requirements" },
        { match: "\\b(?:python_version|python_full_version|os_name|sys_platform|platform_release|platform_system|platform_version|platform_machine|platform_python_implementation|implementation_name|implementation_version|extra)\\b", name: "support.variable.marker.pip-requirements" },
        { match: "\\b(?:and|or|not|in)\\b", name: "keyword.other.logical.pip-requirements" },
        { match: "\"[^\"]*\"|'[^']*'", name: "string.quoted.pip-requirements" },
        { match: "(?:[0-9]+!)?[0-9]+(?:\\.(?:[0-9]+|\\*))*(?:[a-zA-Z]+[0-9]*)?(?:\\.?(?:post|dev)[0-9]*)?(?:\\+[A-Za-z0-9.]+)?", name: "constant.numeric.version.pip-requirements" },
        { match: ",", name: "punctuation.separator.pip-requirements" },
        { include: "#interpolation" },
      ],
    },
  ],
  repository: { interpolation: interpolation("pip-requirements") },
};

/** go.mod, go.work and go.sum: directives, module paths, versions, checksums. */
export const GO_MOD = {
  scopeName: "source.gomod",
  name: "go.mod",
  patterns: [
    { match: "(//).*$", name: "comment.line.double-slash.gomod", captures: { 1: { name: "punctuation.definition.comment.gomod" } } },
    { match: "^\\s*(module|go|toolchain|require|replace|exclude|retract|use|godebug|tool|ignore)\\b", captures: { 1: { name: "keyword.other.directive.gomod" } } },
    { match: "=>", name: "keyword.operator.replace.gomod" },
    { match: "[()\\[\\],]", name: "punctuation.section.gomod" },
    { match: "\\bh1:[A-Za-z0-9+/]+=*", name: "string.unquoted.checksum.gomod" },
    { match: "\\bv[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.\\-]+)?(?:\\+[0-9A-Za-z.\\-]+)?(?:/go\\.mod)?", name: "constant.numeric.version.gomod" },
    { match: "(?<=\\s)(?:go|toolchain\\s+go)?[0-9]+\\.[0-9]+(?:\\.[0-9]+)?(?:(?:rc|beta)[0-9]+)?\\b", name: "constant.numeric.version.gomod" },
    { match: "\\.{1,2}/\\S*|/\\S+", name: "string.unquoted.path.gomod" },
    { match: "\"(?:\\\\.|[^\"\\\\])*\"|`[^`]*`", name: "string.quoted.gomod" },
    { match: "[A-Za-z0-9][\\w.\\-~]*(?:/[\\w.\\-~]+)+|[A-Za-z0-9\\-]+(?:\\.[A-Za-z0-9\\-]+)+", name: "entity.name.type.module.gomod" },
    { match: "[A-Za-z_][\\w]*(?==)", name: "variable.other.gomod" },
    { match: "=", name: "keyword.operator.assignment.gomod" },
  ],
};

/** crontab: comments, `VAR=value`, the five schedule fields (or `@daily`), then a shell command. */
export const CRONTAB = {
  scopeName: "source.crontab",
  name: "crontab",
  patterns: [
    { match: "^\\s*((#).*)$", captures: { 1: { name: "comment.line.number-sign.crontab" }, 2: { name: "punctuation.definition.comment.crontab" } } },
    {
      match: "^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*(=)\\s*(.*)$",
      captures: { 1: { name: "variable.other.env.crontab" }, 2: { name: "keyword.operator.assignment.crontab" }, 3: { name: "string.unquoted.crontab" } },
    },
    {
      begin: "^\\s*(@[A-Za-z]+|[\\w*?#/,\\-]+(?:[\\t ]+[\\w*?#/,\\-]+){4})(?=[\\t ]|$)",
      beginCaptures: {
        1: {
          name: "meta.schedule.crontab",
          patterns: [
            { match: "@[A-Za-z]+", name: "keyword.other.schedule.crontab" },
            { match: "\\*", name: "keyword.other.wildcard.crontab" },
            { match: "[0-9]+", name: "constant.numeric.crontab" },
            { match: "(?i)\\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|mon|tue|wed|thu|fri|sat|sun)\\b", name: "constant.language.crontab" },
            { match: "[,/\\-?#LW]", name: "keyword.operator.crontab" },
          ],
        },
      },
      end: "$",
      // The shell grammar only finds a command at the start of a line (or after ; | &), so the first word is named here.
      patterns: [{ match: "\\G[\\t ]+([^\\s;&|<>]+)", captures: { 1: { name: "entity.name.function.command.crontab" } } }, { include: "source.shell" }],
    },
  ],
};

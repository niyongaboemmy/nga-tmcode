import * as monaco from "monaco-editor";

/** .logic files: syntax colours for operators, constants, names and comments. */
let done = false;
export function registerLogicLanguage() {
  if (done) return;
  done = true;
  monaco.languages.register({ id: "logic", extensions: [".logic"], aliases: ["Logic", "logic"] });
  monaco.languages.setLanguageConfiguration("logic", {
    comments: { lineComment: "#" },
    brackets: [["(", ")"]],
    autoClosingPairs: [{ open: "(", close: ")" }],
  });
  monaco.languages.setMonarchTokensProvider("logic", {
    ignoreCase: true,
    tokenizer: {
      root: [
        [/(#|\/\/).*$/, "comment"],
        [/\b(and|or|not|xor|nand|nor|implies|iff|eqv)\b/, "keyword"],
        [/\b(true|false|T|F|0|1)\b/, "number"],
        [/^\s*[A-Za-z_]\w*(?=\s*(:=|=(?!=|>)))/, "type.identifier"],
        [/[A-Za-z_]\w*/, "variable"],
        [/<->|<=>|->|=>|&&|\|\||[&|!~^+*·∧∨¬⊕→↔⇒⇔↑↓≡≠]|==|!=/, "operator"],
        [/:=|=/, "delimiter"],
        [/[()]/, "@brackets"],
      ],
    },
  });
}

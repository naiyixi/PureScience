// Pure kernel-variable suggestion logic, shared by the terminal input UI and its focused tests.
// Kept out of NotebookPreview.tsx so the component file only exports components (react-refresh).

const variableSuggestionPattern = /^[A-Za-z_]/u

// Matches live kernel variable names against the current token prefix (the last whitespace/
// punctuation-delimited token starting with a letter or underscore). Returns up to 8 matches.
export const suggestVariableNames = (code: string, variableNames: readonly string[]): string[] => {
  const currentToken = code.split(/[\s()[\].,;:]/).at(-1) ?? ''
  if (!variableSuggestionPattern.test(currentToken) || currentToken.length < 1) return []
  const prefix = currentToken.toLowerCase()
  return variableNames.filter((name) => name.toLowerCase().startsWith(prefix)).slice(0, 8)
}

// True when the trailing token of `code` looks like a variable reference (letter/underscore start),
// which is the only context where live variable suggestions apply.
export const isVariableToken = (code: string): boolean => {
  const currentToken = code.split(/[\s()[\].,;:]/).at(-1) ?? ''
  return variableSuggestionPattern.test(currentToken) && currentToken.length >= 1
}

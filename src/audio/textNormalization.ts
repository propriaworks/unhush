// Transcription models -- and the LLM formatting pass more so -- emit typographic punctuation
// where the user would have typed ASCII: curly quotes, en/em dashes, a single-character ellipsis.
// Normalizing it serves two ends. Dictation into terminals, code and commit messages want ASCII,
// and it helps keep ordinary English transcripts on the "type" output path, which can only emit
// ASCII.
//
// Applied to the finished transcript, after any LLM pass and before the text is handed to the
// main process, so every output method sees the same characters. What lands in the target app
// must not depend on which of paste/type/clipboard is selected.
//
// Deliberately limited to characters that are typographic variants of ASCII punctuation.
// Language-specific quotation marks (guillemets, German low quotes) and symbols with no clean
// equivalent are left alone: there is no ASCII spelling of EUR, degree or multiplication that
// isn't an invention, and transliterating scripts outright would replace the user's text rather
// than tidy it. Whatever survives this is handled by falling back to a clipboard paste.
const PUNCTUATION_REPLACEMENTS: Record<string, string> = {
  "‘": "'",  "’": "'",                    // left/right single quotation marks
  "“": '"',  "”": '"',                    // left/right double quotation marks
  "′": "'",  "″": '"',                    // prime, double prime (feet/inches, minutes/seconds)
  "‐": "-",  "‑": "-",                    // hyphen, non-breaking hyphen
  "–": "-",  "−": "-",                    // en dash, minus sign
  "—": "--", "―": "--",                   // em dash, horizontal bar
  "…": "...",                                  // horizontal ellipsis
  " ": " ",  " ": " ", " ": " ",     // no-break, thin and narrow no-break spaces
  "​": "",   "﻿": "",                     // zero-width space, byte-order mark
};

// None of the keys are regex metacharacters, so they can go into a character class as they are.
const PUNCTUATION_PATTERN = new RegExp(`[${Object.keys(PUNCTUATION_REPLACEMENTS).join("")}]`, "g");

/** Replaces typographic punctuation with its ASCII equivalent, leaving everything else intact. */
export function normalizePunctuation(text: string): string {
  return text.replace(PUNCTUATION_PATTERN, (character) => PUNCTUATION_REPLACEMENTS[character]);
}

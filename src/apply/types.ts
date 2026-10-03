export type FieldKind = "text" | "textarea" | "select" | "radio" | "checkbox" | "file" | "combobox";

/** One answerable control (or radio/button group) found on an application form. */
export interface FormField {
  /** Value of the data-ja-id attribute the scanner put on the element(s). */
  id: string;
  kind: FieldKind;
  label: string;
  required: boolean;
  /** select / radio / combobox option labels. */
  options: string[];
  /** HTML input type (email, tel, number...), "buttons" for Yes/No button pairs. */
  inputType: string;
  name: string;
}

export type Decision =
  | { kind: "value"; value: string; source: "profile" | "custom" | "llm" | "default" }
  | { kind: "file"; which: "resume" | "cover_letter" }
  | { kind: "cover_letter_text" }
  | { kind: "consent" }
  /** Optional field we deliberately leave empty. */
  | { kind: "skip"; reason: string }
  /** Required field we refuse to guess: the application must go to a human. */
  | { kind: "unresolved"; reason: string }
  /** Not decided by a rule; goes to the LLM (only ever for non-sensitive fields). */
  | { kind: "ask_llm" };

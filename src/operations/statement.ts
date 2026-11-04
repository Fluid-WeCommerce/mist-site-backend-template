import { invalidStatement } from "../errors.js";

// sql.run takes only schema forms that cannot read or rewrite rows. A statement
// is refused unless it matches one of the forms below, and refused outright if
// it holds any word that reads or writes rows, however it is spelled. Words
// inside string literals are not told apart from code, so a COMMENT text or a
// DEFAULT 'select' is over-refused on purpose.

const IDENT = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*|"[A-Za-z_][A-Za-z0-9_]*")`;
const TABLE = String.raw`(?:(?:public|"public")\.)?${IDENT}`;
const LITERAL = String.raw`(?:'(?:[^']|'')*'|null)`;
const TYPE_AND_REST = String.raw`[A-Za-z_"].*`;

const form = (pattern: string) => new RegExp(`^${pattern}$`, "i");

interface Form {
  tag: string;
  pattern: RegExp;
}

const FORMS: Form[] = [
  { tag: "CREATE TABLE", pattern: form(String.raw`create table (?:if not exists )?${TABLE} ?\(.+\)(?: inherits ?\(${TABLE}\))?`) },
  { tag: "CREATE INDEX", pattern: form(String.raw`create (?:unique )?index (?:if not exists )?${IDENT} on ${TABLE} ?\(.+\)`) },
  { tag: "DROP TABLE", pattern: form(String.raw`drop table (?:if exists )?${TABLE}(?: cascade| restrict)?`) },
  { tag: "DROP INDEX", pattern: form(String.raw`drop index (?:if exists )?${TABLE}(?: cascade| restrict)?`) },
  { tag: "COMMENT", pattern: form(String.raw`comment on (?:table ${TABLE}|column ${TABLE}\.${IDENT}) is ${LITERAL}`) },
  ...[
    String.raw`add column (?:if not exists )?${IDENT} ${TYPE_AND_REST}`,
    String.raw`drop column (?:if exists )?${IDENT}(?: cascade| restrict)?`,
    String.raw`rename column ${IDENT} to ${IDENT}`,
    String.raw`rename to ${IDENT}`,
    String.raw`add constraint ${IDENT} (?:check|foreign key|unique|primary key)\b.*`,
    String.raw`drop constraint (?:if exists )?${IDENT}(?: cascade| restrict)?`,
    String.raw`alter column ${IDENT} set default .+`,
    String.raw`alter column ${IDENT} drop default`,
    String.raw`alter column ${IDENT} (?:set|drop) not null`,
    String.raw`alter column ${IDENT} (?:set data )?type ${TYPE_AND_REST}`,
  ].map((action) => ({
    tag: "ALTER TABLE",
    pattern: form(String.raw`alter table (?:if exists )?(?:only )?${TABLE} ${action}`),
  })),
];

const FORBIDDEN_WORDS = new RegExp(
  String.raw`\b(select|insert|update|delete|merge|copy|using|with|do|truncate|vacuum|reindex|cluster|refresh|grant|revoke|concurrently)\b`,
  "i",
);
// `AS` that introduces a query, or a generated-column expression.
const AS_QUERY = /\bas\s*\(|\bas\s+(?:select|values|table|with)\b/i;
const FORBIDDEN_CREATE =
  /^create (?:or replace )?(?:(?:materialized|temp|temporary|unlogged|global|local|recursive) )*(?:view|function|procedure|trigger|rule|extension|schema|role|policy|sequence|type|domain)\b/i;
const LIKE_CLAUSE = /[(,]\s*like\b/i;

// Phrases that hold a forbidden word but cannot read rows: referential actions
// of a foreign key, and the timestamp types.
const HARMLESS_PHRASES = /\bon\s+(?:delete|update)\b|\bwith(?:out)?\s+time\s+zone\b/gi;

/** A comma outside parentheses and quotes separates the actions of one ALTER TABLE. */
function hasTopLevelComma(text: string): boolean {
  let depth = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (ch === "," && depth === 0) return true;
  }
  return false;
}

/**
 * Checks a trimmed statement (no trailing `;`) against the allowed forms and
 * returns its command tag, or throws 422 `invalid_statement` before anything runs.
 */
export function checkSchemaStatement(statement: string): string {
  if (statement === "") throw invalidStatement("statement is empty");
  if (statement.includes(";")) throw invalidStatement("only one statement is allowed");
  if (/--|\/\*|\*\//.test(statement)) throw invalidStatement("comments are not allowed in a statement");
  if (statement.includes("$")) throw invalidStatement("dollar-quoted text is not allowed in a statement");

  const text = statement.replace(/\s+/g, " ");
  const bare = text.replace(HARMLESS_PHRASES, " ");

  const word = FORBIDDEN_WORDS.exec(bare)?.[1];
  if (word) throw invalidStatement(`"${word.toLowerCase()}" is not allowed in a schema statement`);
  if (AS_QUERY.test(bare)) throw invalidStatement("AS with a query or expression is not allowed");
  if (FORBIDDEN_CREATE.test(text)) throw invalidStatement("that object type cannot be created here");
  if (/^create table /i.test(text) && LIKE_CLAUSE.test(bare)) {
    throw invalidStatement("LIKE is not allowed in CREATE TABLE");
  }

  if (/^alter table /i.test(text) && hasTopLevelComma(text)) {
    throw invalidStatement("ALTER TABLE takes one action per statement");
  }

  const matched = FORMS.find((f) => f.pattern.test(text));
  if (!matched) {
    throw invalidStatement(
      "statement must be CREATE TABLE, CREATE INDEX, ALTER TABLE (one column or constraint action), DROP TABLE, DROP INDEX or COMMENT ON TABLE or COLUMN",
    );
  }
  return matched.tag;
}

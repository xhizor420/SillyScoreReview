/**
 * What each card field is, told to the model alongside the field itself.
 *
 * A model reading "### mes_example" or "### character_note" has to guess what
 * the field is for and how SillyTavern uses it — and judges it wrongly when it
 * guesses wrong (a greeting critiqued like a description, a Character's Note
 * read as prose, {{user}} taken for a placeholder someone forgot to fill in).
 * So every request says it plainly. This lives in code, in the user message,
 * so it holds whatever the editable instructions say.
 */

const ROLES = {
  description: 'who the character is: the main reference, sent with every reply',
  personality: 'a personality summary, sent with every reply alongside the description',
  scenario: 'the situation the roleplay starts from, sent with every reply',
  first_mes: 'the opening message: the first thing {{user}} reads, written as the character',
  mes_example: 'example dialogue showing how the character talks and acts; each <START> begins a new example, and {{user}}: lines only prompt the character',
  system_prompt: 'a system prompt that replaces the user\'s own unless it contains {{original}}',
  post_history_instructions: 'instructions inserted after the chat history (replacing the user\'s own unless it contains {{original}}); the strongest influence on each reply',
  alternate_greetings: 'extra opening messages {{user}} can swipe to instead of first_mes, separated by lines of ---',
};

/** One line on what `field` is for, with this card's specifics where they matter. */
export function fieldRole(card, field) {
  if (field === 'character_note') {
    const dp = card?.raw?.data?.extensions?.depth_prompt;
    const depth = Number.isFinite(Number(dp?.depth)) ? Number(dp.depth) : 4;
    return `SillyTavern's Character's Note: an instruction inserted into the chat ${depth} message${depth === 1 ? '' : 's'} from the end, on every reply — direction to the model, not prose`;
  }
  return ROLES[field] || '';
}

/** "### first_mes — the opening message: …" */
export function fieldHeading(card, field, suffix = '') {
  const role = fieldRole(card, field);
  return `### ${field}${role ? ` — ${role}` : ''}${suffix}`;
}

/** Said once, before the fields: the macros are correct usage, not mistakes. */
export const MACRO_NOTE = 'Macros: SillyTavern replaces {{char}} with the character\'s name and {{user}} with the user\'s name at chat time, and {{original}} with the user\'s own prompt. They are correct usage, not placeholders left unfilled.';

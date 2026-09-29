import assert from 'node:assert/strict';
import test from 'node:test';
import { explicitChatResponseLanguage } from './chat-language.mjs';

const user = content => ({ role: 'user', content });
const french = { code: 'fr', name: 'French' };
const english = { code: 'en', name: 'English' };

test('explicit French preference is found in a mixed project message', () => {
  assert.deepEqual(explicitChatResponseLanguage([user("Réponds en français. J'ai une idée de logiciel pour les professeurs.")]), french);
  assert.deepEqual(explicitChatResponseLanguage([user("J'ai une idée de logiciel. Réponds en français, s'il te plaît.")]), french);
});

test('ordinary French prose and an earlier French assistant reply select no language', () => {
  assert.equal(explicitChatResponseLanguage([
    user("J'ai une idée de logiciel. Aide-moi à commencer."),
    { role: 'assistant', content: 'Réponds en français. Quel problème veux-tu résoudre ?' },
    user('Les annulations chez les professeurs particuliers.'),
  ]), null);
});

test('the last explicit user preference wins and persists through ordinary follow-ups', () => {
  const history = [user('Reply in French.'), { role: 'assistant', content: 'Quel est ton projet ?' }, user('A scheduling tool.')];
  assert.deepEqual(explicitChatResponseLanguage(history), french);
  history.push(user('Switch to English.'));
  assert.deepEqual(explicitChatResponseLanguage(history), english);
  history.push({ role: 'assistant', content: 'Reply in French.' });
  assert.deepEqual(explicitChatResponseLanguage(history), english);
});

test('the last direct preference within one message wins', () => {
  assert.deepEqual(explicitChatResponseLanguage([user('Reply in French. Please continue in English.')]), english);
  assert.deepEqual(explicitChatResponseLanguage([user('Respond in English; réponds en français.')]), french);
});

for (const content of [
  'Please respond in French.', 'Can you please answer in French?',
  'Could you reply in French, please?', 'Would you speak French?',
  'Peux-tu répondre en français ?', 'Pourriez-vous parler en français ?',
  "S'il te plaît, continue en français.", 'Écris en français.',
  'Répondez en français.', 'Réponds-moi en français.',
]) {
  test(`recognizes direct polite request: ${content}`, () => {
    assert.deepEqual(explicitChatResponseLanguage([user(content)]), french);
  });
}

test('English and another supported language use stable English display names', () => {
  assert.deepEqual(explicitChatResponseLanguage([user('Réponds en anglais.')]), english);
  assert.deepEqual(explicitChatResponseLanguage([user('Please write in Spanish.')]), { code: 'es', name: 'Spanish' });
  assert.deepEqual(explicitChatResponseLanguage([user('Continue en espagnol.')]), { code: 'es', name: 'Spanish' });
});

for (const content of [
  'My note says reply in French.',
  'My note says: Reply in French.',
  'My note says:\nReply in French.',
  'My note says "Reply in French. Continue in French."',
  "My note says 'Reply in French.'",
  'Ma note dit « Réponds en français. Continue en français. »',
  'A quote: “Reply in French.”',
  '> Reply in French.\n> Continue in French.',
  '```text\nReply in French.\n```',
  '~~~\nRéponds en français.\n~~~',
  '`Reply in French.`',
]) {
  test(`ignores quoted, attributed, or code content: ${JSON.stringify(content)}`, () => {
    assert.equal(explicitChatResponseLanguage([user(content)]), null);
  });
}

test('quoted preferences do not override a direct preference outside the quote', () => {
  assert.deepEqual(explicitChatResponseLanguage([
    user('Reply in English.'), user('My note says "Reply in French."'),
  ]), english);
  assert.deepEqual(explicitChatResponseLanguage([user('My note says "Reply in English."\nPlease reply in French.')]), french);
});

test('unknown or ambiguous latest requests are left to the model', () => {
  for (const content of ['Reply in Klingon.', 'Reply in English or French.', 'Reply in English/French.', 'Réponds en anglais ou français.']) {
    assert.equal(explicitChatResponseLanguage([user('Reply in French.'), user(content)]), null);
  }
});

test('missing and non-user input is ignored', () => {
  assert.equal(explicitChatResponseLanguage(null), null);
  assert.equal(explicitChatResponseLanguage([null, {}, { role: 'user', content: null }, { role: 'system', content: 'Reply in French.' }]), null);
});

// Recognize only direct, explicit language requests. Other wording remains for
// the model to interpret; the language of ordinary prose is never a preference.
const codes = ['en', 'fr', 'es', 'de', 'it', 'pt', 'nl', 'ar', 'zh', 'ja', 'ko', 'hi', 'ru', 'uk', 'pl', 'tr', 'sv'];
const names = new Intl.DisplayNames(['en'], { type: 'language' });
const frenchNames = new Intl.DisplayNames(['fr'], { type: 'language' });
const normalize = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[’‘]/g, "'");
const aliases = codes.flatMap(code => [...new Set([names.of(code), frenchNames.of(code)])]
  .map(name => ({ alias: normalize(name), code, name: names.of(code) })))
  .sort((left, right) => right.alias.length - left.alias.length);

const courtesy = "(?:(?:please|kindly|s'il te plait|s'il vous plait)[,\\s]+)?";
const question = '(?:(?:can|could|would) you |(?:peux|pourrais|pouvez|pourriez)[- ](?:tu|vous) )?';
const verbs = '(?:reply|respond|answer|continue|switch|write|reponds|repondez|repondre|continuez|continuer|ecris|ecrivez|ecrire)(?:-moi|-nous)?';
const command = new RegExp(`^${courtesy}${question}${courtesy}(?:${verbs} (?:in|to|en) |(?:speak|parle|parlez|parler)(?: (?:in|en))? )(.+)$`, 'u');

function withoutQuotedMaterial(content) {
  return content
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/^\s*>[^\n]*/gm, ' ')
    .replace(/`[^`\n]*(?:`|$)/g, ' ')
    .replace(/"[^"]*"|“[^”]*”|«[^»]*»|‘[^’]*’/g, ' ')
    .replace(/(^|[\s([{])'[^'\n]*'(?=$|[\s.,!?;:)\]}])/g, '$1 ');
}

export function explicitChatResponseLanguage(messages) {
  let preference = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== 'user' || typeof message.content !== 'string') continue;
    const text = normalize(withoutQuotedMaterial(message.content));
    const clauses = text.split(/(?<=[.!?;])\s+|\n+/u);
    for (let index = 0; index < clauses.length; index += 1) {
      // A command on the next line after an attribution remains quoted data.
      if (index > 0 && /:\s*$/.test(clauses[index - 1])) continue;
      const match = command.exec(clauses[index].trim().replace(/\s+/g, ' '));
      if (!match) continue;
      const target = match[1];
      const language = aliases.find(({ alias }) => target.startsWith(alias) &&
        (!target[alias.length] || /[\s.,!?;:/]/.test(target[alias.length])));
      const remainder = language ? target.slice(language.alias.length) : '';
      // Unknown targets and alternatives are deliberately left to the model.
      preference = !language || /^\s*(?:\/|(?:or|and|ou|et|then|puis)\b)/.test(remainder)
        ? null : { code: language.code, name: language.name };
    }
  }
  return preference;
}

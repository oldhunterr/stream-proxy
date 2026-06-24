const vm = require('vm');

function findEvalBlocks(html) {
  const blocks = [];
  const marker = 'eval(function(p,a,c,k,e,d)';
  let idx = 0;
  while ((idx = html.indexOf(marker, idx)) !== -1) {
    let depth = 0;
    const start = idx + 5;
    let inString = false;
    let stringChar = '';
    for (let i = idx; i < html.length; i++) {
      const ch = html[i];
      const prev = i > 0 ? html[i - 1] : '';
      if (inString) {
        if (ch === stringChar && prev !== '\\') inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inString = true; stringChar = ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') {
        depth--;
        if (depth === 0) {
          blocks.push(html.substring(start, i));
          idx = i + 1;
          break;
        }
      }
    }
    if (depth !== 0) break;
  }
  return blocks;
}

function findEvalBlock(html) {
  const blocks = findEvalBlocks(html);
  return blocks.length > 0 ? blocks[0] : null;
}

function manualUnpack(packedContent) {
  const argsMatch = packedContent.match(/\}\('([\s\S]*?)',\s*(\d+),\s*(\d+),\s*'([^']*)'/);
  if (!argsMatch) return null;
  let p = argsMatch[1];
  const a = parseInt(argsMatch[2]);
  let c = parseInt(argsMatch[3]);
  const k = argsMatch[4].split('|');
  while (c--) {
    if (k[c]) {
      const token = c.toString(a);
      p = p.replace(new RegExp('\\b' + token + '\\b', 'g'), k[c]);
    }
  }
  return p;
}

function parseArgs(content) {
  const args = [];
  let current = '';
  let inString = false;
  let stringChar = '';
  let bracketDepth = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (inString) {
      if (char === '\\') { current += char; if (i + 1 < content.length) { current += content[i + 1]; i++; } }
      else if (char === stringChar) { inString = false; current += char; }
      else { current += char; }
    } else {
      if (char === "'" || char === '"' || char === '`') { inString = true; stringChar = char; current += char; }
      else if (char === '[') { bracketDepth++; current += char; }
      else if (char === ']') { bracketDepth--; current += char; }
      else if (char === ',' && bracketDepth === 0) { args.push(current.trim()); current = ''; }
      else { current += char; }
    }
  }
  if (current) args.push(current.trim());
  return args;
}

function parseStringToken(token) {
  if ((token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"')) ||
      (token.startsWith('`') && token.endsWith('`'))) {
    return token.slice(1, -1).replace(/\\(.)/g, (match, g1) => {
      if (g1 === 'n') return '\n';
      if (g1 === 'r') return '\r';
      if (g1 === 't') return '\t';
      if (g1 === 'b') return '\b';
      if (g1 === 'f') return '\f';
      return g1;
    });
  }
  return token;
}

function decodeDeanEdwards(p, a, c, k, e, d) {
  if (typeof k === 'string') k = k.split('|');
  if (!d || typeof d !== 'object') d = {};
  const base = a;
  const base62Encode = (c_val) => {
    const e_func = (n) => {
      return (n < base ? '' : e_func(Math.floor(n / base))) +
             ((n % base) > 35 ? String.fromCharCode((n % base) + 29) : (n % base).toString(36));
    };
    return e_func(c_val) || '0';
  };
  for (let i = 0; i < c; i++) {
    const key = base62Encode(i);
    d[key] = k[i] || key;
  }
  return p.replace(/\b\w+\b/g, (word) => d[word] !== undefined ? d[word] : word);
}

function tryPureUnpack(packedBlock) {
  const lastCurly = packedBlock.lastIndexOf('}');
  if (lastCurly === -1) return null;
  const bodyPart = packedBlock.substring(0, lastCurly + 1).trim();
  const argsPart = packedBlock.substring(lastCurly + 1).trim();
  if (bodyPart.includes('throw')) return null;
  const simpleReturnMatch = bodyPart.match(/\{\s*return\s+(['"`][\s\S]*?['"`])\s*;?\s*\}/);
  if (simpleReturnMatch) return parseStringToken(simpleReturnMatch[1]);
  const isStandardPacker = bodyPart.includes('while') && bodyPart.includes('replace');
  if (isStandardPacker) {
    if (!argsPart.startsWith('(') || !argsPart.endsWith(')')) return null;
    const content = argsPart.slice(1, -1).trim();
    const tokens = parseArgs(content);
    if (tokens.length < 4) return null;
    const p = parseStringToken(tokens[0]);
    const a = parseInt(tokens[1], 10);
    const c = parseInt(tokens[2], 10);
    let k;
    if (tokens[3].includes('.split(')) {
      const splitMatch = tokens[3].match(/^(['"`][\s\S]*?['"`])\s*\.\s*split\s*\(\s*['"`](\|)['"`]\s*\)$/);
      if (splitMatch) k = parseStringToken(splitMatch[1]).split(splitMatch[2]);
      else return null;
    } else if (tokens[3].startsWith('[') && tokens[3].endsWith(']')) {
      const inner = tokens[3].slice(1, -1).trim();
      k = inner ? parseArgs(inner).map(item => parseStringToken(item)) : [];
    } else {
      k = parseStringToken(tokens[3]);
    }
    return decodeDeanEdwards(p, a, c, k);
  }
  return null;
}

function unpackWithFallback(block) {
  let unpacked = tryPureUnpack(block);
  if (unpacked === null) {
    try {
      unpacked = vm.runInNewContext('(' + block + ')', Object.create(null), { timeout: 1000 });
    } catch (_) {}
  }
  if (unpacked === null) {
    unpacked = manualUnpack(block);
  }
  return unpacked;
}

function findAndUnpack(html) {
  const blocks = findEvalBlocks(html);
  const results = [];
  for (const block of blocks) {
    const unpacked = unpackWithFallback(block);
    if (unpacked) results.push(unpacked);
  }
  return results;
}

function extractUrlFromPatterns(unpacked, patterns) {
  for (const pattern of patterns) {
    const match = unpacked.match(pattern);
    if (match) return match[1] || match[0];
  }
  return null;
}

module.exports = {
  findEvalBlocks,
  findEvalBlock,
  manualUnpack,
  tryPureUnpack,
  unpackWithFallback,
  findAndUnpack,
  extractUrlFromPatterns,
};

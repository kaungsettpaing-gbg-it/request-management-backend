const crypto = require('crypto');

let generatedSecret;

function getJwtSecret(env = process.env) {
  if (typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0) {
    if (Buffer.byteLength(env.JWT_SECRET, 'utf8') < 32) {
      throw new Error('JWT_SECRET must be at least 32 bytes. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"');
    }
    return env.JWT_SECRET;
  }

  if (!generatedSecret) {
    generatedSecret = crypto.randomBytes(48).toString('base64');
  }
  return generatedSecret;
}

function hasConfiguredJwtSecret(env = process.env) {
  return typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.length > 0;
}

module.exports = { getJwtSecret, hasConfiguredJwtSecret };
